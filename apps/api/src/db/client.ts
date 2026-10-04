import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Hem Db hem Tx üzerinde çalışabilen sorgu arayüzü. */
export type Queryable = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Havuzdaki en çok bağlantı. */
  max?: number;
  /** Havuzdan bağlantı bekleme üst süresi (ms; varsayılan 5000). Aşılınca hata → 503 BUSY. */
  connectTimeoutMs?: number;
  /** 0 ya da yok = kapalı. */
  statementTimeoutMs?: number;
  /** Boşta (idle) bağlantıda oluşan hata; verilmezse stderr'e yazılır. Dinleyici hiç olmazsa süreç çöker. */
  onError?: (err: Error) => void;
}

export function createDb(connectionString: string, opts: CreateDbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    // İşlem açık kalıp bekleyen bağlantılar (istemci çökmesi vb.) havuzu tüketmesin.
    idle_in_transaction_session_timeout: 120_000,
  });
  // Veritabanı yeniden başlarsa boştaki bağlantılar 'error' olayı verir; dinleyici yoksa süreç çöker.
  pool.on('error', opts.onError ?? ((err) => console.error('Veritabanı bağlantı hatası:', err.message)));
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}

/**
 * RLS bağlamı. `set_config(..., true)` işlem-yerelidir: işlem bitince kaybolur,
 * havuzdaki bağlantıya sızmaz.
 */
export interface DbContext {
  userId?: string;
  orgId?: string;
  companyId?: string;
  ip?: string;
}

export async function setContext(tx: Tx, ctx: DbContext): Promise<void> {
  await tx.execute(sql`select
    set_config('app.user_id', ${ctx.userId ?? ''}, true),
    set_config('app.org_id', ${ctx.orgId ?? ''}, true),
    set_config('app.company_id', ${ctx.companyId ?? ''}, true),
    set_config('app.ip', ${ctx.ip ?? ''}, true)`);
}

export async function withContext<T>(
  db: Db,
  ctx: DbContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setContext(tx, ctx);
    return fn(tx);
  });
}
