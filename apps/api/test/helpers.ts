import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { createDb, type DbHandle } from '../src/db/client';
import type { Mailer } from '../src/modules/mail/mailer';

export const PASSWORD = 'Sifre-12345-xyz';

export interface TestApp {
  app: FastifyInstance;
  handle: DbHandle;
}

/** Test dosyası başına bir uygulama örneği; dosya bitince kapanır. */
export async function makeApp(
  opts: { rateFetcher?: (isoDate?: string) => Promise<string>; configOverrides?: Partial<Config>; mailer?: Mailer } = {},
): Promise<TestApp> {
  const config = { ...loadConfig(), ...opts.configOverrides };
  const handle = createDb(config.DATABASE_URL);
  const app = await buildApp({ db: handle.db, config, logger: false, rateFetcher: opts.rateFetcher, mailer: opts.mailer });
  await app.ready();
  afterAll(async () => {
    await app.close();
    await handle.close();
  });
  return { app, handle };
}

export interface Session {
  token: string;
  userId: string;
  email: string;
  cookie: string;
}

export async function registerUser(app: FastifyInstance, name = 'Test'): Promise<Session> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email,
      password: PASSWORD,
      fullName: `${name} Kullanıcı`,
      organizationName: `${name} Holding`,
    },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const body = res.json();
  const cookie = res.cookies.find((c) => c.name === 'refresh_token');
  return { token: body.accessToken, userId: body.user.id, email, cookie: cookie?.value ?? '' };
}

export interface Company {
  id: string;
  name: string;
}

export function client(app: FastifyInstance, token: string, companyId?: string) {
  const headers = () => ({
    authorization: `Bearer ${token}`,
    ...(companyId ? { 'x-company-id': companyId } : {}),
  });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') =>
    (url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
      app.inject({ method, url, headers: headers(), payload: payload as object | undefined });
  return {
    get: call('GET'),
    post: call('POST'),
    put: call('PUT'),
    patch: call('PATCH'),
    delete: call('DELETE'),
  };
}

export async function createCompany(
  app: FastifyInstance,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<Company> {
  const res = await client(app, token).post('/api/companies', {
    name: 'Deneme İnşaat Ltd.',
    sector: 'CONSTRUCTION',
    ...overrides,
  });
  if (res.statusCode !== 201) throw new Error(`createCompany failed: ${res.body}`);
  return res.json().company;
}

/** Hesap koduna göre id sözlüğü. */
export async function accountIds(
  app: FastifyInstance,
  token: string,
  companyId: string,
): Promise<Record<string, string>> {
  const res = await client(app, token, companyId).get('/api/accounts');
  const map: Record<string, string> = {};
  for (const a of res.json().accounts) map[a.code] = a.id;
  return map;
}

/** Bir şirkete verilen rolde üye ekler ve o üyenin oturumuyla istemci döndürür. */
export async function addMember(
  app: FastifyInstance,
  owner: ReturnType<typeof client>,
  companyId: string,
  role: string,
  name = role,
): Promise<{ client: ReturnType<typeof client>; userId: string; email: string; token: string }> {
  const email = `${name.replace(/_/g, '-')}-${randomUUID().slice(0, 8)}@example.com`;
  const add = await owner.post('/api/company/members', { email, fullName: `${name} Kişi`, role, password: PASSWORD, mustChangePassword: false });
  if (add.statusCode !== 201) throw new Error(`member failed: ${add.body}`);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const token = login.json().accessToken as string;
  return { client: client(app, token, companyId), userId: add.json().member.userId as string, email, token };
}

export const thisYear = new Date().getUTCFullYear();
export const day = (m: number, d: number, y = thisYear) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Ham SQL, `erp_app` rolüyle ve verilen RLS bağlamıyla, tek işlemde. İşlem her zaman
 * geri alınır; böylece testler DB kurallarını kalıcı veri bırakmadan sınayabilir.
 */
export async function asDb<T>(
  handle: DbHandle,
  ctx: { userId?: string; orgId?: string; companyId?: string },
  fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>,
): Promise<T> {
  const c = await handle.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.company_id', $3, true)`,
      [ctx.userId ?? '', ctx.orgId ?? '', ctx.companyId ?? ''],
    );
    return await fn((sql, params) => c.query(sql, params));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/**
 * Ham SQL, tablo SAHİBİ rolle (RLS'i ve erp_app'e verilmeyen yetkileri aşar); işlem her zaman geri alınır.
 * Tetikleyicilerin kendisini, yetki kısıtından bağımsız sınamak için kullanılır.
 */
export async function asOwner<T>(
  fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test',
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    return await fn((sql, params) => client.query(sql, params));
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

/** Hata beklenen ham sorgu: SAVEPOINT ile işlemi bozmadan hatayı döndürür. */
export async function expectDbError(
  q: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>,
  sql: string,
  params?: unknown[],
): Promise<{ code?: string; message: string }> {
  await q('SAVEPOINT s');
  try {
    await q(sql, params);
  } catch (e) {
    await q('ROLLBACK TO SAVEPOINT s');
    return e as { code?: string; message: string };
  }
  throw new Error(`Hata bekleniyordu ama sorgu başarılı oldu: ${sql}`);
}

export async function orgOf(app: FastifyInstance, token: string): Promise<string> {
  const payload = app.jwt.decode<{ org: string }>(token);
  return payload!.org;
}

/** Tablo sahibi rolle KALICI ham sorgu (asOwner geri alır); test verisini zamanlarını oynatmak için. */
export async function execAsOwner(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> {
  const c = new pg.Client({
    connectionString: process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test',
  });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}
