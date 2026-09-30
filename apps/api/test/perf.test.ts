import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { setReportRowLimit } from '../src/http/limits';
import { accountIds, asOwner, client, createCompany, day, makeApp, registerUser } from './helpers';

describe('performans ve dayanıklılık önlemleri', async () => {
  const { app } = await makeApp();

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    return { s, company, c, ids: await accountIds(app, s.token, company.id) };
  }
  const entry = (c: ReturnType<typeof client>, ids: Record<string, string>, date: string, amount: string, description: string) =>
    c.post('/api/journal-entries', {
      entryDate: date,
      description,
      post: true,
      lines: [
        { accountId: ids['632']!, currency: 'TRY', debit: amount },
        { accountId: ids['100']!, currency: 'TRY', credit: amount },
      ],
    });

  it('yevmiye listesi sayfalama sonrası toplamı doğru verir (tarih, no sırası ve offset)', async () => {
    const { c, ids } = await setup('Liste');
    for (let i = 1; i <= 5; i++) expect((await entry(c, ids, day(3, i), String(i * 100), `Gider ${i}`)).statusCode).toBe(201);
    const first = (await c.get('/api/journal-entries?limit=2&offset=0')).json().entries as { description: string; totalBase: string }[];
    const second = (await c.get('/api/journal-entries?limit=2&offset=2')).json().entries as { description: string; totalBase: string }[];
    expect(first.map((e) => e.description)).toEqual(['Gider 5', 'Gider 4']);
    expect(first.map((e) => Number(e.totalBase))).toEqual([500, 400]);
    expect(second.map((e) => e.description)).toEqual(['Gider 3', 'Gider 2']);
    expect(Number(second[0]!.totalBase)).toBe(300);
    // Satırı olmayan (boş) taslak da 0 toplamla listelenir
    const draft = await c.post('/api/journal-entries', { entryDate: day(3, 9), description: 'Boş taslak', lines: [] });
    if (draft.statusCode === 201) {
      const all = (await c.get('/api/journal-entries?limit=50')).json().entries as { description: string; totalBase: string }[];
      expect(Number(all.find((e) => e.description === 'Boş taslak')!.totalBase)).toBe(0);
    }
  });

  it('ekstre ve defter raporları satır tavanını aşınca REPORT_TOO_LARGE verir (sessizce kesmez)', async () => {
    const { c, ids } = await setup('Tavan');
    for (let i = 1; i <= 4; i++) await entry(c, ids, day(3, i), '100', `Gider ${i}`);
    const url = `/api/reports/account-ledger?accountId=${ids['100']}&from=${day(1, 1)}&to=${day(12, 31)}`;
    expect((await c.get(url)).statusCode).toBe(200);
    setReportRowLimit(3);
    try {
      const res = await c.get(url);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('REPORT_TOO_LARGE');
      expect(res.json().error.message).toMatch(/daraltın/);
    } finally {
      setReportRowLimit(20_000);
    }
    expect((await c.get(url)).statusCode).toBe(200);
  });

  it('dışa aktarmalar eşzamanlılık kapısından geçer: kapı doluysa 429 EXPORT_BUSY, boşalınca 200', async () => {
    const { c } = await setup('Kapi');
    const url = `/api/exports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&format=csv`;
    expect((await c.get(url)).statusCode).toBe(200);
    const taken: number[] = [];
    while (app.exportGate.tryAcquire()) taken.push(1);
    try {
      const busy = await c.get(url);
      expect(busy.statusCode).toBe(429);
      expect(busy.json().error.code).toBe('EXPORT_BUSY');
      expect(busy.headers['retry-after']).toBe('5');
    } finally {
      for (const _ of taken) app.exportGate.release();
    }
    expect((await c.get(url)).statusCode).toBe(200);
    // Başarısız bir dışa aktarma da kapıyı serbest bırakır (finally)
    expect((await c.get('/api/exports/trial-balance?format=csv')).statusCode).toBe(400);
    expect(app.exportGate.busy).toBe(0);
  });

  it('statement_timeout havuza uygulanır: süreyi aşan sorgu 57014 ile iptal edilir', async () => {
    const handle = createDb(process.env.DATABASE_URL!, { max: 1, statementTimeoutMs: 100 });
    try {
      await expect(handle.pool.query('select pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
      // Bağlantı iptalden sonra kullanılabilir kalır
      expect((await handle.pool.query('select 1 as ok')).rows[0].ok).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it('eksik dış anahtar dizinleri ve kısmi kaydedilmiş-fiş dizini mevcut', async () => {
    await asOwner(async (q) => {
      const names = (await q(`select indexname from pg_indexes where schemaname = 'public'`)).rows.map((r) => r.indexname);
      for (const n of [
        'journal_entries_posted_date_idx',
        'journal_entries_reversal_of_idx',
        'journal_entries_reversed_by_idx',
        'treasury_transactions_journal_idx',
        'treasury_transactions_cancel_journal_idx',
        'party_allocations_txn_idx',
        'refresh_tokens_expires_idx',
      ]) {
        expect(names, n).toContain(n);
      }
    });
  });
});
