import { dec, roundMoney, type MoneyValue } from '@erp/shared';
import { unprocessable } from '../../http/errors';
import { fmtQty, neg, whKey } from './balances';
import { applyIssue, costIssue, costReceipt, referenceUnitCost, type ItemState } from './costing';

/** Veritabanına yazılacak stok defteri satırı (işaretli miktar ve değer). */
export interface DraftRow {
  lineNo: number;
  kind: 'qty' | 'cost_adjust';
  itemId: string;
  warehouseId: string;
  qty: MoneyValue;
  value: MoneyValue;
  currencyCode?: string | null;
  unitCost?: string | null;
  fxRate?: string | null;
  /**
   * Yalnızca bellekte: 'delivery_variance' = irsaliyeli alışta fatura fiyat farkının stokta kalan payı.
   * Bu tutar yevmiyede zaten stok hesabındadır; alış girişinin eksi bakiye kapanış düzeltmesinden (621'e
   * aktarılan) ayırt edilmesi için işaretlenir. Veritabanına yazılmaz.
   */
  tag?: 'delivery_variance';
}

export interface PlannerItem {
  code: string;
  name: string;
  unit: string;
}

export interface ForeignCost {
  currencyCode: string;
  unitCost: string;
  fxRate: string;
}

/**
 * Bir belgenin defter satırlarını sırayla üretir: her satır ürünün o anki durumuna göre
 * maliyetlenir, durum bellekte ilerletilir. Yalnızca hesap yapar; DB'ye yazmaz.
 * Kaydetme ve sayım aynı planlayıcıyı kullanır.
 */
export class StockPlanner {
  readonly rows: DraftRow[] = [];
  /** Alış/giriş sırasında maliyeti sıfır olan ürünler (sayım fazlası vb.). */
  readonly zeroCostItems = new Set<string>();

  constructor(
    private readonly states: Map<string, ItemState>,
    private readonly whQty: Map<string, MoneyValue>,
    private readonly opts: {
      allowNegative: boolean;
      items: Map<string, PlannerItem>;
      warehouseNames: Map<string, string>;
    },
  ) {}

  state(itemId: string): ItemState {
    return this.states.get(itemId)!;
  }

  available(itemId: string, warehouseId: string): MoneyValue {
    return this.whQty.get(whKey(itemId, warehouseId)) ?? dec(0);
  }

  private bump(itemId: string, warehouseId: string, delta: MoneyValue) {
    this.whQty.set(whKey(itemId, warehouseId), this.available(itemId, warehouseId).plus(delta));
  }

  private checkAvailable(itemId: string, warehouseId: string, qty: MoneyValue) {
    if (this.opts.allowNegative) return;
    const have = this.available(itemId, warehouseId);
    if (have.minus(qty).isNegative()) {
      const item = this.opts.items.get(itemId)!;
      throw unprocessable(
        `Yetersiz stok: ${item.code} ${item.name} — ${this.opts.warehouseNames.get(warehouseId) ?? 'depo'} deposunda ${fmtQty(have)} ${item.unit} var, ${fmtQty(qty)} isteniyor`,
        'STOCK_INSUFFICIENT',
        { itemId, warehouseId, available: have.toFixed(4), requested: qty.toFixed(4) },
      );
    }
  }

  /** Giriş/devir: `valueBase` şirket para biriminde toplam değer. */
  receipt(lineNo: number, itemId: string, warehouseId: string, qty: MoneyValue, valueBase: MoneyValue, foreign?: ForeignCost) {
    const r = costReceipt(this.state(itemId), qty, valueBase);
    this.states.set(itemId, r.after);
    this.bump(itemId, warehouseId, qty);
    if (valueBase.isZero()) this.zeroCostItems.add(itemId);
    this.rows.push({
      lineNo,
      kind: 'qty',
      itemId,
      warehouseId,
      qty,
      value: valueBase,
      currencyCode: foreign?.currencyCode ?? null,
      unitCost: foreign?.unitCost ?? null,
      fxRate: foreign?.fxRate ?? null,
    });
    if (!r.adjustment.isZero()) {
      this.rows.push({ lineNo, kind: 'cost_adjust', itemId, warehouseId, qty: dec(0), value: r.adjustment });
    }
  }

  /** Çıkış/fire/sarf: ortalama maliyetle. */
  issue(lineNo: number, itemId: string, warehouseId: string, qty: MoneyValue) {
    this.checkAvailable(itemId, warehouseId, qty);
    const st = this.state(itemId);
    const value = costIssue(st, qty);
    this.states.set(itemId, applyIssue(st, qty, value));
    this.bump(itemId, warehouseId, neg(qty));
    this.rows.push({ lineNo, kind: 'qty', itemId, warehouseId, qty: neg(qty), value: neg(value) });
  }

  /** Maliyet düzeltmesi: envanter değeri işaretli `value` kadar değişir, miktar aynı kalır (miktar satırı yazılmaz). */
  adjust(lineNo: number, itemId: string, warehouseId: string, value: MoneyValue, tag?: DraftRow['tag']) {
    if (value.isZero()) return;
    const st = this.state(itemId);
    this.states.set(itemId, { ...st, value: st.value.plus(value) });
    this.rows.push({ lineNo, kind: 'cost_adjust', itemId, warehouseId, qty: dec(0), value, tag });
  }

  /** Depolar arası: değer ortalama maliyetle taşınır; ürünün toplam miktar/değeri değişmez. */
  transfer(lineNo: number, itemId: string, fromWarehouseId: string, toWarehouseId: string, qty: MoneyValue) {
    this.checkAvailable(itemId, fromWarehouseId, qty);
    const value = costIssue(this.state(itemId), qty);
    this.bump(itemId, fromWarehouseId, neg(qty));
    this.bump(itemId, toWarehouseId, qty);
    this.rows.push({ lineNo, kind: 'qty', itemId, warehouseId: fromWarehouseId, qty: neg(qty), value: neg(value) });
    this.rows.push({ lineNo, kind: 'qty', itemId, warehouseId: toWarehouseId, qty, value });
  }

  /** Sayım fazlası: girişin maliyeti referans (ortalama, yoksa son alış) maliyettir. */
  surplus(lineNo: number, itemId: string, warehouseId: string, qty: MoneyValue) {
    const unit = referenceUnitCost(this.state(itemId));
    const value = roundMoney(qty.times(unit));
    this.receipt(lineNo, itemId, warehouseId, qty, value);
  }
}
