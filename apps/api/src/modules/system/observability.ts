import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appUpdates, dbStatSnapshots } from '../../db/schema';
import type { Tx } from '../../db/client';
import { authedRoute, type AuthUser } from '../../http/context';
import { forbidden, notFound } from '../../http/errors';
import { isInstallationAdmin } from '../../licensing/installation';

const requireOwner = async (tx: Tx, user: AuthUser) => {
  if (!(await isInstallationAdmin(tx, user))) throw forbidden('Yalnız kurulum sahibi görür', 'OWNER_ONLY');
};

/**
 * F12 işletim: uçtan uca teknik iz (113), veritabanı performans eğilimleri (114) ve güncelleme öncesi uyumluluk denetimi (119).
 * İz ve istatistikler kurulum geneldir; yalnız kuruluş sahibine açılır, kiracı verisi (sorgu parametresi, gövde) tutulmaz.
 */

// --- 113: W3C traceparent ve sunucu süresi ------------------------------------------------------------------

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

export interface SlowRequest {
  at: string;
  traceId: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
}
const SLOW_MS = 1000;
const slowRing: SlowRequest[] = [];

declare module 'fastify' {
  interface FastifyRequest {
    traceId?: string;
    startedAtNs?: bigint;
  }
}

/** Gelen `traceparent` korunur (yoksa yeni iz açılır); yanıtta iz, istek kimliği ve `server-timing` döner; yavaş istek kaydedilir. */
export function registerTracing(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    req.startedAtNs = process.hrtime.bigint();
    const incoming = req.headers.traceparent;
    const m = typeof incoming === 'string' ? TRACEPARENT.exec(incoming) : null;
    req.traceId = m && !/^0+$/.test(m[1]!) ? m[1]! : hex(16);
    void reply.header('traceparent', `00-${req.traceId}-${hex(8)}-01`);
  });
  app.addHook('onSend', async (req: FastifyRequest, reply) => {
    if (req.startedAtNs === undefined) return;
    const ms = Number(process.hrtime.bigint() - req.startedAtNs) / 1e6;
    void reply.header('server-timing', `app;dur=${ms.toFixed(1)}`);
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.startedAtNs === undefined) return;
    const ms = Number(process.hrtime.bigint() - req.startedAtNs) / 1e6;
    // Yol şablonu tutulur (ör. /api/invoices/:id); sorgu dizesi ve kayıt kimlikleri kaydedilmez
    const route = req.routeOptions?.url ?? 'bilinmeyen';
    if (ms >= SLOW_MS) {
      slowRing.push({ at: new Date().toISOString(), traceId: req.traceId ?? '', requestId: String(req.id), method: req.method, route, status: reply.statusCode, durationMs: Math.round(ms) });
      if (slowRing.length > 200) slowRing.shift();
      req.log.warn({ traceId: req.traceId, route, durationMs: Math.round(ms), statusCode: reply.statusCode }, 'yavaş istek');
    }
  });
}

export const slowRequests = () => [...slowRing].reverse();

// --- 114: veritabanı istatistikleri ----------------------------------------------------------------------

async function dbStats(app: FastifyInstance) {
  const db = app.db;
  const tables = (
    await db.execute<{ table: string; seq_scan: string; idx_scan: string | null; live: string; dead: string; size: string }>(sql`
      select relname as table, seq_scan::text, idx_scan::text, n_live_tup::text as live, n_dead_tup::text as dead,
             pg_total_relation_size(relid)::text as size
        from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 30`)
  ).rows.map((r) => ({ table: r.table, seqScan: Number(r.seq_scan), idxScan: Number(r.idx_scan ?? 0), liveRows: Number(r.live), deadRows: Number(r.dead), sizeBytes: Number(r.size) }));
  const ext = (await db.execute<{ ok: boolean }>(sql`select exists(select 1 from pg_extension where extname = 'pg_stat_statements') as ok`)).rows[0]?.ok ?? false;
  let statements: { query: string; calls: number; totalMs: number; meanMs: number }[] | null = null;
  if (ext) {
    try {
      statements = (
        await db.execute<{ query: string; calls: string; total: string; mean: string }>(sql`
          select left(regexp_replace(query, '\\s+', ' ', 'g'), 200) as query, calls::text, total_exec_time::text as total, mean_exec_time::text as mean
            from pg_stat_statements order by total_exec_time desc limit 20`)
      ).rows.map((r) => ({ query: r.query, calls: Number(r.calls), totalMs: Math.round(Number(r.total)), meanMs: Math.round(Number(r.mean) * 10) / 10 }));
    } catch {
      statements = null;
    }
  }
  const size = (await db.execute<{ size: string }>(sql`select pg_database_size(current_database())::text as size`)).rows[0]?.size ?? '0';
  return { databaseBytes: Number(size), tables, statements, statementsAvailable: statements !== null };
}

/** İki anlık görüntü arasındaki fark: tablo büyümesi, sıralı tarama artışı ve ölü satır birikimi. */
function trend(prev: Awaited<ReturnType<typeof dbStats>> | undefined, cur: Awaited<ReturnType<typeof dbStats>>) {
  if (!prev) return [];
  return cur.tables
    .map((t) => {
      const p = prev.tables.find((x) => x.table === t.table);
      return { table: t.table, sizeDelta: t.sizeBytes - (p?.sizeBytes ?? 0), seqScanDelta: t.seqScan - (p?.seqScan ?? 0), deadRows: t.deadRows };
    })
    .filter((t) => t.sizeDelta !== 0 || t.seqScanDelta !== 0)
    .sort((a, b) => b.seqScanDelta - a.seqScanDelta)
    .slice(0, 20);
}

// --- 119: güncelleme öncesi denetim ----------------------------------------------------------------------

interface Check {
  key: string;
  ok: boolean;
  blocking: boolean;
  message: string;
}

export const observabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/system/slow-requests',
    authedRoute(app, async ({ tx, user }) => {
      await requireOwner(tx, user);
      return { thresholdMs: SLOW_MS, requests: slowRequests() };
    }),
  );
  app.get(
    '/api/system/db-stats',
    authedRoute(app, async ({ tx, user }) => {
      await requireOwner(tx, user);
      const current = await dbStats(app);
      const [last] = await tx.select().from(dbStatSnapshots).orderBy(desc(dbStatSnapshots.takenAt)).limit(1);
      return { current, lastSnapshotAt: last?.takenAt ?? null, trend: trend(last?.payload as Awaited<ReturnType<typeof dbStats>> | undefined, current) };
    }),
  );
  app.post(
    '/api/system/db-stats/snapshot',
    authedRoute(app, async ({ tx, user }) => {
      await requireOwner(tx, user);
      const payload = await dbStats(app);
      const [row] = await tx.insert(dbStatSnapshots).values({ takenBy: user.id, payload: payload as never }).returning({ id: dbStatSnapshots.id, takenAt: dbStatSnapshots.takenAt });
      return row;
    }),
  );
  app.get(
    '/api/system/update/:id/preflight',
    authedRoute(app, async ({ tx, user, req }) => {
      await requireOwner(tx, user);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const [row] = await tx.select().from(appUpdates).where(eq(appUpdates.id, id));
      if (!row) throw notFound('Güncelleme');
      const checks: Check[] = [];
      const active = await tx.select({ id: appUpdates.id }).from(appUpdates).where(sql`${appUpdates.status} in ('requested','downloading','applying') and ${appUpdates.id} <> ${id}`);
      checks.push({ key: 'no_active_update', ok: active.length === 0, blocking: true, message: active.length ? 'Başka bir güncelleme sürüyor' : 'Başka güncelleme yok' });
      const pg = Number((await tx.execute<{ v: string }>(sql`select current_setting('server_version_num') as v`)).rows[0]?.v ?? 0);
      checks.push({ key: 'postgres_version', ok: pg >= 150000, blocking: true, message: `PostgreSQL ${Math.floor(pg / 10000)} ${pg >= 150000 ? '(destekleniyor)' : '(en az 15 gerekir)'}` });
      const largest = Math.max(0, ...row.files.map((f) => f.size));
      try {
        const fs = await statfs(app.config.CONSTRUCTION_STORAGE_DIR ?? '.');
        const free = Number(fs.bavail) * Number(fs.bsize);
        const need = largest * 3;
        checks.push({ key: 'disk_space', ok: free >= need, blocking: true, message: `Boş alan ${(free / 1e9).toFixed(1)} GB; paket ve açılış için ${(need / 1e9).toFixed(2)} GB gerekir` });
      } catch {
        checks.push({ key: 'disk_space', ok: true, blocking: false, message: 'Boş alan ölçülemedi; kurulumdan önce elle kontrol edin' });
      }
      const running = await tx.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'active' and pid <> pg_backend_pid()`);
      const busy = Number(running.rows[0]?.n ?? 0);
      checks.push({ key: 'activity', ok: busy < 5, blocking: false, message: busy ? `${busy} etkin veritabanı oturumu var; yoğun saatte güncellemeyin` : 'Veritabanı boşta' });
      checks.push({ key: 'backup', ok: true, blocking: false, message: 'Güncelleyici uygulamadan önce veritabanı yedeği alır; şirket yedeklerini ayrıca kontrol edin' });
      return { updateId: id, version: row.version, ready: checks.every((c) => c.ok || !c.blocking), checks };
    }),
  );
};
