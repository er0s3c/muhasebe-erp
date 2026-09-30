import { inArray } from 'drizzle-orm';
import { type CurrencyCode, currencySymbol, dec, formatTR, type ImportMessage, type ImportRow, type MoneyValue, roundMoney, type StockLineInput, stockOpeningsOptionsSchema, sum, toDbRate } from '@erp/shared';
import { items, stockMovements, warehouses } from '../../../db/schema';
import { loadMappings } from '../../ledger/mappings';
import { postStockDocument } from '../../inventory/documents';
import { foldKey, parseDecimal } from '../values';
import { RowState, cellOf, stockCtxOf, type ImportCtx, type ImportHandler, type PlanResult } from './common';
import { fxResolver, periodProblem } from './openings-common';
import { parseCurrency } from './parties';

/** Bir stok belgesindeki en çok satır (`createStockDocumentSchema` sınırı). */
const DOC_LINES = 200;

interface Planned {
  warehouseId: string;
  line: StockLineInput;
  value: MoneyValue;
}

/**
 * Stok açılışı: depo başına `opening` stok belgesi (200 satırı aşan depo birden çok belgeye bölünür). Her belge
 * normal akışla stok defterine ve otomatik yevmiyeye (B stok / A açılış karşı hesabı) yazılır; stok durumu ↔ muhasebe
 * mutabakatı bu yüzden sıfır kalır.
 */
export const stockOpeningsHandler: ImportHandler = {
  kind: 'stock_openings',
  module: 'core.inventory',
  permission: 'inventory.move',

  async plan(ctx: ImportCtx, rows: ImportRow[], rawOptions): Promise<PlanResult> {
    const opts = stockOpeningsOptionsSchema.parse(rawOptions);
    const { tx, company } = ctx;
    const base = company.baseCurrency as CurrencyCode;
    const general: ImportMessage[] = [];

    const problem = await periodProblem(tx, opts.openingDate);
    if (problem) general.push(problem);
    const maps = await loadMappings(tx);
    const missing = (['stock', 'opening_offset'] as const).filter((k) => !maps.has(k));
    if (missing.length > 0) {
      general.push({
        severity: 'error',
        code: 'ACCOUNT_MAPPING_MISSING',
        message: `Hesap eşlemesi eksik: ${missing.map((k) => (k === 'stock' ? 'Stok hesabı' : 'Stok devri karşı hesabı')).join(', ')}. Ayarlar > Hesap eşlemesi bölümünden tanımlayın`,
      });
    }

    const wh = await tx.select().from(warehouses);
    const whByCode = new Map(wh.map((w) => [w.code.toLowerCase(), w]));
    const whByName = new Map<string, typeof wh>();
    for (const w of wh) whByName.set(foldKey(w.name), [...(whByName.get(foldKey(w.name)) ?? []), w]);
    const defaultWh = wh.find((w) => w.isDefault && w.isActive);

    const allItems = await tx.select().from(items);
    const itemByCode = new Map(allItems.map((i) => [i.code.toLowerCase(), i]));
    const itemByBarcode = new Map(allItems.filter((i) => i.barcode).map((i) => [i.barcode!.toLowerCase(), i]));
    const itemByName = new Map<string, typeof allItems>();
    for (const i of allItems) itemByName.set(foldKey(i.name), [...(itemByName.get(foldKey(i.name)) ?? []), i]);
    const fx = fxResolver(tx, base, opts.openingDate, opts.numberFormat);

    const states: RowState[] = [];
    const planned: Planned[] = [];
    const seen = new Set<string>();
    const usedItemIds = new Set<string>();
    const stateOfItem = new Map<string, RowState[]>();

    for (const row of rows) {
      const itemText = cellOf(row, 'item');
      const rs = new RowState(row.row, itemText);
      states.push(rs);

      // Depo: kod ya da ad; boşsa varsayılan depo
      const whText = cellOf(row, 'warehouse');
      let warehouse: (typeof wh)[number] | undefined;
      if (whText === '') {
        warehouse = defaultWh;
        if (!warehouse) rs.error('warehouse', 'WAREHOUSE_REQUIRED', 'Varsayılan depo yok; depo kodu ya da adı yazın');
      } else {
        warehouse = whByCode.get(whText.toLowerCase());
        if (!warehouse) {
          const named = whByName.get(foldKey(whText)) ?? [];
          if (named.length === 1) warehouse = named[0];
          else if (named.length > 1) rs.error('warehouse', 'WAREHOUSE_AMBIGUOUS', `"${whText}" adlı birden çok depo var; depo kodunu yazın`);
          else rs.error('warehouse', 'WAREHOUSE_NOT_FOUND', `"${whText}" deposu bulunamadı`);
        }
      }
      if (warehouse && !warehouse.isActive) rs.error('warehouse', 'WAREHOUSE_INACTIVE', `${warehouse.name} deposu pasif`);

      // Stok kartı: kod, barkod, tam ad (tekil)
      let item: (typeof allItems)[number] | undefined;
      if (itemText === '') rs.error('item', 'ITEM_REQUIRED', 'Stok kodu, barkod ya da adı boş');
      else {
        item = itemByCode.get(itemText.toLowerCase()) ?? itemByBarcode.get(itemText.toLowerCase());
        if (!item) {
          const named = itemByName.get(foldKey(itemText)) ?? [];
          if (named.length === 1) item = named[0];
          else if (named.length > 1) rs.error('item', 'ITEM_AMBIGUOUS', `"${itemText}" adlı birden çok stok kartı var; stok kodunu yazın`);
          else rs.error('item', 'ITEM_NOT_FOUND', `"${itemText}" stok kartı bulunamadı (önce stok kartlarını içe aktarın)`);
        }
        if (item) {
          rs.label = `${item.code} ${item.name}`;
          if (item.kind !== 'goods') rs.error('item', 'ITEM_NOT_STOCKED', `${item.code} hizmet kalemidir, stok hareketi görmez`);
          else if (!item.isActive) rs.error('item', 'ITEM_INACTIVE', `${item.code} ${item.name} kartı pasif`);
        }
      }

      const qtyText = cellOf(row, 'quantity');
      let qty: string | null = null;
      if (qtyText === '') rs.error('quantity', 'QUANTITY_REQUIRED', 'Miktar boş');
      else {
        const q = parseDecimal(qtyText, opts.numberFormat, { maxDp: 4 });
        if (!q.ok) rs.error('quantity', q.code, `Miktar: ${q.message}`);
        else if (dec(q.value).isZero()) rs.skip('ZERO_QUANTITY', 'Miktar sıfır; atlandı');
        else qty = q.value;
      }

      const costText = cellOf(row, 'unitCost');
      let unitCost: string | null = null;
      if (costText === '') rs.error('unitCost', 'UNIT_COST_REQUIRED', 'Birim maliyet boş (bilinmiyorsa 0 yazın)');
      else {
        const c = parseDecimal(costText, opts.numberFormat, { maxDp: 6 });
        if (!c.ok) rs.error('unitCost', c.code, `Birim maliyet: ${c.message}`);
        else unitCost = c.value;
      }

      let currency = base;
      const currencyText = cellOf(row, 'currencyCode');
      if (currencyText !== '') {
        const c = parseCurrency(currencyText);
        if (!c) rs.error('currencyCode', 'CURRENCY_UNKNOWN', `"${currencyText}" desteklenen bir para birimi değil (TRY, GBP, EUR, USD)`);
        else currency = c;
      }
      let rate: MoneyValue = dec(1);
      if (rs.ok) {
        const r = await fx(currency, cellOf(row, 'fxRate'));
        if (!r.ok) rs.error('fxRate', r.code, r.message);
        else rate = r.value;
      }

      if (rs.ok && warehouse && item && qty !== null && unitCost !== null) {
        const key = `${warehouse.id}:${item.id}`;
        if (seen.has(key)) rs.warn('item', 'ITEM_REPEATED', 'Bu kart aynı depoda dosyada birden çok satırda var; satırlar ayrı giriş olarak işlenir');
        seen.add(key);
        usedItemIds.add(item.id);
        stateOfItem.set(item.id, [...(stateOfItem.get(item.id) ?? []), rs]);
        planned.push({
          warehouseId: warehouse.id,
          line: {
            itemId: item.id,
            quantity: qty,
            unitCost,
            currency,
            fxRate: currency === base ? undefined : toDbRate(rate),
          },
          // Belgenin defter değeri: miktar × birim maliyet × kur, tek seferde yuvarlanır (postStockDocument ile aynı)
          value: roundMoney(dec(qty).times(unitCost).times(rate)),
        });
      }
    }

    // Kartın zaten stok hareketi varsa açılış girişi çift sayım olabilir: uyarı
    if (usedItemIds.size > 0) {
      const moved = await tx.selectDistinct({ itemId: stockMovements.itemId }).from(stockMovements).where(inArray(stockMovements.itemId, [...usedItemIds]));
      for (const m of moved) {
        for (const rs of stateOfItem.get(m.itemId) ?? []) {
          rs.warn('item', 'ITEM_HAS_MOVEMENTS', 'Kartın stok hareketi zaten var; açılış girişi mevcut stoka eklenir');
        }
      }
    }

    // Depo başına gruplar (dosya sırası korunur), 200 satırlık belgelere bölünür
    const byWarehouse = new Map<string, Planned[]>();
    for (const p of planned) byWarehouse.set(p.warehouseId, [...(byWarehouse.get(p.warehouseId) ?? []), p]);
    const docCount = [...byWarehouse.values()].reduce((n, g) => n + Math.ceil(g.length / DOC_LINES), 0);
    const total = sum(planned.map((p) => p.value));
    const skipped = states.filter((s) => s.status === 'skip').length;

    return {
      rows: states.map((s) => s.preview()),
      general,
      summary: [
        { label: 'Açılış tarihi', value: opts.openingDate.split('-').reverse().join('.') },
        { label: 'Stok satırı', value: String(planned.length) },
        { label: 'Stok belgesi', value: `${docCount} (depo başına)` },
        { label: `Stok değeri (${currencySymbol(base)})`, value: formatTR(total) },
        { label: 'Atlanacak satır', value: String(skipped) },
      ],
      apply: async () => {
        const entries: { type: 'stock'; id: string; no: string }[] = [];
        for (const [warehouseId, group] of byWarehouse) {
          for (let i = 0; i < group.length; i += DOC_LINES) {
            const chunk = group.slice(i, i + DOC_LINES);
            const res = await postStockDocument(tx, stockCtxOf(ctx), {
              type: 'opening',
              docDate: opts.openingDate,
              warehouseId,
              description: 'Açılış stoku — içe aktarma',
              lines: chunk.map((p) => p.line),
            });
            entries.push({ type: 'stock', id: res.document.id, no: res.document.docNo });
          }
        }
        return {
          created: planned.length,
          skipped,
          summary: [
            { label: 'Stok belgesi', value: String(entries.length) },
            { label: 'Stok satırı', value: String(planned.length) },
            { label: `Stok değeri (${currencySymbol(base)})`, value: formatTR(total) },
          ],
          entries,
        };
      },
    };
  },
};
