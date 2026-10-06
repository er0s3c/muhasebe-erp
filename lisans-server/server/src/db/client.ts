import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Queryable = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, opts: { max?: number; onError?: (err: Error) => void } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on('error', opts.onError ?? ((err) => console.error('Veritabanı bağlantı hatası:', err.message)));
  return { db: drizzle(pool, { schema, casing: 'snake_case' }), pool, close: () => pool.end() };
}
