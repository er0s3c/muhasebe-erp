import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../src/http/errors';
import { client, createCompany, makeApp, registerUser } from './helpers';

const trXml = readFileSync(new URL('./fixtures/tcmb-2026-09-29.xml', import.meta.url), 'utf8');
const kktcXml = readFileSync(new URL('./fixtures/kktcmb-gunluk.xml', import.meta.url), 'utf8');
let app: FastifyInstance;
const fetcher = vi.fn(async (provider: 'tcmb' | 'kktcmb') =>
  provider === 'tcmb' ? trXml : kktcXml,
);
beforeAll(async () => {
  app = (await makeApp()).app;
  app.fxRateFetcher = fetcher;
});
async function setup(jurisdiction: 'TR' | 'KKTC' = 'TR', baseCurrency = 'TRY') {
  const user = await registerUser(app, 'FxCountry'),
    company = await createCompany(app, user.token, { jurisdiction, baseCurrency });
  return { c: client(app, user.token, company.id), company };
}
describe('Şirket ülkesinden resmî dört kur', () => {
  it('TCMB ve KKTC kaynağını şirket bazında seçer, kaynak/tarih ve dört kuru saklar', async () => {
    const tr = await setup(),
      kktc = await setup('KKTC');
    fetcher.mockClear();
    const imported = await tr.c.post('/api/exchange-rates/import', { source: 'company' });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({ provider: 'tcmb', date: '2026-09-29' });
    expect(fetcher).toHaveBeenLastCalledWith('tcmb', undefined);
    const list = (await tr.c.get('/api/exchange-rates')).json();
    expect(list).toMatchObject({ provider: 'tcmb', timeZone: 'Europe/Istanbul' });
    expect(
      list.rates.find((r: { currencyCode: string }) => r.currencyCode === 'GBP'),
    ).toMatchObject({
      buy: '64.63290000',
      sell: '64.96990000',
      effectiveBuy: '64.58760000',
      effectiveSell: '65.06730000',
      provider: 'tcmb',
      sourceUrl: 'https://www.tcmb.gov.tr/kurlar/202609/29092026.xml',
    });
    expect(list.rates[0].fetchedAt).toBeTruthy();
    expect((await kktc.c.get('/api/exchange-rates')).json().rates).toHaveLength(0);
    expect(
      (await kktc.c.post('/api/exchange-rates/import', { source: 'company' })).statusCode,
    ).toBe(200);
    expect(fetcher).toHaveBeenLastCalledWith('kktcmb', undefined);
  });
  it('ülke uyuşmazlığını indirmeden reddeder ve KKTC hatasında TCMB’ye geçmez', async () => {
    const { c } = await setup('KKTC');
    fetcher.mockClear();
    const mismatch = await c.post('/api/exchange-rates/import', { source: 'tcmb' });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('FX_PROVIDER_MISMATCH');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRejectedValueOnce(
      new AppError(502, 'RATE_SOURCE_UNAVAILABLE', 'KKTC kaynağı erişilemiyor'),
    );
    const failure = await c.post('/api/exchange-rates/import', { source: 'company' });
    expect(failure.statusCode).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenLastCalledWith('kktcmb', undefined);
    expect((await c.get('/api/exchange-rates')).json().rates).toHaveLength(0);
  });
  it('manuel değer ve XML yüklemesini otomatik indirmeden korur', async () => {
    const { c } = await setup();
    const manual = await c.put('/api/exchange-rates', {
      rateDate: '2026-09-29',
      currencyCode: 'GBP',
      quoteCode: 'TRY',
      buy: '99',
      sell: '100',
      effectiveBuy: '98',
      effectiveSell: '101',
      source: 'TCMB 2026/183',
    });
    expect(manual.statusCode).toBe(200);
    const imported = await c.post('/api/exchange-rates/import', { source: 'company' });
    expect(imported.json().skipped).toContain('GBP (elle girilen kur korundu)');
    expect(
      (await c.get('/api/exchange-rates'))
        .json()
        .rates.find((r: { currencyCode: string }) => r.currencyCode === 'GBP'),
    ).toMatchObject({ buy: '99.00000000', provider: 'manual', sourceUrl: null });
    const other = await setup();
    expect(
      (await other.c.post('/api/exchange-rates/import', { source: 'xml', xml: trXml })).statusCode,
    ).toBe(200);
    const rerun = await other.c.post('/api/exchange-rates/import', { source: 'company' });
    expect(rerun.json().imported).toHaveLength(0);
    expect(rerun.json().skipped.filter((s: string) => s.includes('korundu'))).toHaveLength(3);
  });
  it('amaç/tür/gerçek tarih metadata ve GBP defter para biriminde çapraz kur döndürür', async () => {
    const { c } = await setup('TR', 'GBP');
    await c.post('/api/exchange-rates/import', { source: 'company' });
    const cash = (
      await c.get('/api/exchange-rates/lookup?from=GBP&to=TRY&date=2026-09-30&purpose=cash_payment')
    ).json();
    expect(cash).toMatchObject({
      rate: '65.06730000',
      rateType: 'effective_sell',
      rateDate: '2026-09-29',
      provider: 'tcmb',
      method: 'direct',
    });
    const cross = (
      await c.get('/api/exchange-rates/lookup?from=USD&to=GBP&date=2026-09-30&rateType=forex_buy')
    ).json();
    expect(cross.rate).toBeTruthy();
    expect(cross.method).toBe('cross');
    expect(cross.legs).toHaveLength(2);
    expect(
      (
        await c.get('/api/exchange-rates/lookup?from=GBP&to=TRY&date=2026-10-15&rateType=forex_buy')
      ).json(),
    ).toMatchObject({ rate: null, method: 'missing' });
    expect(
      (
        await c.get('/api/exchange-rates/lookup?from=GBP&to=TRY&date=2026-09-28&rateType=forex_buy')
      ).json().rate,
    ).toBeNull();
    expect(
      (await c.get('/api/exchange-rates/lookup?from=GBP&to=TRY&rateType=bad')).statusCode,
    ).toBe(400);
  });
  it('uyuşmayan yayın tarihi ve eksik efektif kur sessiz ikame yapmaz', async () => {
    const { c } = await setup();
    const mismatch = await c.post('/api/exchange-rates/import', {
      source: 'tcmb',
      date: '2026-09-28',
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe('FX_RATE_DATE_MISMATCH');
    await c.put('/api/exchange-rates', {
      rateDate: '2026-09-29',
      currencyCode: 'USD',
      quoteCode: 'TRY',
      buy: '40',
      sell: '41',
    });
    const cash = await c.get(
      '/api/exchange-rates/lookup?from=USD&to=TRY&date=2026-09-29&rateType=effective_buy',
    );
    expect(cash.json().rate).toBeNull();
  });
  it('kesinleşmiş fatura kurunu ve taraf kimliğini dondurur; iade özgün kuru kullanır', async () => {
    const { c } = await setup();
    await c.post('/api/exchange-rates/import', { source: 'company' });
    const party = (await c.post('/api/parties', { code: 'FX-CUSTOMER', name: 'Özgün müşteri', kind: 'customer', taxNumber: '1234567890' })).json().party;
    const input = { type: 'sales', partyId: party.id, invoiceDate: '2026-09-30', currency: 'GBP',
      fxRate: '70', fxRateType: 'forex_sell', post: true,
      lines: [{ description: 'Kur test hizmeti', quantity: '1', unitPrice: '100', vatCode: 'KDV-20' }] };
    const noReason = await c.post('/api/invoices', input);
    expect(noReason.statusCode).toBe(400);
    const posted = await c.post('/api/invoices', { ...input, fxReason: 'Müşteri sözleşmesindeki işlem kuru' });
    expect(posted.statusCode, posted.body).toBe(201);
    const original = posted.json();
    expect(original.invoice.fxSnapshot).toMatchObject({ method: 'manual', rate: '70.00000000', rateType: 'forex_sell', manualReason: 'Müşteri sözleşmesindeki işlem kuru' });
    await c.patch(`/api/parties/${party.id}`, { name: 'Değişen müşteri', taxNumber: '9876543210' });
    const frozen = (await c.get(`/api/invoices/${original.invoice.id}`)).json();
    expect(frozen.invoice.partyName).toBe('Özgün müşteri');
    expect(frozen.invoice.documentMetadata.party.taxNumber).toBe('1234567890');
    const returned = await c.post('/api/invoices', { type: 'sales_return', partyId: party.id,
      invoiceDate: '2026-10-02', currency: 'GBP', returnOfId: original.invoice.id,
      fxRate: '99', fxRateType: 'forex_buy', fxReason: 'İade gününde farklı işlem kuru', post: true,
      lines: [{ description: 'İade', quantity: '1', unitPrice: '100', sourceLineId: original.lines[0].id }] });
    expect(returned.statusCode, returned.body).toBe(201);
    expect(returned.json().invoice).toMatchObject({ fxRate: '70.00000000', grossTotalBase: original.invoice.grossTotalBase,
      fxSnapshot: { method: 'manual', rate: '70.00000000', originalInvoiceId: original.invoice.id } });
    expect((await c.get(`/api/parties/${party.id}`)).json().summary.balance).toBe('0.0000');
  });
});
