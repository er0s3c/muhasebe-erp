import { dec, toDbAmount, toDbRate, type MoneyValue } from './money';

/**
 * Yıl sonu kapanışı: saf hesap (veritabanı ve HTTP yok). Tüm hesap seçimleri VARSAYILANDIR ve mali müşavirce
 * doğrulanmamıştır (LEGAL-NOTES §23). Bu dosya yalnızca "hangi gelir/gider/maliyet bakiyesi hangi satırla sıfırlanır" sorusunu yanıtlar.
 */

/** Kapanış fişlerinin `journal_entries.source_type` değerleri; gelir tablosu gibi raporlar bunları varsayılan olarak hariç tutar. */
export const YEAR_END_CLOSE_SOURCE = 'year_end_close';
export const YEAR_END_CARRY_SOURCE = 'year_end_carry';
export const YEAR_END_SOURCE_TYPES = [YEAR_END_CLOSE_SOURCE, YEAR_END_CARRY_SOURCE] as const;

/** Kapatılan hesap türleri (hesap planındaki `accounts.type`); sabit hesap kodu aralığı varsayılmaz. */
export const YEAR_END_RESULT_TYPES = ['income', 'expense', 'cost'] as const;

export const isYearEndSource = (sourceType: string | null | undefined): boolean =>
  sourceType === YEAR_END_CLOSE_SOURCE || sourceType === YEAR_END_CARRY_SOURCE;

/** Yıl sonu eşleme anahtarları (hesap eşlemesi sayfasında düzenlenir; varsayılanlar doğrulanmamıştır). */
export const YEAR_END_MAPPING_KEYS = ['year_end_profit', 'year_end_loss', 'year_end_retained_profit', 'year_end_retained_loss'] as const;
export type YearEndMappingKey = (typeof YEAR_END_MAPPING_KEYS)[number];

/** Ters kaydın / gelir tablosunun okuyacağı net: yıl içinde ilgili hesap/boyut için gelir-gider hareketi toplamı. */
export interface ResultBalanceRow {
  accountId: string;
  code: string;
  name: string;
  /** Hesabın sabit para birimi (yoksa null = defter para birimi). */
  currencyCode: string | null;
  projectId: string | null;
  wbsId: string | null;
  costCodeId: string | null;
  /** Tutarlar yıl içindeki kaydedilmiş, kapanış-dışı satırların toplamıdır (`numeric` metin). */
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
  /** Raporlama para birimi toplamı; satırlardan biri bile boşsa null. */
  debitReporting: string | null;
  creditReporting: string | null;
}

export interface ResultAccountRef {
  id: string;
  code: string;
  name: string;
}

export interface ClosingLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string;
  currencyCode: string;
  fxRate: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
  debitReporting: string | null;
  creditReporting: string | null;
  projectId: string | null;
  wbsId: string | null;
  costCodeId: string | null;
}

export interface ClosingIssue {
  code: 'FX_RESIDUAL' | 'FX_SIGN_MISMATCH';
  message: string;
  accountCode: string;
}

export type ClosingKind = 'profit' | 'loss' | 'zero';

export interface ClosingPlanInput {
  baseCurrency: string;
  rows: readonly ResultBalanceRow[];
  profit: ResultAccountRef;
  loss: ResultAccountRef;
  retainedProfit: ResultAccountRef;
  retainedLoss: ResultAccountRef;
}

export interface ClosingPlan {
  kind: ClosingKind;
  /** Dönem sonucu (defter para birimi): kâr pozitif, zarar negatif. */
  net: string;
  /** Kapanış fişi satırları: önce gelir/gider hesaplarını sıfırlayanlar, son satır sonuç hesabı (sonuç sıfırsa yok). */
  closingLines: ClosingLine[];
  /** Devir fişi satırları (sonuç hesabı → geçmiş yıllar); sonuç sıfırsa boş. */
  carryLines: ClosingLine[];
  totals: { debitBase: string; creditBase: string };
  /** Kapanışa engel olan durumlar (ör. dövizli hesapta bakiye döviz tutarı sıfır ama defter tutarı sıfır değil). */
  issues: ClosingIssue[];
  /** Yevmiye satırlarında raporlama tutarı verilebildi mi (kaynak satırlardan biri boşsa hayır). */
  reportingComplete: boolean;
  /** Kapatılan (bakiyesi sıfır olmayan) hesap kalemi sayısı. */
  accountCount: number;
}

const byKey = (a: ResultBalanceRow, b: ResultBalanceRow) =>
  a.code.localeCompare(b.code) || (a.projectId ?? '').localeCompare(b.projectId ?? '') || (a.wbsId ?? '').localeCompare(b.wbsId ?? '') || (a.costCodeId ?? '').localeCompare(b.costCodeId ?? '');

function mkLine(
  ref: { id: string; code: string; name: string },
  description: string,
  baseCurrency: string,
  side: 'debit' | 'credit',
  base: MoneyValue,
  rep: MoneyValue | null,
  dims: { projectId: string | null; wbsId: string | null; costCodeId: string | null } = { projectId: null, wbsId: null, costCodeId: null },
  fx?: { currency: string; amount: MoneyValue },
): ClosingLine {
  const amount = fx ? fx.amount : base;
  return {
    accountId: ref.id,
    accountCode: ref.code,
    accountName: ref.name,
    description,
    currencyCode: fx ? fx.currency : baseCurrency,
    fxRate: fx ? toDbRate(base.div(fx.amount)) : '1.00000000',
    debit: side === 'debit' ? toDbAmount(amount) : '0.0000',
    credit: side === 'credit' ? toDbAmount(amount) : '0.0000',
    debitBase: side === 'debit' ? toDbAmount(base) : '0.0000',
    creditBase: side === 'credit' ? toDbAmount(base) : '0.0000',
    debitReporting: rep ? (side === 'debit' ? toDbAmount(rep) : '0.0000') : null,
    creditReporting: rep ? (side === 'credit' ? toDbAmount(rep) : '0.0000') : null,
    ...dims,
  };
}

/**
 * Gelir/gider/maliyet bakiyelerini sonuç hesabına kapatan satırları hesaplar.
 *  - Borç bakiyeli hesap alacaklandırılır, alacak bakiyeli hesap borçlandırılır (satır başına hesap × proje × iş kalemi × maliyet kodu;
 *    proje boyutları kapanış satırında KORUNUR, böylece satır bazında bakiye tam sıfırlanır).
 *  - Sonuç: kâr → `profit` hesabına alacak, zarar → `loss` hesabına borç (tek satır; Tekdüzen'de 590/591).
 *  - Devir: kâr → B `profit` / A `retainedProfit`; zarar → A `loss` / B `retainedLoss`.
 *  - Dövizli (sabit para birimli) hesap kendi para biriminde, defter tutarı toplamla kapatılır.
 */
export function computeClosingPlan(input: ClosingPlanInput): ClosingPlan {
  const { baseCurrency } = input;
  const issues: ClosingIssue[] = [];
  const lines: ClosingLine[] = [];
  let reportingComplete = true;
  let netCredit = dec(0); // alacak − borç (kâr pozitif)
  let accountCount = 0;

  for (const r of [...input.rows].sort(byKey)) {
    const netBase = dec(r.debitBase).minus(r.creditBase); // borç bakiyesi > 0
    const foreign = r.currencyCode && r.currencyCode !== baseCurrency ? r.currencyCode : null;
    const netCur = dec(r.debit).minus(r.credit);
    if (netBase.isZero() && (!foreign || netCur.isZero())) continue;
    accountCount++;

    const ref = { id: r.accountId, code: r.code, name: r.name };
    const dims = { projectId: r.projectId, wbsId: r.wbsId, costCodeId: r.costCodeId };
    const side: 'debit' | 'credit' = netBase.gt(0) ? 'credit' : 'debit'; // bakiyenin tersi
    const base = netBase.abs();

    let fx: { currency: string; amount: MoneyValue } | undefined;
    if (foreign) {
      if (netBase.isZero() || netCur.isZero()) {
        issues.push({
          code: 'FX_RESIDUAL',
          accountCode: r.code,
          message: `${r.code}: döviz tutarı ile defter tutarı birlikte sıfırlanamıyor (döviz ${netCur.toFixed(2)}, defter ${netBase.toFixed(2)}); elle düzeltme yevmiyesi gerekir`,
        });
        continue;
      }
      if (netCur.gt(0) !== netBase.gt(0)) {
        issues.push({
          code: 'FX_SIGN_MISMATCH',
          accountCode: r.code,
          message: `${r.code}: döviz bakiyesi ile defter bakiyesi ters yönde; elle düzeltme yevmiyesi gerekir`,
        });
        continue;
      }
      fx = { currency: foreign, amount: netCur.abs() };
    }

    let rep: MoneyValue | null = null;
    if (r.debitReporting !== null && r.creditReporting !== null) {
      const netRep = dec(r.debitReporting).minus(r.creditReporting);
      if (netRep.isZero() || netRep.gt(0) !== netBase.gt(0)) reportingComplete = false;
      else rep = netRep.abs();
    } else {
      reportingComplete = false;
    }

    netCredit = netCredit.plus(netBase.negated());
    lines.push(mkLine(ref, `Kapanış: ${r.code} ${r.name}`, baseCurrency, side, base, rep, dims, fx));
  }

  const net = netCredit;
  const kind: ClosingKind = net.isZero() ? 'zero' : net.gt(0) ? 'profit' : 'loss';
  const dropReporting = (ls: ClosingLine[]) => {
    for (const l of ls) {
      l.debitReporting = null;
      l.creditReporting = null;
    }
  };
  if (!reportingComplete) dropReporting(lines);

  const sumSide = (ls: ClosingLine[], k: 'debitBase' | 'creditBase') => ls.reduce((s, l) => s.plus(l[k]), dec(0));
  const sumRep = (ls: ClosingLine[], k: 'debitReporting' | 'creditReporting') => ls.reduce((s, l) => s.plus(l[k] ?? 0), dec(0));

  const closingLines = [...lines];
  const carryLines: ClosingLine[] = [];
  if (kind !== 'zero') {
    const abs = net.abs();
    const resultRef = kind === 'profit' ? input.profit : input.loss;
    const resultSide: 'debit' | 'credit' = kind === 'profit' ? 'credit' : 'debit';
    // Sonuç satırının raporlama tutarı, fişi dengeleyen artıktır (satır satır yuvarlama farkı sonuç satırında toplanır)
    let repResult: MoneyValue | null = null;
    if (reportingComplete) {
      repResult = resultSide === 'credit'
        ? sumRep(lines, 'debitReporting').minus(sumRep(lines, 'creditReporting'))
        : sumRep(lines, 'creditReporting').minus(sumRep(lines, 'debitReporting'));
      if (repResult.lte(0)) {
        repResult = null;
        dropReporting(closingLines);
      }
    }
    closingLines.push(mkLine(resultRef, kind === 'profit' ? 'Dönem net kârı' : 'Dönem net zararı', baseCurrency, resultSide, abs, repResult));

    const retained = kind === 'profit' ? input.retainedProfit : input.retainedLoss;
    carryLines.push(
      mkLine(resultRef, 'Dönem sonucunun geçmiş yıllara devri', baseCurrency, kind === 'profit' ? 'debit' : 'credit', abs, repResult),
      mkLine(retained, kind === 'profit' ? 'Geçmiş yıllar kârları' : 'Geçmiş yıllar zararları', baseCurrency, kind === 'profit' ? 'credit' : 'debit', abs, repResult),
    );
  }

  const totals = { debitBase: sumSide(closingLines, 'debitBase'), creditBase: sumSide(closingLines, 'creditBase') };
  if (issues.length === 0 && !totals.debitBase.equals(totals.creditBase)) {
    throw new Error(`Kapanış fişi dengesiz: borç ${totals.debitBase.toFixed(4)} alacak ${totals.creditBase.toFixed(4)}`);
  }
  return {
    kind,
    net: toDbAmount(net),
    closingLines,
    carryLines,
    totals: { debitBase: toDbAmount(totals.debitBase), creditBase: toDbAmount(totals.creditBase) },
    issues,
    reportingComplete,
    accountCount,
  };
}

// ---- Mali yıl tarihleri ----------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Mali yıl aralığı tam aylara oturmalı: dönemler ay bazlıdır (başlangıç ayın 1'i, bitiş ayın son günü). */
export function isMonthAlignedRange(start: string, end: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number];
  const [ey, em, ed] = end.split('-').map(Number) as [number, number, number];
  return sd === 1 && ed === lastDay(ey, em) && (ey > sy || (ey === sy && em >= sm));
}

/** Aralıktaki ay sayısı (tam aylara oturan aralık için). */
export function monthsInRange(start: string, end: string): { year: number; month: number; start: string; end: string }[] {
  const out: { year: number; month: number; start: string; end: string }[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push({ year: y, month: m, start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}` });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** "2026-12-31" -> "2027-01-01" */
export function nextDayIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Varsayılan ad: takvim yılıysa "2026", değilse "2026/2027" ya da aralık. Kod takvim yılını VARSAYMAZ; yalnızca öneri adıdır. */
export function defaultFiscalYearName(start: string, end: string): string {
  const sy = start.slice(0, 4);
  const ey = end.slice(0, 4);
  if (start === `${sy}-01-01` && end === `${sy}-12-31`) return sy;
  if (sy !== ey) return `${sy}/${ey}`;
  return `${start} – ${end}`;
}
