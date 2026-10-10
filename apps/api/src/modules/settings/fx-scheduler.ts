import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { nowLocal, type FxProvider, type Role } from '@erp/shared';
import { setContext, withContext, type Db } from '../../db/client';
import { companies, exchangeRates, memberships, users } from '../../db/schema';
import { loadMemberAccess } from '../access/effective';
import { importPublishedRates } from './fx-import';
import { companyFxProvider, FX_PROVIDER_REGISTRY } from './fx-providers';

const LOCK_NAMESPACE = 0x46584155; // "FXAU"
/** Yayın saati sağlayıcının kendi saat diliminde değerlendirilir (şirketin saat dilimi farklı olabilir). */
const PROVIDER_TIME_ZONE: Record<FxProvider, string> = { tcmb: 'Europe/Istanbul', kktcmb: 'Europe/Nicosia' };

export type FxAutoOutcome = 'disabled' | 'locked' | 'not-due' | 'up-to-date' | 'imported' | 'error';
export interface FxAutoOptions {
  fetcher: (provider: FxProvider, isoDate?: string) => Promise<string>;
  after: Record<FxProvider, string>;
  now?: Date;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

function isWeekday(isoDate: string) {
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * Tek şirket için otomatik kur çekimi (yayın saati varsayılmaz; LEGAL-NOTES §6). Kurallar:
 * - Ayar kapalıysa, sağlayıcı yoksa, hafta sonuysa ya da (isteğe bağlı) eşik saat gelmediyse hiçbir şey yazılmaz.
 * - Bugünün bülteni bu sağlayıcıdan zaten alındıysa tekrar indirilmez (idempotent).
 * - Yazım, ayarı açan kullanıcının bağlamında ve yalnız `rates.manage` izni sürüyorsa yapılır; elle girilen kurlar korunur.
 * - Hata o gün için bir kez kaydedilir (denetim izi gürültüsü olmasın); sonraki turlarda yeniden denenir.
 */
export async function autoImportCompany(
  db: Db,
  target: { companyId: string; orgId: string },
  opts: FxAutoOptions,
): Promise<FxAutoOutcome> {
  const now = opts.now ?? new Date();
  return withContext(db, { orgId: target.orgId, companyId: target.companyId }, async (tx) => {
    const got = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${target.companyId}::text)) as ok`);
    if (!got.rows[0]?.ok) return 'locked';
    const [company] = await tx
      .select({
        enabled: companies.fxAutoImport,
        enabledBy: companies.fxAutoEnabledBy,
        jurisdiction: companies.jurisdiction,
        fxProvider: companies.fxProvider,
        lastAttemptAt: companies.fxAutoLastAttemptAt,
        lastError: companies.fxAutoLastError,
      })
      .from(companies)
      .where(eq(companies.id, target.companyId));
    if (!company?.enabled) return 'disabled';

    const provider = companyFxProvider(company);
    const timeZone = PROVIDER_TIME_ZONE[provider ?? 'tcmb'];
    const local = nowLocal(now, timeZone);
    const recordError = async (message: string) => {
      // Aynı gün aynı hata tekrar yazılmaz: her turda bir denetim kaydı üretmeyelim
      const attemptedToday = !!company.lastAttemptAt && nowLocal(company.lastAttemptAt, timeZone).date === local.date;
      if (!(attemptedToday && company.lastError === message)) {
        await tx.update(companies).set({ fxAutoLastAttemptAt: now, fxAutoLastError: message }).where(eq(companies.id, target.companyId));
      }
      opts.log?.warn({ companyId: target.companyId, reason: message }, 'otomatik kur çekimi başarısız');
      return 'error' as const;
    };
    if (!provider) return recordError('Resmî kur için şirketin çalışma ülkesi (Türkiye/KKTC) seçilmemiş.');
    if (!isWeekday(local.date) || local.time < opts.after[provider]) return 'not-due';

    const [existing] = await tx
      .select({ id: exchangeRates.id })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.rateDate, local.date), eq(exchangeRates.provider, provider)))
      .limit(1);
    if (existing) return 'up-to-date';

    if (!company.enabledBy) return recordError('Otomatik çekimi açan kullanıcı bulunamadı; ayarı yeniden açın.');
    const [member] = await tx
      .select({ role: memberships.role, active: users.isActive })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, target.companyId), eq(memberships.userId, company.enabledBy)));
    const access = member?.active ? await loadMemberAccess(tx, target.companyId, company.enabledBy, member.role as Role) : null;
    if (!access?.permissions.has('rates.manage'))
      return recordError('Otomatik çekimi açan kullanıcının kur yönetme yetkisi kalmadı; yetkili bir kullanıcı ayarı yeniden açmalı.');

    try {
      const definition = FX_PROVIDER_REGISTRY[provider];
      const day = definition.parse(await opts.fetcher(provider));
      // Bülten henüz yayımlanmadıysa (resmî tatil vb.) kaynak önceki günü döndürür: bugüne yazılmaz, sonraki turda yeniden bakılır
      if (day.date !== local.date) return 'not-due';
      await setContext(tx, { userId: company.enabledBy, orgId: target.orgId, companyId: target.companyId });
      await tx.transaction(async (sp) => {
        await importPublishedRates(sp, { companyId: target.companyId, userId: company.enabledBy! }, day, {
          provider,
          sourceUrl: definition.url(day.date),
        });
      });
      await tx.update(companies).set({ fxAutoLastAttemptAt: now, fxAutoLastError: null }).where(eq(companies.id, target.companyId));
      return 'imported';
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message.slice(0, 300) : 'Kur kaynağına ulaşılamadı.';
      return recordError(`Kur bülteni alınamadı: ${message}`);
    }
  });
}

export async function runFxAutoImport(db: Db, opts: FxAutoOptions) {
  // Bir turda her sağlayıcının XML'i en çok bir kez indirilir; tüm şirketler aynı yanıtı kullanır (kaynağa yük bindirmeyiz)
  const cache = new Map<FxProvider, Promise<string>>();
  const fetcher: FxAutoOptions['fetcher'] = (provider) => {
    let hit = cache.get(provider);
    if (!hit) {
      hit = opts.fetcher(provider);
      hit.catch(() => cache.delete(provider));
      cache.set(provider, hit);
    }
    return hit;
  };
  const targets = (await db.execute<{ company_id: string; organization_id: string }>(sql`select company_id, organization_id from notification_scan_targets()`)).rows;
  const out = { companies: 0, imported: 0, errors: 0 };
  for (const t of targets) {
    try {
      const outcome = await autoImportCompany(db, { companyId: t.company_id, orgId: t.organization_id }, { ...opts, fetcher });
      out.companies++;
      if (outcome === 'imported') out.imported++;
      if (outcome === 'error') out.errors++;
    } catch (err) {
      out.errors++;
      opts.log?.warn({ err: err instanceof Error ? err.message : String(err), companyId: t.company_id }, 'otomatik kur çekimi başarısız');
    }
  }
  return out;
}

/** server.ts başlatır (testler başlatmaz). Önceki tur bitmeden yeni tur başlamaz; durdurma işlevi döner. */
export function startFxScheduler(app: FastifyInstance): () => void {
  const c = app.config;
  if (!c.FX_AUTO_ENABLED) {
    app.log.info('otomatik kur zamanlayıcısı kapalı (FX_AUTO_ENABLED=false)');
    return () => {};
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runFxAutoImport(app.db, {
        fetcher: app.fxRateFetcher,
        after: { tcmb: c.FX_AUTO_TCMB_AFTER, kktcmb: c.FX_AUTO_KKTCMB_AFTER },
        log: app.log,
      });
      if (r.imported > 0 || r.errors > 0) app.log.info(r, 'otomatik kur turu tamam');
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'otomatik kur turu başarısız');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 45_000 + Math.random() * 30_000);
  const timer = setInterval(() => void tick(), c.FX_AUTO_INTERVAL_MINUTES * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
