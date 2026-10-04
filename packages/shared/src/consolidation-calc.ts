import { dec, roundMoney, sum, toDbAmount, type MoneyValue } from './money';

/**
 * Çoklu şirket konsolidasyonu, döviz pozisyonu ve yönetici özeti için SAF hesaplar (Faz X7).
 *
 * Bu dosyadaki hiçbir yöntem muhasebe standardı iddiası taşımaz (LEGAL-NOTES §22): hesap kodu eşleme, kur seçimi, çevrim farkı,
 * eliminasyon ve rapor sınıflaması KULLANICI VERİSİ ve varsayılandır; hepsi "doğrulanmadı". Kodda yasal değer yoktur.
 */

// ---------------------------------------------------------------------------
// Kur listesi ("TRY:0.0245,EUR:1.08") ve hesap kodu eşleme
// ---------------------------------------------------------------------------

/** "TRY:0.0245,EUR:1.08" -> Map. Geçersiz giriş (bozuk çift, ≤ 0 kur, tekrar) hata fırlatır. */
export function parseRateList(input: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const text = (input ?? '').trim();
  if (!text) return out;
  for (const part of text.split(',')) {
    const m = /^\s*([A-Z]{3})\s*:\s*(\d{1,11}(?:\.\d{1,8})?)\s*$/.exec(part);
    if (!m) throw new Error(`Geçersiz kur listesi: "${part.trim()}"`);
    const [, code, rate] = m;
    if (dec(rate!).lte(0)) throw new Error(`Kur sıfırdan büyük olmalı: ${code}`);
    if (out.has(code!)) throw new Error(`Kur tekrarlandı: ${code}`);
    out.set(code!, rate!);
  }
  return out;
}

export const MAP_LEVELS = ['full', '3', '2', '1'] as const;
export type MapLevel = (typeof MAP_LEVELS)[number];

/**
 * Şirketler arası eşleme anahtarı: hesap KODUNA göredir. `full`: kodun kendisi; '3'/'2'/'1': noktadan önceki kısmın ilk N hanesi
 * ("120.001" → "120"). Kısa kod olduğu gibi kalır.
 */
export function mapCode(code: string, level: MapLevel): string {
  if (level === 'full') return code;
  const head = code.split('.')[0]!;
  return head.slice(0, Number(level));
}

/** Bilanço hesabı (sınıf 1–5) mı, sonuç/maliyet hesabı (6–9) mı. Tekdüzen sınıflama varsayılandır, doğrulanmadı. */
export const isBalanceSheetCode = (code: string) => /^[1-5]/.test(code);

// ---------------------------------------------------------------------------
// Konsolide mizan
// ---------------------------------------------------------------------------

/** Şirket mizanından yaprak (hareket görebilen) hesap satırı; tutarlar şirketin defter para biriminde. */
export interface CompanyBalanceRow {
  code: string;
  name: string;
  /** Dönem başı net bakiye (borç − alacak). */
  opening: string;
  debit: string;
  credit: string;
}

export interface ConsolidationCompanyInput {
  companyId: string;
  name: string;
  baseCurrency: string;
  /** Şirketin defter para biriminden grup para birimine kur: bilanço (kapanış) ve gelir tablosu (dönem). */
  rates: { closing: string; pl: string };
  rows: readonly CompanyBalanceRow[];
  /** Şirketin hesap planındaki tüm hesaplar (hareketsiz olanlar dahil): eşleşmeyen kodu bulmak ve eşleme anahtarına ad vermek için. */
  chart: readonly { code: string; name: string }[];
}

export interface EliminationInput {
  id: string;
  description: string;
  kind: string;
  lines: readonly { accountCode: string; debit: string; credit: string }[];
}

export interface ConsolidatedRow {
  code: string;
  name: string;
  /** Şirket kimliği -> grup para biriminde net bakiye (borç − alacak). */
  perCompany: Record<string, string>;
  elimination: string;
  consolidated: string;
  /**
   * Sonuç hesapları (6–9) için net bakiyenin DÖNEM ÖNCESİ kısmı (dönem başı × kapanış kuru); bilanço hesaplarında 0.
   * Gelir tablosu yalnızca dönem hareketini (net − prior) gösterir (ACC-6).
   */
  perCompanyPrior: Record<string, string>;
  consolidatedPrior: string;
  /** Kod, üye şirketlerin bir kısmının hesap planında yok. */
  unmapped: boolean;
  /** Kodun hesap planında bulunduğu şirketler. */
  presentIn: string[];
}

export interface ConsolidationResult {
  rows: ConsolidatedRow[];
  /** Şirket başına çevrim farkı (kapanış/dönem kuru ayrımından doğan toplam sapma; mizanı dengeler). */
  translationDiff: Record<string, string>;
  /** Çevrim farkı öncesi şirket başına satır toplamı (defter dengeliyse ve tek kur kullanılırsa 0). */
  rawSum: Record<string, string>;
  totals: { perCompany: Record<string, string>; elimination: string; consolidated: string; translationDiff: string };
}

/** Bir şirket satırının grup para birimindeki net bakiyesi: bilanço = kapanış × kapanış kuru; sonuç hesabı = dönem başı × kapanış + hareket × dönem kuru. */
export function convertRowNet(row: CompanyBalanceRow, rates: { closing: string; pl: string }): MoneyValue {
  return convertRowParts(row, rates).net;
}

/** Net bakiye ve sonuç hesaplarında dönem öncesi kısmı (`prior`): net = prior + dönem hareketi × dönem kuru. */
export function convertRowParts(row: CompanyBalanceRow, rates: { closing: string; pl: string }): { net: MoneyValue; prior: MoneyValue } {
  const movement = dec(row.debit).minus(row.credit);
  if (isBalanceSheetCode(row.code)) return { net: roundMoney(dec(row.opening).plus(movement).times(rates.closing)), prior: dec(0) };
  const prior = roundMoney(dec(row.opening).times(rates.closing));
  return { net: prior.plus(roundMoney(movement.times(rates.pl))), prior };
}

export function aggregateConsolidation(
  companies: readonly ConsolidationCompanyInput[],
  eliminations: readonly EliminationInput[],
  level: MapLevel,
): ConsolidationResult {
  const chart = new Map<string, Set<string>>();
  const keyNames = new Map<string, string>();
  for (const c of companies) {
    chart.set(c.companyId, new Set(c.chart.map((x) => mapCode(x.code, level))));
    // Anahtarın adı: kodun kendisiyle birebir eşleşen hesabın adı (ör. "120" -> "Alıcılar")
    for (const a of c.chart) if (a.code === mapCode(a.code, level) && !keyNames.has(a.code)) keyNames.set(a.code, a.name);
  }

  type Acc = { name: string; per: Map<string, MoneyValue>; prior: Map<string, MoneyValue>; elim: MoneyValue };
  const acc = new Map<string, Acc>();
  const get = (key: string, name: string): Acc => {
    let a = acc.get(key);
    if (!a) {
      a = { name, per: new Map(), prior: new Map(), elim: dec(0) };
      acc.set(key, a);
    }
    if (!a.name && name) a.name = name;
    return a;
  };

  const rawSum = new Map<string, MoneyValue>(companies.map((c) => [c.companyId, dec(0)]));
  for (const c of companies) {
    for (const r of c.rows) {
      const key = mapCode(r.code, level);
      const { net, prior } = convertRowParts(r, c.rates);
      const a = get(key, keyNames.get(key) ?? (key === r.code ? r.name : ''));
      a.per.set(c.companyId, (a.per.get(c.companyId) ?? dec(0)).plus(net));
      a.prior.set(c.companyId, (a.prior.get(c.companyId) ?? dec(0)).plus(prior));
      rawSum.set(c.companyId, rawSum.get(c.companyId)!.plus(net));
    }
  }
  for (const e of eliminations) {
    for (const l of e.lines) {
      const k = mapCode(l.accountCode, level);
      const a = get(k, keyNames.get(k) ?? '');
      a.elim = a.elim.plus(dec(l.debit).minus(l.credit));
    }
  }

  const rows: ConsolidatedRow[] = [];
  for (const [code, a] of [...acc].sort((x, y) => x[0].localeCompare(y[0]))) {
    const present = companies.filter((c) => chart.get(c.companyId)!.has(code)).map((c) => c.companyId);
    const perCompany: Record<string, string> = {};
    const perCompanyPrior: Record<string, string> = {};
    let total = a.elim;
    let totalPrior = dec(0);
    for (const c of companies) {
      const v = a.per.get(c.companyId) ?? dec(0);
      const pv = a.prior.get(c.companyId) ?? dec(0);
      perCompany[c.companyId] = toDbAmount(v);
      perCompanyPrior[c.companyId] = toDbAmount(pv);
      total = total.plus(v);
      totalPrior = totalPrior.plus(pv);
    }
    rows.push({
      code,
      name: a.name || code,
      perCompany,
      elimination: toDbAmount(a.elim),
      consolidated: toDbAmount(total),
      perCompanyPrior,
      consolidatedPrior: toDbAmount(totalPrior),
      unmapped: present.length < companies.length,
      presentIn: present,
    });
  }

  const translationDiff: Record<string, string> = {};
  const raw: Record<string, string> = {};
  const totalPer: Record<string, string> = {};
  let tdTotal = dec(0);
  let elimTotal = dec(0);
  let consTotal = dec(0);
  for (const c of companies) {
    const r = rawSum.get(c.companyId)!;
    raw[c.companyId] = toDbAmount(r);
    translationDiff[c.companyId] = toDbAmount(r.neg());
    totalPer[c.companyId] = toDbAmount(sum(rows.map((x) => x.perCompany[c.companyId]!)));
    tdTotal = tdTotal.plus(r.neg());
  }
  for (const r of rows) {
    elimTotal = elimTotal.plus(r.elimination);
    consTotal = consTotal.plus(r.consolidated);
  }
  return {
    rows,
    translationDiff,
    rawSum: raw,
    totals: { perCompany: totalPer, elimination: toDbAmount(elimTotal), consolidated: toDbAmount(consTotal.plus(tdTotal)), translationDiff: toDbAmount(tdTotal) },
  };
}

// ---------------------------------------------------------------------------
// Bilanço / gelir tablosu gösterimi (yasal biçim DEĞİL)
// ---------------------------------------------------------------------------

export interface StatementColumnInput {
  id: string;
  /**
   * Kod -> {ad, net (borç − alacak)}; çevrim farkı ayrı verilir. `prior`: sonuç hesaplarında (6–9) net bakiyenin dönem
   * öncesi kısmı (verilmezse 0). Gelir tablosu net − prior (yalnızca dönem hareketi) gösterir; bilanço kümülatiftir.
   */
  rows: readonly { code: string; name: string; net: string; prior?: string }[];
  translationDiff: string;
}

export interface StatementLine {
  key: string;
  label: string;
  /** Sütun (şirket kimliği ya da 'consolidated') -> tutar. */
  values: Record<string, string>;
  /** 'detail': hesap satırı; 'subtotal'/'total': ara/genel toplam. */
  kind: 'detail' | 'group' | 'subtotal' | 'total';
  code?: string;
}

export interface Statements {
  columns: string[];
  balanceSheet: StatementLine[];
  incomeStatement: StatementLine[];
  /** Varlıklar − (yabancı kaynak + özkaynak + dönem sonucu + çevrim farkı); dengeli defterde 0. */
  difference: Record<string, string>;
}

const BS_SECTIONS: { key: string; label: string; classes: string; sign: 1 | -1 }[] = [
  { key: 'assets_current', label: 'Dönen varlıklar (1)', classes: '1', sign: 1 },
  { key: 'assets_fixed', label: 'Duran varlıklar (2)', classes: '2', sign: 1 },
  { key: 'liab_short', label: 'Kısa vadeli yabancı kaynaklar (3)', classes: '3', sign: -1 },
  { key: 'liab_long', label: 'Uzun vadeli yabancı kaynaklar (4)', classes: '4', sign: -1 },
  { key: 'equity', label: 'Özkaynaklar (5)', classes: '5', sign: -1 },
];

/** Gelir tablosu grupları: ilk iki hane. Katkı = alacak − borç (gelir +, gider −). */
const IS_GROUPS: { prefix: string; label: string }[] = [
  { prefix: '60', label: 'Brüt satışlar (60)' },
  { prefix: '61', label: 'Satış indirimleri (61)' },
  { prefix: '62', label: 'Satışların maliyeti (62)' },
  { prefix: '63', label: 'Faaliyet giderleri (63)' },
  { prefix: '64', label: 'Diğer olağan gelir ve kârlar (64)' },
  { prefix: '65', label: 'Diğer olağan gider ve zararlar (65)' },
  { prefix: '66', label: 'Finansman giderleri (66)' },
  { prefix: '67', label: 'Olağan dışı gelir ve kârlar (67)' },
  { prefix: '68', label: 'Olağan dışı gider ve zararlar (68)' },
  { prefix: '7', label: 'Maliyet hesapları (7; devredilmemiş)' },
];

export function buildStatements(columns: readonly StatementColumnInput[], consolidatedId = 'consolidated'): Statements {
  const ids = columns.map((c) => c.id);
  const sumBy = (col: StatementColumnInput, pred: (code: string) => boolean): MoneyValue =>
    sum(col.rows.filter((r) => pred(r.code)).map((r) => r.net));
  /** Yalnızca dönem hareketi (sonuç hesaplarında net − dönem öncesi kısım). */
  const sumPeriod = (col: StatementColumnInput, pred: (code: string) => boolean): MoneyValue =>
    sum(col.rows.filter((r) => pred(r.code)).map((r) => dec(r.net).minus(r.prior ?? 0)));
  const isPl = (code: string) => /^[6-9]/.test(code);
  const startsWith = (p: string) => (code: string) => code.startsWith(p);

  const balanceSheet: StatementLine[] = [];
  const incomeStatement: StatementLine[] = [];
  const diff: Record<string, string> = {};

  const result = new Map<string, MoneyValue>(); // dönem sonucu (kâr +): yalnızca from..to hareketi
  const priorResult = new Map<string, MoneyValue>(); // önceki dönemlerin devredilmemiş sonucu (kapanış fişi yoksa)
  for (const c of columns) {
    result.set(c.id, sumPeriod(c, isPl).neg());
    priorResult.set(c.id, sumBy(c, isPl).neg().minus(result.get(c.id)!));
  }

  const totalAssets = new Map<string, MoneyValue>();
  const totalLE = new Map<string, MoneyValue>();
  for (const id of ids) {
    totalAssets.set(id, dec(0));
    totalLE.set(id, dec(0));
  }

  const names = new Map<string, string>();
  for (const c of columns) for (const r of c.rows) if (!names.has(r.code)) names.set(r.code, r.name);

  for (const s of BS_SECTIONS) {
    const values: Record<string, string> = {};
    for (const c of columns) {
      const v = sumBy(c, startsWith(s.classes)).times(s.sign);
      values[c.id] = toDbAmount(v);
      const target = s.sign === 1 ? totalAssets : totalLE;
      target.set(c.id, target.get(c.id)!.plus(v));
    }
    balanceSheet.push({ key: s.key, label: s.label, values, kind: 'group' });
    const codes = [...new Set(columns.flatMap((c) => c.rows.filter((r) => startsWith(s.classes)(r.code)).map((r) => r.code)))].sort();
    for (const code of codes) {
      const dv: Record<string, string> = {};
      for (const c of columns) dv[c.id] = toDbAmount(sumBy(c, (x) => x === code).times(s.sign));
      balanceSheet.push({ key: `${s.key}:${code}`, label: names.get(code) ?? code, code, values: dv, kind: 'detail' });
    }
    if (s.key === 'assets_fixed') {
      balanceSheet.push({ key: 'assets_total', label: 'Toplam varlıklar', values: Object.fromEntries(ids.map((i) => [i, toDbAmount(totalAssets.get(i)!)])), kind: 'total' });
    }
  }
  const resultVals: Record<string, string> = {};
  const priorVals: Record<string, string> = {};
  const tdVals: Record<string, string> = {};
  for (const c of columns) {
    resultVals[c.id] = toDbAmount(result.get(c.id)!);
    priorVals[c.id] = toDbAmount(priorResult.get(c.id)!);
    tdVals[c.id] = toDbAmount(dec(c.translationDiff).neg());
    totalLE.set(c.id, totalLE.get(c.id)!.plus(result.get(c.id)!).plus(priorResult.get(c.id)!).plus(dec(c.translationDiff).neg()));
  }
  balanceSheet.push({ key: 'prior_result', label: 'Önceki dönemler sonucu (devredilmemiş; 6–9 sınıfı dönem başı)', values: priorVals, kind: 'group' });
  balanceSheet.push({ key: 'period_result', label: 'Dönem kârı / zararı (6–9 sınıfı, yalnızca dönem hareketi)', values: resultVals, kind: 'group' });
  balanceSheet.push({ key: 'translation_diff', label: 'Çevrim farkı (kur ayrımından; doğrulanmadı)', values: tdVals, kind: 'group' });
  balanceSheet.push({ key: 'liab_equity_total', label: 'Toplam kaynaklar', values: Object.fromEntries(ids.map((i) => [i, toDbAmount(totalLE.get(i)!)])), kind: 'total' });
  for (const id of ids) diff[id] = toDbAmount(totalAssets.get(id)!.minus(totalLE.get(id)!));

  // Gelir tablosu
  // Gelir tablosu yalnızca from..to hareketidir (dönem başı bakiyeler hariç)
  const contrib = (c: StatementColumnInput, prefix: string) => sumPeriod(c, startsWith(prefix)).neg();
  const line = (key: string, label: string, f: (c: StatementColumnInput) => MoneyValue, kind: StatementLine['kind'] = 'group'): MoneyValue[] => {
    const values: Record<string, string> = {};
    const out: MoneyValue[] = [];
    for (const c of columns) {
      const v = f(c);
      values[c.id] = toDbAmount(v);
      out.push(v);
    }
    incomeStatement.push({ key, label, values, kind });
    return out;
  };
  const g = (prefix: string) => (c: StatementColumnInput) => contrib(c, prefix);
  const label = (p: string) => IS_GROUPS.find((x) => x.prefix === p)!.label;
  line('is60', label('60'), g('60'));
  line('is61', label('61'), g('61'));
  line('net_sales', 'Net satışlar', (c) => contrib(c, '60').plus(contrib(c, '61')), 'subtotal');
  line('is62', label('62'), g('62'));
  line('gross_profit', 'Brüt kâr', (c) => contrib(c, '60').plus(contrib(c, '61')).plus(contrib(c, '62')), 'subtotal');
  line('is63', label('63'), g('63'));
  line('operating_profit', 'Faaliyet kârı', (c) => ['60', '61', '62', '63'].reduce((a, p) => a.plus(contrib(c, p)), dec(0)), 'subtotal');
  for (const p of ['64', '65', '66']) line(`is${p}`, label(p), g(p));
  line('ordinary_profit', 'Olağan kâr', (c) => ['60', '61', '62', '63', '64', '65', '66'].reduce((a, p) => a.plus(contrib(c, p)), dec(0)), 'subtotal');
  for (const p of ['67', '68']) line(`is${p}`, label(p), g(p));
  line('is7', label('7'), g('7'));
  // Gruplara girmeyen sonuç hesapları (69, 8, 9): satırların toplamı dönem sonucuna eşit olsun
  line('is_other', 'Diğer sonuç hesapları (69, 8, 9)', (c) => sumPeriod(c, (code) => /^(69|8|9)/.test(code)).neg());
  line('net_profit', 'Dönem net kârı / zararı', (c) => result.get(c.id)!, 'total');
  void consolidatedId;
  return { columns: ids, balanceSheet, incomeStatement, difference: diff };
}

// ---------------------------------------------------------------------------
// Gelir özeti (yönetici özeti için dönem hareketlerinden) — aynı sınıflama
// ---------------------------------------------------------------------------

export interface IncomeSummary {
  netSales: string;
  costOfSales: string;
  grossProfit: string;
  operatingExpenses: string;
  otherIncome: string;
  otherExpenses: string;
  /** Devredilmemiş maliyet hesapları (7). */
  uncloseCosts: string;
  /** Gelir = net satışlar + diğer gelirler; gider = SMM + faaliyet + diğer gider/finansman + 7. */
  revenue: string;
  expenses: string;
  profit: string;
}

/** Dönem hareketi (borç, alacak) satırlarından gelir özeti. Sınıf 69/8/9 dışarıda bırakılır (kapanış kaydı yok). */
export function summarizeIncome(rows: readonly { code: string; debit: string; credit: string }[]): IncomeSummary {
  const credit = (...prefixes: string[]) =>
    sum(rows.filter((r) => prefixes.some((p) => r.code.startsWith(p))).map((r) => dec(r.credit).minus(r.debit)));
  const debit = (...prefixes: string[]) => credit(...prefixes).neg();
  const netSales = credit('60', '61');
  const cos = debit('62');
  const opex = debit('63');
  const otherIncome = credit('64', '67');
  const otherExp = debit('65', '66', '68');
  const unclosed = debit('7');
  const revenue = netSales.plus(otherIncome);
  const expenses = cos.plus(opex).plus(otherExp).plus(unclosed);
  return {
    netSales: toDbAmount(netSales),
    costOfSales: toDbAmount(cos),
    grossProfit: toDbAmount(netSales.minus(cos)),
    operatingExpenses: toDbAmount(opex),
    otherIncome: toDbAmount(otherIncome),
    otherExpenses: toDbAmount(otherExp),
    uncloseCosts: toDbAmount(unclosed),
    revenue: toDbAmount(revenue),
    expenses: toDbAmount(expenses),
    profit: toDbAmount(revenue.minus(expenses)),
  };
}

// ---------------------------------------------------------------------------
// Dönem kaydırma ve KPI'lar
// ---------------------------------------------------------------------------

const toUtc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

/** Takvim günü sayısı (iki uç dahil). */
export const daysInclusive = (from: string, to: string) => Math.round((toUtc(to) - toUtc(from)) / DAY) + 1;

function minusYear(iso: string): string {
  const y = Number(iso.slice(0, 4)) - 1;
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  // 29 Şubat -> 28 Şubat
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Karşılaştırma dönemi: 'previous' = hemen önceki aynı uzunlukta dönem; 'last_year' = bir yıl önceki aynı günler. */
export function comparePeriod(from: string, to: string, mode: 'none' | 'previous' | 'last_year'): { from: string; to: string } | null {
  if (mode === 'none') return null;
  if (mode === 'last_year') return { from: minusYear(from), to: minusYear(to) };
  const n = daysInclusive(from, to);
  const prevTo = fromUtc(toUtc(from) - DAY);
  return { from: fromUtc(toUtc(prevTo) - (n - 1) * DAY), to: prevTo };
}

/** Değişim yüzdesi ((cur − prev) / |prev|); önceki sıfırsa null. İki ondalık. */
export function pctChange(cur: string, prev: string): string | null {
  const p = dec(prev);
  if (p.isZero()) return null;
  return dec(cur).minus(p).div(p.abs()).times(100).toFixed(2);
}

export interface KpiInput {
  netSales: string;
  costOfSales: string;
  profit: string;
  /** Kapanış bakiyeleri (sınıf 1 ve 3; pozitif büyüklük). */
  currentAssets?: string | null;
  shortLiabilities?: string | null;
  receivablesTotal?: string | null;
  receivablesOverdue?: string | null;
  days: number;
}

export interface Kpis {
  grossMarginPct: string | null;
  netMarginPct: string | null;
  currentRatio: string | null;
  overdueReceivablesPct: string | null;
  /** Alacak devir günü = alacak toplamı / net satışlar × dönem gün sayısı. */
  dsoDays: string | null;
}

const ratio = (n: string | null | undefined, d: string | null | undefined, scale: number, dp: number): string | null => {
  if (n === null || n === undefined || d === null || d === undefined) return null;
  const den = dec(d);
  if (den.lte(0)) return null;
  return dec(n).div(den).times(scale).toFixed(dp);
};

export function computeKpis(i: KpiInput): Kpis {
  const grossProfit = dec(i.netSales).minus(i.costOfSales).toString();
  return {
    grossMarginPct: ratio(grossProfit, i.netSales, 100, 2),
    netMarginPct: ratio(i.profit, i.netSales, 100, 2),
    currentRatio: ratio(i.currentAssets, i.shortLiabilities, 1, 2),
    overdueReceivablesPct: ratio(i.receivablesOverdue, i.receivablesTotal, 100, 2),
    dsoDays: ratio(i.receivablesTotal, i.netSales, i.days, 1),
  };
}

// ---------------------------------------------------------------------------
// Döviz pozisyonu
// ---------------------------------------------------------------------------

export interface FxPositionItem {
  currency: string;
  kind: 'cash' | 'receivable' | 'payable';
  /** Kalemin kendi para biriminde TUTAR (borçlanma/alacak yönü `kind`dan gelir). Kasa/banka eksi bakiye ve cari avans (uygulanamayan tahsilat/ödeme) negatif olabilir. */
  amount: string;
  /** Defter para biriminde kayıtlı (tarihsel) karşılık; kasa için bakiye, cari için kalan defter tutarı. */
  book: string;
}

export interface FxPositionRow {
  currency: string;
  cash: string;
  receivables: string;
  payables: string;
  /** Net pozisyon (kendi para biriminde) = kasa/banka + alacak − borç. + uzun, − kısa pozisyon. */
  net: string;
  /** Net pozisyonun defterdeki (tarihsel) karşılığı. */
  bookNet: string;
  /** Kur (1 birim = ? defter para birimi) ve karşılık; kur yoksa null. */
  rate: string | null;
  equivalent: string | null;
  /** Gerçekleşmemiş kur farkı TAHMİNİ = karşılık − defter karşılığı (+ kâr, − zarar); kur yoksa null. Yevmiye yazılmaz. */
  unrealized: string | null;
}

/** Para birimi başına döviz pozisyonu; `rates` yabancı para -> defter para birimi kuru. Defter para birimindeki kalemler dahil edilmez (çağıran süzer). */
export function computeFxPosition(items: readonly FxPositionItem[], rates: ReadonlyMap<string, string | null>): { rows: FxPositionRow[]; totals: { equivalent: string; unrealized: string } | null } {
  const by = new Map<string, { cash: MoneyValue; rec: MoneyValue; pay: MoneyValue; bCash: MoneyValue; bRec: MoneyValue; bPay: MoneyValue }>();
  for (const it of items) {
    const a = by.get(it.currency) ?? { cash: dec(0), rec: dec(0), pay: dec(0), bCash: dec(0), bRec: dec(0), bPay: dec(0) };
    const amt = dec(it.amount);
    const book = dec(it.book);
    if (it.kind === 'cash') {
      a.cash = a.cash.plus(amt);
      a.bCash = a.bCash.plus(book);
    } else if (it.kind === 'receivable') {
      a.rec = a.rec.plus(amt);
      a.bRec = a.bRec.plus(book);
    } else {
      a.pay = a.pay.plus(amt);
      a.bPay = a.bPay.plus(book);
    }
    by.set(it.currency, a);
  }
  const rows: FxPositionRow[] = [];
  let eq = dec(0);
  let un = dec(0);
  let complete = true;
  for (const [currency, a] of [...by].sort((x, y) => x[0].localeCompare(y[0]))) {
    const net = a.cash.plus(a.rec).minus(a.pay);
    const bookNet = a.bCash.plus(a.bRec).minus(a.bPay);
    const rate = rates.get(currency) ?? null;
    const equivalent = rate ? roundMoney(net.times(rate)) : null;
    const unrealized = equivalent ? equivalent.minus(bookNet) : null;
    if (equivalent && unrealized) {
      eq = eq.plus(equivalent);
      un = un.plus(unrealized);
    } else complete = false;
    rows.push({
      currency,
      cash: toDbAmount(a.cash),
      receivables: toDbAmount(a.rec),
      payables: toDbAmount(a.pay),
      net: toDbAmount(net),
      bookNet: toDbAmount(bookNet),
      rate,
      equivalent: equivalent ? toDbAmount(equivalent) : null,
      unrealized: unrealized ? toDbAmount(unrealized) : null,
    });
  }
  return { rows, totals: rows.length && complete ? { equivalent: toDbAmount(eq), unrealized: toDbAmount(un) } : null };
}

/** Ekranda ve dışa aktarmada gösterilen KPI tanımları (tek kaynak). */
export const KPI_DEFINITIONS: Record<keyof Kpis, { label: string; definition: string }> = {
  grossMarginPct: { label: 'Brüt kâr marjı (%)', definition: '(Net satışlar − satışların maliyeti) / net satışlar × 100. Net satışlar = 60 + 61 sınıfı net alacak; satışların maliyeti = 62.' },
  netMarginPct: { label: 'Net kâr marjı (%)', definition: 'Dönem kârı / net satışlar × 100. Dönem kârı = gelir − gider (6 sınıfı hareketleri ve devredilmemiş 7 sınıfı maliyetler; 69, 8, 9 hariç).' },
  currentRatio: { label: 'Cari oran', definition: 'Dönen varlıklar (1 sınıfı kapanış bakiyesi) / kısa vadeli yabancı kaynaklar (3 sınıfı kapanış bakiyesi).' },
  overdueReceivablesPct: { label: 'Vadesi geçmiş alacak (%)', definition: 'Vadesi geçmiş açık alacak kalemleri / toplam açık alacak × 100 (cari yaşlandırma; vade günü ≥ 1).' },
  dsoDays: { label: 'Alacak devir günü', definition: 'Toplam açık alacak / net satışlar × dönemdeki gün sayısı. Bu bir yaklaşıklıktır; tahsilat takvimini yansıtmaz.' },
};
