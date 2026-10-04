import { dec, roundMoney, sum, type MoneyValue, type PartyControlType } from '@erp/shared';

/** Cari kontrol hesabındaki kaydedilmiş bir yevmiye satırı. */
export interface PartyLine {
  lineId: string;
  partyId: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  lineNo: number;
  dueDate: string | null;
  description: string;
  currencyCode: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
}

/**
 * Tahsilat/ödemenin kapattığı belirli bir kalem (party_allocations). Kapatan satır FIFO havuzundan çıkar,
 * kalem yalnızca kalanı kadar açık görünür; kalan havuz eskisi gibi FIFO uygulanır.
 */
export interface PartyAllocation {
  chargeLineId: string;
  settleLineId: string;
  /** Kalemin para biriminde kapatılan tutar */
  amount: string;
  /** Kalemin taşıdığı defter tutarından kapatılan pay */
  amountBase: string;
}

export interface OpenItem {
  lineId: string;
  partyId: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  dueDate: string;
  description: string;
  currencyCode: string;
  /** Kalemin orijinal tutarı (satır para biriminde) */
  amount: string;
  /** Kalemin defter para birimindeki tutarı */
  amountBase: string;
  /** Kapanmamış kısım (defter para biriminde) */
  remainingBase: string;
  /** Kapanmamış kısım (satır para biriminde, orantılı) */
  remaining: string;
  /** Vadeye göre gecikme günü; <= 0 ise vadesi gelmemiş */
  daysOverdue: number;
  bucket: AgingBucket;
}

export const AGING_BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function bucketOf(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'notDue';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export interface OpenItemsResult {
  items: OpenItem[];
  /** Hiçbir borca uygulanamayan fazla ödeme/avans (defter para biriminde, pozitif) */
  unapplied: string;
  /**
   * Uygulanamayan tutarın para birimi kırılımı (FIFO: en eski ödemeler önce uygulanır, kalan en yeni ödemelerdendir).
   * Döviz pozisyonu raporu yabancı para avansını buradan alır (ACC-10).
   */
  unappliedByCurrency: { currencyCode: string; amount: string; amountBase: string }[];
}

interface PoolPart {
  date: string;
  entryNo: string;
  lineNo: number;
  currencyCode: string;
  doc: MoneyValue;
  base: MoneyValue;
}

/**
 * FIFO ile açık kalem hesabı. Alacak tarafında (müşteri) borç satırları, borç tarafında
 * (tedarikçi) alacak satırları "kalem"dir; karşı taraftaki satırlar (tahsilat/ödeme) toplamı
 * en eski vadeden başlayarak kalemlere uygulanır. Tahsilat/ödeme belirli kalemleri seçerek
 * kapatmışsa (`allocations`) önce bu eşleştirmeler düşülür; eşleştirilmiş kapatan satırlar havuza girmez.
 * Savunma (ACC-3): kalemini aşan eşleştirme fazlası ve kalemi artık görünmeyen (ters çevrilmiş) eşleştirme havuza döner;
 * böylece açık kalem/avans toplamı her durumda defter bakiyesine eşittir (fazla ödeme kaybolmaz).
 */
export function computeOpenItems(
  lines: PartyLine[],
  type: PartyControlType,
  asOf: string,
  allocations: readonly PartyAllocation[] = [],
): OpenItemsResult {
  const chargeSide = type === 'receivable' ? 'debit' : 'credit';
  const settleSide = type === 'receivable' ? 'credit' : 'debit';
  const base = (l: PartyLine, side: 'debit' | 'credit') => dec(side === 'debit' ? l.debitBase : l.creditBase);
  const doc = (l: PartyLine, side: 'debit' | 'credit') => dec(side === 'debit' ? l.debit : l.credit);

  const charges = lines
    .filter((l) => base(l, chargeSide).gt(0))
    .map((l) => ({ line: l, dueOn: l.dueDate ?? l.entryDate }))
    .sort(
      (a, b) =>
        a.dueOn.localeCompare(b.dueOn) ||
        a.line.entryDate.localeCompare(b.line.entryDate) ||
        a.line.entryNo.localeCompare(b.line.entryNo) ||
        a.line.lineNo - b.line.lineNo,
    );
  const chargeIds = new Set(charges.map((c) => c.line.lineId));
  const byId = new Map(lines.map((l) => [l.lineId, l]));

  const parts: PoolPart[] = [];
  const part = (l: PartyLine, currencyCode: string, d: MoneyValue, b: MoneyValue) =>
    parts.push({ date: l.entryDate, entryNo: l.entryNo, lineNo: l.lineNo, currencyCode, doc: d, base: b });

  const explicitSettle = new Set(allocations.map((a) => a.settleLineId));
  const explicit = new Map<string, { amount: MoneyValue; base: MoneyValue }>();
  for (const a of allocations) {
    if (!chargeIds.has(a.chargeLineId)) {
      // Kalemi görünmeyen eşleştirme (kalem ters çevrilmiş): kapatan satır havuza döner
      const st = byId.get(a.settleLineId);
      if (st) part(st, st.currencyCode, dec(a.amount), dec(a.amountBase));
      continue;
    }
    const cur = explicit.get(a.chargeLineId) ?? { amount: dec(0), base: dec(0) };
    explicit.set(a.chargeLineId, { amount: cur.amount.plus(a.amount), base: cur.base.plus(a.amountBase) });
  }
  for (const l of lines) {
    if (base(l, settleSide).gt(0) && !explicitSettle.has(l.lineId)) part(l, l.currencyCode, doc(l, settleSide), base(l, settleSide));
  }
  for (const { line } of charges) {
    const closed = explicit.get(line.lineId);
    const amountBase = base(line, chargeSide);
    if (closed && closed.base.gt(amountBase)) {
      // Kalemini aşan eşleştirme fazlası havuza döner
      const over = closed.amount.minus(doc(line, chargeSide));
      part(line, line.currencyCode, over.gt(0) ? over : dec(0), closed.base.minus(amountBase));
    }
  }

  let pool: MoneyValue = sum(parts.map((p) => p.base));

  const items: OpenItem[] = [];
  for (const { line, dueOn } of charges) {
    const amountBase = base(line, chargeSide);
    const original = doc(line, chargeSide);
    const closed = explicit.get(line.lineId);
    // Eşleştirmelerden sonra kalem (defter ve kalem para biriminde)
    const availBase = closed ? amountBase.minus(closed.base) : amountBase;
    const availDoc = closed ? original.minus(closed.amount) : original;
    if (availBase.lte(0)) continue;

    const used = pool.gte(availBase) ? availBase : pool;
    pool = pool.minus(used);
    const remainingBase = availBase.minus(used);
    if (remainingBase.lte(0)) continue;

    const remaining = remainingBase.equals(availBase)
      ? availDoc
      : roundMoney(availDoc.times(remainingBase).div(availBase));
    const daysOverdue = daysBetween(dueOn, asOf);
    items.push({
      lineId: line.lineId,
      partyId: line.partyId,
      entryId: line.entryId,
      entryNo: line.entryNo,
      entryDate: line.entryDate,
      dueDate: dueOn,
      description: line.description,
      currencyCode: line.currencyCode,
      amount: original.toFixed(2),
      amountBase: amountBase.toFixed(2),
      remainingBase: remainingBase.toFixed(2),
      remaining: remaining.toFixed(2),
      daysOverdue,
      bucket: bucketOf(daysOverdue),
    });
  }

  // Kalan havuz en yeni ödemelerden oluşur (FIFO): para birimi kırılımı
  const byCur = new Map<string, { amount: MoneyValue; base: MoneyValue }>();
  let left = pool;
  for (const p of [...parts].sort((a, b) => b.date.localeCompare(a.date) || b.entryNo.localeCompare(a.entryNo) || b.lineNo - a.lineNo)) {
    if (left.lte(0)) break;
    if (p.base.lte(0)) continue;
    const take = left.gte(p.base) ? p.base : left;
    left = left.minus(take);
    const d = take.equals(p.base) ? p.doc : roundMoney(p.doc.times(take).div(p.base));
    const cur = byCur.get(p.currencyCode) ?? { amount: dec(0), base: dec(0) };
    byCur.set(p.currencyCode, { amount: cur.amount.plus(d), base: cur.base.plus(take) });
  }
  return {
    items,
    unapplied: pool.toFixed(2),
    unappliedByCurrency: [...byCur]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([currencyCode, v]) => ({ currencyCode, amount: v.amount.toFixed(2), amountBase: v.base.toFixed(2) })),
  };
}

export interface AgingRow {
  partyId: string;
  partyCode: string;
  partyName: string;
  notDue: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90plus: string;
  /** Fazla ödeme/avans (negatif etki) */
  unapplied: string;
  /** Net bakiye = kalemler toplamı − fazla ödeme */
  total: string;
}

export interface AgingReport {
  type: PartyControlType;
  asOf: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, 'partyId' | 'partyCode' | 'partyName'>;
}

export function buildAgingReport(
  linesByParty: Map<string, { code: string; name: string; lines: PartyLine[]; allocations?: PartyAllocation[] }>,
  type: PartyControlType,
  asOf: string,
): AgingReport {
  const rows: AgingRow[] = [];
  const zero = () => ({ notDue: dec(0), d1_30: dec(0), d31_60: dec(0), d61_90: dec(0), d90plus: dec(0), unapplied: dec(0) });
  const grand = zero();

  for (const [partyId, p] of linesByParty) {
    const { items, unapplied } = computeOpenItems(p.lines, type, asOf, p.allocations ?? []);
    const b = zero();
    for (const it of items) b[it.bucket] = b[it.bucket].plus(it.remainingBase);
    b.unapplied = dec(unapplied);
    const itemsTotal = sum([b.notDue, b.d1_30, b.d31_60, b.d61_90, b.d90plus]);
    if (itemsTotal.isZero() && b.unapplied.isZero()) continue;

    for (const k of Object.keys(grand) as (keyof typeof grand)[]) grand[k] = grand[k].plus(b[k]);
    rows.push({
      partyId,
      partyCode: p.code,
      partyName: p.name,
      notDue: b.notDue.toFixed(2),
      d1_30: b.d1_30.toFixed(2),
      d31_60: b.d31_60.toFixed(2),
      d61_90: b.d61_90.toFixed(2),
      d90plus: b.d90plus.toFixed(2),
      unapplied: b.unapplied.toFixed(2),
      total: itemsTotal.minus(b.unapplied).toFixed(2),
    });
  }
  rows.sort((a, b) => Number(b.total) - Number(a.total) || a.partyName.localeCompare(b.partyName, 'tr'));

  const itemsTotal = sum([grand.notDue, grand.d1_30, grand.d31_60, grand.d61_90, grand.d90plus]);
  return {
    type,
    asOf,
    rows,
    totals: {
      notDue: grand.notDue.toFixed(2),
      d1_30: grand.d1_30.toFixed(2),
      d31_60: grand.d31_60.toFixed(2),
      d61_90: grand.d61_90.toFixed(2),
      d90plus: grand.d90plus.toFixed(2),
      unapplied: grand.unapplied.toFixed(2),
      total: itemsTotal.minus(grand.unapplied).toFixed(2),
    },
  };
}
