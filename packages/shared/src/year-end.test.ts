import { describe, expect, it } from 'vitest';
import {
  computeClosingPlan,
  defaultFiscalYearName,
  isMonthAlignedRange,
  isYearEndSource,
  monthsInRange,
  nextDayIso,
  type ResultBalanceRow,
} from './year-end';
import { closeFiscalYearSchema, createFiscalYearSchema, previewFiscalYearQuerySchema, reopenFiscalYearSchema } from './schemas/year-end';
import { trialBalanceQuerySchema } from './schemas/ledger';
import { ACCOUNT_MAPPING_KEYS, defaultMappingCodes } from './schemas/invoices';
import { roleHasDefault as hasPermission } from './permissions';

const ref = (code: string, name: string) => ({ id: `id-${code}`, code, name });
const refs = { profit: ref('590', 'Dönem Net Kârı'), loss: ref('591', 'Dönem Net Zararı'), retainedProfit: ref('570', 'Geçmiş Yıllar Kârları'), retainedLoss: ref('580', 'Geçmiş Yıllar Zararları') };

const row = (code: string, debitBase: string, creditBase: string, extra: Partial<ResultBalanceRow> = {}): ResultBalanceRow => ({
  accountId: `id-${code}`,
  code,
  name: `Hesap ${code}`,
  currencyCode: null,
  projectId: null,
  wbsId: null,
  costCodeId: null,
  debit: debitBase,
  credit: creditBase,
  debitBase,
  creditBase,
  debitReporting: null,
  creditReporting: null,
  ...extra,
});

const plan = (rows: ResultBalanceRow[]) => computeClosingPlan({ baseCurrency: 'TRY', rows, ...refs });
const sumOf = (ls: { debitBase: string; creditBase: string }[]) => ({
  d: ls.reduce((s, l) => s + Number(l.debitBase), 0),
  c: ls.reduce((s, l) => s + Number(l.creditBase), 0),
});

describe('computeClosingPlan', () => {
  it('kâr: gelir borçlanır, gider alacaklanır, fark 590 alacak; fiş dengeli; devir 590 → 570', () => {
    const p = plan([row('600', '0', '1000'), row('632', '300', '0'), row('770', '400', '0')]);
    expect(p.kind).toBe('profit');
    expect(p.net).toBe('300.0000');
    expect(p.closingLines.map((l) => [l.accountCode, l.debitBase, l.creditBase])).toEqual([
      ['600', '1000.0000', '0.0000'],
      ['632', '0.0000', '300.0000'],
      ['770', '0.0000', '400.0000'],
      ['590', '0.0000', '300.0000'],
    ]);
    expect(sumOf(p.closingLines).d).toBe(sumOf(p.closingLines).c);
    expect(p.carryLines.map((l) => [l.accountCode, l.debitBase, l.creditBase])).toEqual([['590', '300.0000', '0.0000'], ['570', '0.0000', '300.0000']]);
    expect(p.accountCount).toBe(3);
    expect(p.issues).toEqual([]);
  });

  it('zarar: 591 borç, devir 580', () => {
    const p = plan([row('600', '0', '100'), row('632', '250', '0')]);
    expect(p.kind).toBe('loss');
    expect(p.net).toBe('-150.0000');
    expect(p.closingLines.at(-1)).toMatchObject({ accountCode: '591', debitBase: '150.0000', creditBase: '0.0000' });
    expect(p.carryLines.map((l) => [l.accountCode, l.debitBase, l.creditBase])).toEqual([['591', '0.0000', '150.0000'], ['580', '150.0000', '0.0000']]);
  });

  it('sıfır sonuç: sonuç satırı ve devir yok; sıfır bakiyeli hesap atlanır; ters bakiyeli (alacaklı gider) hesap borçlanır', () => {
    const p = plan([row('600', '0', '100'), row('632', '100', '0'), row('640', '50', '50')]);
    expect(p.kind).toBe('zero');
    expect(p.closingLines.map((l) => l.accountCode)).toEqual(['600', '632']);
    expect(p.carryLines).toEqual([]);
    const q = plan([row('632', '10', '40'), row('600', '0', '30')]);
    expect(q.closingLines.find((l) => l.accountCode === '632')).toMatchObject({ debitBase: '30.0000', creditBase: '0.0000' }); // alacak bakiyeli gider
    expect(q.net).toBe('60.0000');
  });

  it('proje boyutu satırda korunur; aynı hesabın farklı projeleri ayrı satır olur ve toplam eşit kalır', () => {
    const p = plan([
      row('770', '300', '0', { projectId: 'p1', wbsId: 'w1' }),
      row('770', '200', '0', { projectId: 'p2' }),
      row('770', '50', '0'),
    ]);
    expect(p.closingLines).toHaveLength(4);
    const l770 = p.closingLines.filter((l) => l.accountCode === '770');
    expect(l770.map((l) => [l.projectId, l.wbsId, l.creditBase])).toEqual([
      [null, null, '50.0000'],
      ['p1', 'w1', '300.0000'],
      ['p2', null, '200.0000'],
    ]);
    expect(p.closingLines.at(-1)).toMatchObject({ accountCode: '591', debitBase: '550.0000' });
    expect(p.closingLines.at(-1)!.projectId).toBeNull();
  });

  it('dövizli hesap kendi para biriminde kapanır, defter tutarı toplamla; döviz kalıntısı ve ters yön sorun olarak bildirilir', () => {
    const eur = row('646.001', '0', '4000', { currencyCode: 'EUR', debit: '0', credit: '100' });
    const p = plan([eur]);
    expect(p.closingLines[0]).toMatchObject({ currencyCode: 'EUR', debit: '100.0000', debitBase: '4000.0000', fxRate: '40.00000000' });
    expect(p.issues).toEqual([]);
    expect(p.net).toBe('4000.0000');

    // 10 EUR alacak @40 (400) ve 10 EUR borç @41 (410): döviz net 0, defter net -10
    const resid = plan([row('646.002', '410', '400', { currencyCode: 'EUR', debit: '10', credit: '10' })]);
    expect(resid.issues).toHaveLength(1);
    expect(resid.issues[0]).toMatchObject({ code: 'FX_RESIDUAL', accountCode: '646.002' });
    expect(resid.closingLines).toEqual([]);
    // Ters yön: döviz borç bakiyesi, defter alacak bakiyesi
    const sign = plan([row('646.003', '0', '50', { currencyCode: 'EUR', debit: '5', credit: '0' })]);
    expect(sign.issues[0]!.code).toBe('FX_SIGN_MISMATCH');
    // Defter para birimindeki "dövizli" hesap sıradan hesaptır
    const tryAcc = plan([row('600.001', '0', '10', { currencyCode: 'TRY' })]);
    expect(tryAcc.closingLines[0]).toMatchObject({ currencyCode: 'TRY', fxRate: '1.00000000' });
  });

  it('raporlama tutarı: tam ise fişi dengeler (fark sonuç satırında); eksik satır varsa tümü boş bırakılır', () => {
    const p = plan([
      row('600', '0', '1000', { debitReporting: '0', creditReporting: '24.50' }),
      row('632', '300', '0', { debitReporting: '7.36', creditReporting: '0' }),
    ]);
    expect(p.reportingComplete).toBe(true);
    const d = p.closingLines.reduce((s, l) => s + Number(l.debitReporting), 0);
    const c = p.closingLines.reduce((s, l) => s + Number(l.creditReporting), 0);
    expect(d).toBeCloseTo(c, 4);
    expect(p.closingLines.at(-1)!.creditReporting).toBe('17.1400');
    const missing = plan([row('600', '0', '1000', { debitReporting: '0', creditReporting: '24.50' }), row('632', '300', '0')]);
    expect(missing.reportingComplete).toBe(false);
    expect(missing.closingLines.every((l) => l.debitReporting === null && l.creditReporting === null)).toBe(true);
  });

  it('kuruş sınırı: ondalıklı bakiyeler dengeli kapanır', () => {
    const p = plan([row('600', '0', '333.3333'), row('632', '0.0001', '0'), row('620', '111.1111', '0')]);
    const s = sumOf(p.closingLines);
    expect(s.d).toBeCloseTo(s.c, 6);
    expect(p.net).toBe('222.2221');
  });
});

describe('mali yıl tarihleri', () => {
  it('tam aylara oturma, ay listesi, ertesi gün, varsayılan ad', () => {
    expect(isMonthAlignedRange('2026-01-01', '2026-12-31')).toBe(true);
    expect(isMonthAlignedRange('2026-07-01', '2027-06-30')).toBe(true);
    expect(isMonthAlignedRange('2026-01-15', '2026-12-31')).toBe(false);
    expect(isMonthAlignedRange('2026-01-01', '2026-12-30')).toBe(false);
    expect(isMonthAlignedRange('2028-02-01', '2028-02-29')).toBe(true); // artık yıl
    expect(isMonthAlignedRange('2026-06-01', '2026-05-31')).toBe(false);
    const m = monthsInRange('2026-07-01', '2027-06-30');
    expect(m).toHaveLength(12);
    expect(m[0]).toEqual({ year: 2026, month: 7, start: '2026-07-01', end: '2026-07-31' });
    expect(m[11]).toEqual({ year: 2027, month: 6, start: '2027-06-01', end: '2027-06-30' });
    expect(nextDayIso('2026-12-31')).toBe('2027-01-01');
    expect(nextDayIso('2028-02-28')).toBe('2028-02-29');
    expect(defaultFiscalYearName('2026-01-01', '2026-12-31')).toBe('2026');
    expect(defaultFiscalYearName('2026-07-01', '2027-06-30')).toBe('2026/2027');
    expect(defaultFiscalYearName('2026-03-01', '2026-08-31')).toBe('2026-03-01 – 2026-08-31');
  });

  it('kaynak türü tanıma', () => {
    expect(isYearEndSource('year_end_close')).toBe(true);
    expect(isYearEndSource('year_end_carry')).toBe(true);
    expect(isYearEndSource('invoice')).toBe(false);
    expect(isYearEndSource(null)).toBe(false);
  });
});

describe('şemalar, izin ve eşleme', () => {
  it('mali yıl oluşturma 12 ayı aşamaz ve tam aylara oturmalıdır', () => {
    expect(createFiscalYearSchema.safeParse({ startDate: '2026-01-01', endDate: '2026-12-31' }).success).toBe(true);
    expect(createFiscalYearSchema.safeParse({ startDate: '2026-01-01', endDate: '2027-01-31' }).success).toBe(false);
    expect(createFiscalYearSchema.safeParse({ startDate: '2026-01-02', endDate: '2026-12-31' }).success).toBe(false);
  });
  it('kapanış onayı ve yeniden açma gerekçesi', () => {
    expect(closeFiscalYearSchema.parse({ confirm: '2026' })).toEqual({ confirm: '2026', carryForward: true, includeCostAccounts: true });
    expect(reopenFiscalYearSchema.safeParse({ reason: 'abc' }).success).toBe(false);
    expect(reopenFiscalYearSchema.safeParse({ reason: 'Düzeltme gerekli' }).success).toBe(true);
    expect(previewFiscalYearQuerySchema.parse({})).toEqual({ carryForward: true, includeCostAccounts: true });
    expect(previewFiscalYearQuerySchema.parse({ carryForward: 'false', includeCostAccounts: '0' })).toEqual({ carryForward: false, includeCostAccounts: false });
  });
  it('mizan sorgusu kapanış hariç tutma bayrağı: "false" yanlış sayılır', () => {
    const base = { from: '2026-01-01', to: '2026-12-31' };
    expect(trialBalanceQuerySchema.parse(base).excludeClosing).toBe(false);
    expect(trialBalanceQuerySchema.parse({ ...base, excludeClosing: 'true' }).excludeClosing).toBe(true);
    expect(trialBalanceQuerySchema.parse({ ...base, excludeClosing: 'false' }).excludeClosing).toBe(false);
  });
  it('ledger.yearend yalnızca sahip ve yönetici; yıl sonu eşleme anahtarları ve varsayılanlar', () => {
    expect(hasPermission('owner', 'ledger.yearend')).toBe(true);
    expect(hasPermission('admin', 'ledger.yearend')).toBe(true);
    for (const r of ['accountant', 'sales', 'site_manager', 'viewer'] as const) expect(hasPermission(r, 'ledger.yearend')).toBe(false);
    expect(hasPermission('accountant', 'ledger.read')).toBe(true);
    expect(ACCOUNT_MAPPING_KEYS).toHaveLength(46);
    const d = defaultMappingCodes('CONSTRUCTION');
    expect([d.year_end_profit, d.year_end_loss, d.year_end_retained_profit, d.year_end_retained_loss]).toEqual(['590', '591', '570', '580']);
  });
});
