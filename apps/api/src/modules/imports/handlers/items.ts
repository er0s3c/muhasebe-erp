import {
  ITEM_UNITS,
  ITEM_UNIT_LABELS,
  createItemSchema,
  dec,
  itemsImportOptionsSchema,
  type CreateItemInput,
  type ImportRow,
  type ItemKind,
  type ItemUnit,
} from '@erp/shared';
import { itemCategories, items, taxRates } from '../../../db/schema';
import { createCategory } from '../../inventory/categories';
import { createItem } from '../../inventory/items';
import { foldKey, parseDecimal } from '../values';
import { parseCurrency } from './parties';
import { CODE_RE, RowState, cellOf, type ImportCtx, type ImportHandler, type PlanResult } from './common';

const KIND_WORDS: Record<string, ItemKind> = { mal: 'goods', stok: 'goods', urun: 'goods', goods: 'goods', hizmet: 'service', service: 'service' };

/** Birim: kod, Türkçe etiket ve yaygın yazımlar. */
const UNIT_WORDS: Record<string, ItemUnit> = (() => {
  const map: Record<string, ItemUnit> = {};
  for (const u of ITEM_UNITS) {
    map[foldKey(u)] = u;
    map[foldKey(ITEM_UNIT_LABELS[u])] = u;
  }
  Object.assign(map, {
    ad: 'adet', pcs: 'adet', piece: 'adet', mt: 'm', metre: 'm', metrekare: 'm2', metrekup: 'm3', litre: 'lt', l: 'lt', gr: 'g', gram: 'g',
    kilogram: 'kg', tonaj: 'ton', koli: 'koli', cuval: 'cuval', gun: 'gun', saat: 'saat',
  } satisfies Record<string, ItemUnit>);
  return map;
})();

interface Planned {
  state: RowState;
  input: Omit<CreateItemInput, 'categoryId'>;
  /** Kategori adı (yeni ya da mevcut); kimliği yazma anında çözülür. */
  categoryKey: string | null;
}

/** Stok kartları: kod/barkod çakışması atla ya da hata; kategori bul-yoksa-oluştur; KDV kodu doğrulanır. */
export const itemsHandler: ImportHandler = {
  kind: 'items',
  module: 'core.inventory',
  permission: 'inventory.manage',

  async plan(ctx: ImportCtx, rows: ImportRow[], rawOptions): Promise<PlanResult> {
    const opts = itemsImportOptionsSchema.parse(rawOptions);
    const { tx, company } = ctx;

    const existing = await tx.select({ code: items.code, barcode: items.barcode }).from(items);
    const takenCodes = new Set(existing.map((i) => i.code.toLowerCase()));
    const takenBarcodes = new Set(existing.filter((i) => i.barcode).map((i) => i.barcode!.toLowerCase()));
    const categories = await tx.select({ id: itemCategories.id, name: itemCategories.name }).from(itemCategories);
    const categoryByKey = new Map(categories.map((c) => [foldKey(c.name), c]));
    const rates = await tx.select({ code: taxRates.code, rate: taxRates.rate }).from(taxRates);
    const vatByFold = new Map<string, string>();
    const vatByRate = new Map<string, Set<string>>();
    for (const r of rates) {
      vatByFold.set(foldKey(r.code), r.code);
      const key = dec(r.rate).toFixed();
      vatByRate.set(key, (vatByRate.get(key) ?? new Set()).add(r.code));
    }

    const states: RowState[] = [];
    const planned: Planned[] = [];
    const seenCodes = new Set<string>();
    const seenBarcodes = new Set<string>();
    const explicitCodes = new Set<string>();
    /** Yeni oluşturulacak kategoriler (ilk görülen yazımla, dosya sırasıyla). */
    const newCategories = new Map<string, string>();

    for (const row of rows) {
      const name = cellOf(row, 'name');
      const rs = new RowState(row.row, name);
      states.push(rs);

      if (name.length < 2) rs.error('name', 'NAME_REQUIRED', 'Ad en az 2 karakter olmalı');
      else if (name.length > 160) rs.error('name', 'NAME_TOO_LONG', 'Ad en çok 160 karakter olabilir');

      const kindText = cellOf(row, 'kind');
      let kind: ItemKind = 'goods';
      if (kindText !== '') {
        const k = KIND_WORDS[foldKey(kindText)];
        if (!k) rs.error('kind', 'KIND_UNKNOWN', `"${kindText}" kalem türü değil (Mal ya da Hizmet)`);
        else kind = k;
      }

      const unitText = cellOf(row, 'unit');
      let unit: ItemUnit = 'adet';
      if (unitText !== '') {
        const u = UNIT_WORDS[foldKey(unitText)];
        if (!u) rs.error('unit', 'UNIT_UNKNOWN', `"${unitText}" tanınan bir birim değil (${ITEM_UNITS.map((x) => ITEM_UNIT_LABELS[x]).join(', ')})`);
        else unit = u;
      }

      const code = cellOf(row, 'code');
      if (code !== '' && (code.length > 30 || !CODE_RE.test(code))) {
        rs.error('code', 'CODE_INVALID', 'Kod en çok 30 karakter; yalnızca harf, rakam ve . _ / - içerebilir');
      }
      const barcode = cellOf(row, 'barcode');
      if (barcode.length > 40) rs.error('barcode', 'BARCODE_TOO_LONG', 'Barkod en çok 40 karakter olabilir');

      // KDV: kod ("KDV-16") ya da oran ("16", "%16")
      const vatText = cellOf(row, 'vatCode');
      let vatCode: string | undefined;
      if (vatText !== '') {
        const byCode = vatByFold.get(foldKey(vatText));
        if (byCode) vatCode = byCode;
        else {
          const numeric = parseDecimal(vatText.replace(/[%\s]|kdv/gi, ''), 'auto', { maxDp: 4 });
          const codes = numeric.ok ? vatByRate.get(dec(numeric.value).toFixed()) : undefined;
          if (codes?.size === 1) vatCode = [...codes][0];
          else if (codes && codes.size > 1) rs.error('vatCode', 'VAT_AMBIGUOUS', `%${numeric.ok ? numeric.value : vatText} oranı birden çok KDV koduna karşılık geliyor; kodu yazın`);
          else rs.error('vatCode', 'VAT_CODE_UNKNOWN', `"${vatText}" tanımlı bir KDV kodu ya da oranı değil (Ayarlar > KDV oranları)`);
        }
      }

      const price = (key: 'purchasePrice' | 'salePrice', label: string): string | undefined => {
        const text = cellOf(row, key);
        if (text === '') return undefined;
        const p = parseDecimal(text, opts.numberFormat, { maxDp: 6 });
        if (!p.ok) {
          rs.error(key, p.code, `${label}: ${p.message}`);
          return undefined;
        }
        return p.value;
      };
      const purchasePrice = price('purchasePrice', 'Alış fiyatı');
      const salePrice = price('salePrice', 'Satış fiyatı');

      const currency = (key: 'purchaseCurrency' | 'saleCurrency', label: string): string => {
        const text = cellOf(row, key);
        if (text === '') return 'TRY';
        const c = parseCurrency(text);
        if (!c) {
          rs.error(key, 'CURRENCY_UNKNOWN', `${label}: "${text}" desteklenen bir para birimi değil (TRY, GBP, EUR, USD)`);
          return 'TRY';
        }
        return c;
      };
      const purchaseCurrency = currency('purchaseCurrency', 'Alış para birimi');
      const saleCurrency = currency('saleCurrency', 'Satış para birimi');

      const minText = cellOf(row, 'minLevel');
      let minLevel: string | undefined;
      if (minText !== '') {
        const m = parseDecimal(minText, opts.numberFormat, { maxDp: 4 });
        if (!m.ok) rs.error('minLevel', m.code, `Kritik seviye: ${m.message}`);
        else minLevel = m.value;
      }
      if (cellOf(row, 'notes').length > 1000) rs.error('notes', 'TOO_LONG', 'Not en çok 1000 karakter olabilir');

      // Kategori: mevcut (harf/aksan duyarsız) ya da yeni
      const categoryText = cellOf(row, 'category');
      let categoryKey: string | null = null;
      if (categoryText !== '') {
        if (categoryText.length < 2 || categoryText.length > 80) rs.error('category', 'CATEGORY_INVALID', 'Kategori adı 2-80 karakter olmalı');
        else {
          categoryKey = foldKey(categoryText);
          if (!categoryByKey.has(categoryKey) && !newCategories.has(categoryKey)) newCategories.set(categoryKey, categoryText);
        }
      }

      const duplicate = (field: string, message: string) => {
        if (opts.skipDuplicates) rs.skip('DUPLICATE', `${message}; atlandı`);
        else rs.error(field, 'DUPLICATE', message);
      };
      if (code !== '' && rs.status !== 'error') {
        const key = code.toLowerCase();
        if (takenCodes.has(key)) duplicate('code', `${code} kodlu stok kartı zaten var`);
        else if (seenCodes.has(key)) duplicate('code', `${code} kodu dosyada daha önce geçiyor`);
        else seenCodes.add(key);
      }
      if (barcode !== '' && rs.ok) {
        const key = barcode.toLowerCase();
        if (takenBarcodes.has(key)) duplicate('barcode', `${barcode} barkodu başka bir kartta kayıtlı`);
        else if (seenBarcodes.has(key)) duplicate('barcode', `${barcode} barkodu dosyada daha önce geçiyor`);
        else seenBarcodes.add(key);
      }

      if (rs.ok) {
        const input = {
          code: code === '' ? undefined : code,
          name,
          kind,
          unit,
          barcode: barcode || undefined,
          vatCode,
          purchasePrice,
          purchaseCurrency,
          salePrice,
          saleCurrency,
          minLevel,
          notes: cellOf(row, 'notes') || undefined,
        };
        const parsed = createItemSchema.safeParse(input);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) rs.error(String(issue.path[0] ?? ''), 'INVALID', `Geçersiz değer: ${issue.message}`);
        } else {
          if (parsed.data.code) explicitCodes.add(parsed.data.code);
          planned.push({ state: rs, input: parsed.data, categoryKey });
        }
      }
    }

    // Yeni kategori yalnızca en az bir geçerli satır kullanıyorsa oluşur
    const usedNew = new Map([...newCategories].filter(([key]) => planned.some((p) => p.categoryKey === key)));
    const skipped = states.filter((s) => s.status === 'skip').length;
    return {
      rows: states.map((s) => s.preview()),
      general: [],
      summary: [
        { label: 'Oluşturulacak stok kartı', value: String(planned.length) },
        { label: 'Yeni kategori', value: usedNew.size > 0 ? [...usedNew.values()].join(', ') : '0' },
        { label: 'Atlanacak satır', value: String(skipped) },
      ],
      apply: async () => {
        const categoryIds = new Map([...categoryByKey].map(([k, c]) => [k, c.id]));
        for (const [key, name] of usedNew) {
          const created = await createCategory(tx, company.id, { name });
          categoryIds.set(key, created.id);
        }
        const taken = new Set([...explicitCodes, ...existing.map((i) => i.code)]);
        for (const p of planned) {
          await createItem(tx, company.id, { ...p.input, categoryId: p.categoryKey ? categoryIds.get(p.categoryKey) : undefined }, taken);
        }
        return {
          created: planned.length,
          skipped,
          summary: [
            { label: 'Oluşturulan stok kartı', value: String(planned.length) },
            { label: 'Oluşturulan kategori', value: String(usedNew.size) },
          ],
          entries: [],
        };
      },
    };
  },
};
