import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dec, FX_PURPOSE_RATE_TYPES } from '@erp/shared';
import type { Tx } from '../src/db/client';
import { parseTcmbXml, tcmbUrl, fetchTcmbXml } from '../src/modules/settings/tcmb';
import { companyFxProvider, requireCompanyFxProvider } from '../src/modules/settings/fx-providers';
import { findRate, lookupRate } from '../src/modules/settings/rates';

// Downloaded unchanged from https://www.tcmb.gov.tr/kurlar/202609/29092026.xml.
const fixture = readFileSync(new URL('./fixtures/tcmb-2026-09-29.xml', import.meta.url), 'utf8');
afterEach(() => vi.unstubAllGlobals());
describe('TCMB XML ve sağlayıcı seçimi', () => {
  it('resmî bülten, dört kur ve Unit=100 değerlerini tek birime normalleştirir', () => {
    const day = parseTcmbXml(fixture);
    expect(day.date).toBe('2026-09-29');
    expect(day.announcementNo).toBe('2026/183');
    expect(day.rates.find((r) => r.symbol === 'GBP')).toMatchObject({
      unit: 1,
      buy: '64.63290000',
      sell: '64.96990000',
      effectiveBuy: '64.58760000',
      effectiveSell: '65.06730000',
    });
    expect(day.rates.find((r) => r.symbol === 'JPY')).toMatchObject({
      unit: 100,
      buy: '0.31004000',
      sell: '0.31209300',
      effectiveBuy: '0.30889300',
      effectiveSell: '0.31327900',
    });
  });
  it('yayımlanmayan efektif kurları sıfır veya döviz kuruyla tamamlamaz', () => {
    expect(parseTcmbXml(fixture).rates.find((r) => r.symbol === 'RON')).toMatchObject({
      effectiveBuy: null,
      effectiveSell: null,
    });
    expect(parseTcmbXml(fixture).rates.find((r) => r.symbol === 'XDR')).toMatchObject({
      sell: null,
      effectiveBuy: null,
    });
  });
  it.each([
    fixture.replace('29.09.2026', '31.02.2026'),
    fixture.replace('<Unit>100</Unit>', '<Unit>0</Unit>'),
    fixture.replace('<ForexBuying>48.9131</ForexBuying>', '<ForexBuying>0</ForexBuying>'),
    fixture.replace('</Tarih_Date>', ''),
    fixture.replace('Kod="AUD" CurrencyCode="AUD"', 'Kod="USD" CurrencyCode="USD"'),
    '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + fixture,
    '<html>Kaynak çalışmıyor</html>',
  ])('hatalı tarih/birim/kur/tekrar/XML ve dış varlığı reddeder', (xml) =>
    expect(() => parseTcmbXml(xml)).toThrow(),
  );
  it('günlük ve tarihli URL yalnızca sabit TCMB alan adını kullanır', () => {
    expect(tcmbUrl()).toBe('https://www.tcmb.gov.tr/kurlar/today.xml');
    expect(tcmbUrl('2026-09-29')).toBe('https://www.tcmb.gov.tr/kurlar/202609/29092026.xml');
    expect(() => tcmbUrl('https://elsewhere.test')).toThrow();
  });
  it('ülkesiz şirket için kaynak seçmez ve ülke/sağlayıcı uyuşmazlığını reddeder', () => {
    expect(companyFxProvider({ jurisdiction: 'TR' })).toBe('tcmb');
    expect(companyFxProvider({ jurisdiction: 'KKTC' })).toBe('kktcmb');
    expect(companyFxProvider({ jurisdiction: null })).toBeNull();
    expect(() => requireCompanyFxProvider({ jurisdiction: null })).toThrow();
    expect(() => requireCompanyFxProvider({ jurisdiction: 'KKTC', fxProvider: 'tcmb' })).toThrow();
  });
  it('bağlantı ve HTTP hatasında 502 verir, başka sağlayıcıya geçmez', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('TLS'))
      .mockResolvedValueOnce({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchTcmbXml()).rejects.toMatchObject({
      status: 502,
      code: 'RATE_SOURCE_UNAVAILABLE',
    });
    await expect(fetchTcmbXml('2026-09-27')).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every((args) => String(args[0]).startsWith('https://www.tcmb.gov.tr/')),
    ).toBe(true);
  });
});
function txRows(...rows: unknown[][]): Tx {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows.shift() ?? [],
  };
  return { select: () => chain } as unknown as Tx;
}
const row = {
  id: 'rate',
  companyId: 'company',
  rateDate: '2026-09-29',
  currencyCode: 'USD',
  quoteCode: 'TRY',
  buy: '40',
  sell: '50',
  effectiveBuy: '39',
  effectiveSell: '51',
  source: 'TCMB 2026/183',
  provider: 'tcmb',
  sourceUrl: tcmbUrl('2026-09-29'),
  fetchedAt: null,
  createdAt: new Date(),
  createdBy: null,
};
describe('Amaç, kur türü ve çapraz kur metadata', () => {
  it('her amaç kendi kur türünü seçer', async () => {
    const expected = {
      valuation: '40.00000000',
      collection: '40.00000000',
      payment: '50.00000000',
      cash_collection: '39.00000000',
      cash_payment: '51.00000000',
    };
    for (const purpose of Object.keys(expected) as (keyof typeof expected)[]) {
      const result = await lookupRate(txRows([row]), 'USD', 'TRY', '2026-09-30', 'TRY', {
        purpose,
      });
      expect(result).toMatchObject({
        rate: expected[purpose],
        rateType: FX_PURPOSE_RATE_TYPES[purpose],
        rateDate: '2026-09-29',
        provider: 'tcmb',
        method: 'direct',
      });
    }
  });
  it('ters alış için satış tarafını kullanır ve bacağını açıklar', async () => {
    const result = await lookupRate(txRows([], [row]), 'TRY', 'USD', '2026-09-30', 'TRY', {
      rateType: 'forex_buy',
    });
    expect(result.rate).toBe('0.02000000');
    expect(result.legs[0]).toMatchObject({ inverted: true, rateType: 'forex_sell', value: '50' });
  });
  it('GBP defter para biriminde de ortak TRY üzerinden çapraz kur bulur', async () => {
    const gbp = { ...row, currencyCode: 'GBP', buy: '70', sell: '80', rateDate: '2026-09-28' };
    const result = await lookupRate(
      txRows([], [], [row], [], [gbp]),
      'USD',
      'GBP',
      '2026-09-30',
      'GBP',
      { rateType: 'forex_buy' },
    );
    expect(result).toMatchObject({ rate: '0.50000000', method: 'cross', rateDate: '2026-09-28' });
    expect(result.legs).toHaveLength(2);
  });
  it('eksik efektif türünü döviz alışla ikame etmez', async () => {
    expect(
      await lookupRate(
        txRows([{ ...row, effectiveBuy: null }], []),
        'USD',
        'TRY',
        '2026-09-29',
        'TRY',
        { purpose: 'cash_collection' },
      ),
    ).toMatchObject({ rate: null, method: 'missing', legs: [] });
  });
  it('eski findRate ters alış davranışını ve tam Decimal hassasiyetini korur', async () => {
    const value = await findRate(
      txRows([], [{ ...row, buy: '3' }]),
      'TRY',
      'USD',
      '2026-09-29',
      'TRY',
    );
    expect(value?.toString()).toBe(dec(1).div(3).toString());
    expect(value?.toString().length).toBeGreaterThan(12);
  });
});
