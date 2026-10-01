import { dec, type MoneyValue } from './money';

/** Taksit planı satırı (sözleşme para biriminde). */
export interface PlanRow {
  kind: 'down_payment' | 'installment' | 'balloon';
  dueDate: string;
  amount: string;
}

/** `YYYY-MM-DD` tarihine ay ekler; hedef ayda gün yoksa ayın son gününe oturur (31 Ocak + 1 ay = 28/29 Şubat). */
export function addMonthsIso(iso: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Geçersiz tarih: ${iso}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const total = y * 12 + mo + months;
  const ty = Math.floor(total / 12);
  const tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${String(ty).padStart(4, '0')}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export interface PlanInput {
  price: string;
  downPayment: string;
  /** Peşinatın vadesi (genellikle sözleşme tarihi). */
  downDue: string;
  /** Peşinattan sonraki eşit taksit sayısı (≥ 1). */
  count: number;
  intervalMonths: number;
  firstDue: string;
}

/**
 * Peşinat + eşit taksit planı. Kuruş farkı son taksitte toplanır, böylece toplam her zaman bedele eşittir.
 * Peşinat bedelin tamamıysa taksit üretilmez.
 */
export function buildInstallmentPlan(i: PlanInput): PlanRow[] {
  const price = dec(i.price);
  const down = dec(i.downPayment);
  if (price.lte(0)) throw new Error('Bedel sıfırdan büyük olmalı');
  if (down.lt(0) || down.gt(price)) throw new Error('Peşinat bedeli aşamaz');
  const out: PlanRow[] = [];
  if (down.gt(0)) out.push({ kind: 'down_payment', dueDate: i.downDue, amount: down.toFixed(2) });
  const rest = price.minus(down);
  if (rest.isZero()) return out;
  if (!Number.isInteger(i.count) || i.count < 1) throw new Error('Taksit sayısı en az 1 olmalı');
  const each = rest.div(i.count).toDecimalPlaces(2, 1); // aşağı yuvarla
  let allocated: MoneyValue = dec(0);
  for (let n = 0; n < i.count; n++) {
    const amount = n === i.count - 1 ? rest.minus(allocated) : each;
    allocated = allocated.plus(amount);
    out.push({ kind: 'installment', dueDate: addMonthsIso(i.firstDue, n * i.intervalMonths), amount: amount.toFixed(2) });
  }
  return out;
}

/** Plan toplamı bedelle karşılaştırması (elle düzenleme sonrası). `diff` = bedel − toplam. */
export function planTotals(rows: readonly { amount: string }[], price: string): { total: string; diff: string; ok: boolean } {
  const total = rows.reduce((s, r) => s.plus(dec(r.amount || '0')), dec(0));
  const diff = dec(price).minus(total);
  return { total: total.toFixed(2), diff: diff.toFixed(2), ok: diff.isZero() };
}

/** Toplu birim üretimi: kat ve kat başına sıra → birim numarası ("3. kat 2. birim" = "302"). */
export function generateUnitNumbers(floorFrom: number, floorTo: number, perFloor: number): { floor: number; unitNo: string }[] {
  const out: { floor: number; unitNo: string }[] = [];
  for (let f = floorFrom; f <= floorTo; f++) {
    for (let n = 1; n <= perFloor; n++) out.push({ floor: f, unitNo: `${f}${String(n).padStart(2, '0')}` });
  }
  return out;
}
