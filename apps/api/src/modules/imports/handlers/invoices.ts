import {
  INVOICE_TYPE_META,
  dec,
  invoicesImportOptionsSchema,
  partyKindFits,
  type CreateInvoiceInput,
  type ImportRow,
  type ImportUnmatched,
  type InvoiceSide,
  type PartyKind,
} from '@erp/shared';
import { and, inArray, ne, sql } from 'drizzle-orm';
import { invoices, items, parties, taxRates } from '../../../db/schema';
import { AppError } from '../../../http/errors';
import { createInvoiceDraft, prepareLines } from '../../invoices/service';
import { foldKey, parseDate, parseDecimal } from '../values';
import { UNIT_WORDS } from './items';
import { parseCurrency } from './parties';
import { RowState, cellOf, type ImportCtx, type ImportHandler, type PlanResult } from './common';

type ItemRow = typeof items.$inferSelect;
type PartyRow = typeof parties.$inferSelect;

interface DocLine {
  state: RowState;
  item: ItemRow | null;
  description: string;
  quantity: string;
  unit: CreateInvoiceInput['lines'][number]['unit'];
  unitPrice: string;
  discountPct: string;
  vatCode: string | null;
}

interface Head {
  docNo: string;
  date: string;
  party: string;
  tax: string;
  due: string;
  currency: string;
  fx: string;
  description: string;
}

interface Doc {
  key: string;
  docNo: string;
  date: string | null;
  dueDate: string | null;
  party: PartyRow | null;
  currency: string | null;
  fxRate: string | null;
  description: string | null;
  first: RowState;
  lines: DocLine[];
  duplicate: { invoiceNo: string | null } | null;
}

const MAX_CANDIDATES = 8;

/** Eşleşmeyen metne benzer adlar: ortak sözcük sayısına göre (öneri; kullanıcı seçer). */
function suggest<T extends { id: string }>(text: string, all: readonly T[], labelOf: (t: T) => string): ImportUnmatched['candidates'] {
  const words = text.toLocaleLowerCase('tr-TR').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const scored = all
    .map((t) => {
      const label = labelOf(t).toLocaleLowerCase('tr-TR');
      return { t, score: words.filter((w) => label.includes(w)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
  return scored.map((s) => ({ id: s.t.id, label: labelOf(s.t) }));
}

/**
 * Fatura içe aktarma (X2): düz tablo, satır = fatura kalemi, aynı belge numarası (ve cari) tek faturada toplanır. Faturalar TASLAK
 * yazılır (kayıt, yevmiye ve stok hareketi fatura ekranından); doğrulama fatura servisinin kendi kurallarıyla (`prepareLines`) yapılır.
 * Cari: vergi no, kod ya da tam ünvan; stok: kod, barkod ya da tam ad; eşleşmeyenler arayüzde elle eşlenir (partyMap/itemMap).
 * KDV: Ayarlar > KDV oranları kodu ya da oran; kodda sabit oran yoktur. Mükerrer: aynı cari + belge no'lu mevcut fatura.
 */
function invoicesHandler(side: InvoiceSide): ImportHandler {
  const kind = side === 'sales' ? 'sales_invoices' : 'purchase_invoices';
  const type = side === 'sales' ? 'sales' : 'purchase';
  const control = INVOICE_TYPE_META[type].control;
  return {
    kind,
    module: 'core.invoices',
    permission: 'invoices.manage',

    async plan(ctx: ImportCtx, rows: ImportRow[], rawOptions): Promise<PlanResult> {
      const opts = invoicesImportOptionsSchema.parse(rawOptions);
      const { tx, company } = ctx;

      const partyRows = await tx.select().from(parties);
      const itemRows = await tx.select().from(items);
      const rateRows = await tx.select().from(taxRates);
      const partyById = new Map(partyRows.map((p) => [p.id, p]));
      const itemById = new Map(itemRows.map((i) => [i.id, i]));
      const partyByCode = new Map(partyRows.map((p) => [p.code.toLowerCase(), p]));
      const partyByTax = new Map<string, PartyRow[]>();
      for (const p of partyRows) {
        if (!p.taxNumber) continue;
        const k = p.taxNumber.replace(/\s/g, '');
        partyByTax.set(k, [...(partyByTax.get(k) ?? []), p]);
      }
      const partyByName = new Map<string, PartyRow[]>();
      for (const p of partyRows) partyByName.set(foldKey(p.name), [...(partyByName.get(foldKey(p.name)) ?? []), p]);
      const itemByCode = new Map(itemRows.map((i) => [i.code.toLowerCase(), i]));
      const itemByBarcode = new Map(itemRows.filter((i) => i.barcode).map((i) => [i.barcode!.toLowerCase(), i]));
      const itemByName = new Map<string, ItemRow[]>();
      for (const i of itemRows) itemByName.set(foldKey(i.name), [...(itemByName.get(foldKey(i.name)) ?? []), i]);

      const existing = await tx
        .select({ partyId: invoices.partyId, externalNo: invoices.externalNo, invoiceNo: invoices.invoiceNo })
        .from(invoices)
        .where(and(inArray(invoices.type, [type]), ne(invoices.status, 'cancelled'), sql`${invoices.externalNo} is not null`));
      const existingKey = new Map(existing.map((e) => [`${e.partyId}|${foldKey(e.externalNo!)}`, e.invoiceNo]));

      const states: RowState[] = [];
      const docs = new Map<string, Doc>();
      const unmatchedParty = new Map<string, { text: string; rows: number }>();
      const unmatchedItem = new Map<string, { text: string; rows: number }>();
      let prev: Head | null = null;

      for (const row of rows) {
        const docNo = cellOf(row, 'docNo');
        const rs = new RowState(row.row, docNo);
        states.push(rs);
        if (docNo === '') {
          rs.error('docNo', 'DOC_NO_REQUIRED', 'Belge no boş');
          continue;
        }
        if (docNo.length > 40) rs.error('docNo', 'DOC_NO_TOO_LONG', 'Belge no en çok 40 karakter olabilir');

        // Aynı belgenin devam satırlarında üst bilgi boş bırakılabilir: önceki satırdan taşınır
        const same = prev?.docNo === docNo;
        const pick = (k: string, p: string | undefined) => cellOf(row, k) || (same ? (p ?? '') : '');
        const head: Head = {
          docNo,
          date: pick('date', prev?.date),
          party: pick('party', prev?.party),
          tax: pick('taxNumber', prev?.tax),
          due: pick('dueDate', prev?.due),
          currency: pick('currencyCode', prev?.currency),
          fx: pick('fxRate', prev?.fx),
          description: pick('description', prev?.description),
        };
        prev = head;

        // --- Cari ---
        let party: PartyRow | null = null;
        const partyText = head.party || head.tax;
        if (partyText === '') rs.error('party', 'PARTY_REQUIRED', 'Cari (kod, vergi no ya da ünvan) boş');
        else {
          const mapped = opts.partyMap[partyText];
          if (mapped) {
            party = partyById.get(mapped) ?? null;
            if (!party) rs.error('party', 'PARTY_NOT_FOUND', 'Seçilen cari bulunamadı');
          } else {
            const byTax = head.tax ? (partyByTax.get(head.tax.replace(/\s/g, '')) ?? []) : [];
            if (byTax.length === 1) party = byTax[0]!;
            else if (byTax.length > 1) rs.error('taxNumber', 'PARTY_AMBIGUOUS', `${head.tax} vergi numaralı birden çok cari var; cari kodunu yazın`);
            else {
              party = partyByCode.get(head.party.toLowerCase()) ?? null;
              if (!party) {
                const named = partyByName.get(foldKey(head.party)) ?? [];
                if (named.length === 1) party = named[0]!;
                else if (named.length > 1) rs.error('party', 'PARTY_AMBIGUOUS', `"${head.party}" ünvanlı birden çok cari var; cari kodunu ya da vergi numarasını yazın`);
              }
            }
            if (!party && rs.ok) {
              const u = unmatchedParty.get(partyText) ?? { text: partyText, rows: 0 };
              u.rows++;
              unmatchedParty.set(partyText, u);
              rs.error('party', 'PARTY_NOT_FOUND', `"${partyText}" carisi bulunamadı (eşleştirin ya da önce cari kartını içe aktarın)`);
            }
          }
        }
        if (party) {
          rs.label = `${docNo} · ${party.name}`;
          if (!party.isActive) rs.error('party', 'PARTY_INACTIVE', `${party.name} carisi pasif`);
          else if (!partyKindFits(party.kind as PartyKind, control)) {
            rs.error('party', 'PARTY_KIND_MISMATCH', `${party.name} carisi bu fatura türüyle uyumlu değil (${side === 'sales' ? 'müşteri' : 'tedarikçi'} olmalı)`);
          }
        }

        // --- Üst bilgi alanları ---
        let date: string | null = null;
        if (head.date === '') rs.error('date', 'DATE_REQUIRED', 'Fatura tarihi boş');
        else {
          const d = parseDate(head.date);
          if (!d.ok) rs.error('date', d.code, `Fatura tarihi: ${d.message}`);
          else date = d.value;
        }
        let dueDate: string | null = null;
        if (head.due !== '') {
          const d = parseDate(head.due);
          if (!d.ok) rs.error('dueDate', d.code, `Vade tarihi: ${d.message}`);
          else if (date && d.value < date) rs.error('dueDate', 'DUE_BEFORE_DATE', 'Vade tarihi fatura tarihinden önce olamaz');
          else dueDate = d.value;
        }
        let currency: string | null = null;
        if (head.currency !== '') {
          const c = parseCurrency(head.currency);
          if (!c) rs.error('currencyCode', 'CURRENCY_UNKNOWN', `"${head.currency}" desteklenen bir para birimi değil (TRY, GBP, EUR, USD)`);
          else currency = c;
        }
        let fxRate: string | null = null;
        if (head.fx !== '') {
          const p = parseDecimal(head.fx, opts.numberFormat, { maxDp: 8 });
          if (!p.ok) rs.error('fxRate', p.code, `Kur: ${p.message}`);
          else if (dec(p.value).lte(0)) rs.error('fxRate', 'FX_RATE_INVALID', 'Kur sıfırdan büyük olmalı');
          else fxRate = p.value;
        }
        if (head.description.length > 300) rs.error('description', 'TOO_LONG', 'Fatura açıklaması en çok 300 karakter olabilir');

        // --- Kalem ---
        let item: ItemRow | null = null;
        const itemText = cellOf(row, 'item');
        if (itemText !== '') {
          const mapped = opts.itemMap[itemText];
          if (mapped) {
            item = itemById.get(mapped) ?? null;
            if (!item) rs.error('item', 'ITEM_NOT_FOUND', 'Seçilen stok kartı bulunamadı');
          } else {
            item = itemByCode.get(itemText.toLowerCase()) ?? itemByBarcode.get(itemText.toLowerCase()) ?? null;
            if (!item) {
              const named = itemByName.get(foldKey(itemText)) ?? [];
              if (named.length === 1) item = named[0]!;
              else if (named.length > 1) rs.error('item', 'ITEM_AMBIGUOUS', `"${itemText}" adlı birden çok stok kartı var; stok kodunu yazın`);
              else {
                const u = unmatchedItem.get(itemText) ?? { text: itemText, rows: 0 };
                u.rows++;
                unmatchedItem.set(itemText, u);
                rs.error('item', 'ITEM_NOT_FOUND', `"${itemText}" stok kartı bulunamadı (eşleştirin ya da önce stok kartını içe aktarın)`);
              }
            }
          }
        }
        let description = cellOf(row, 'lineDescription');
        if (description === '' && item) description = item.name;
        if (description === '' && rs.ok) rs.error('lineDescription', 'DESCRIPTION_REQUIRED', 'Stok kartı yoksa kalem açıklaması gerekli');
        if (description.length > 300) rs.error('lineDescription', 'TOO_LONG', 'Kalem açıklaması en çok 300 karakter olabilir');

        const num = (key: string, label: string, maxDp: number, allowEmpty = false): string | null => {
          const text = cellOf(row, key);
          if (text === '') {
            if (!allowEmpty) rs.error(key, 'NUMBER_REQUIRED', `${label} boş`);
            return null;
          }
          const p = parseDecimal(text, opts.numberFormat, { maxDp });
          if (!p.ok) {
            rs.error(key, p.code, `${label}: ${p.message}`);
            return null;
          }
          return p.value;
        };
        const quantity = num('quantity', 'Miktar', 4);
        if (quantity !== null && dec(quantity).lte(0)) rs.error('quantity', 'QUANTITY_INVALID', 'Miktar sıfırdan büyük olmalı');
        const unitPrice = num('unitPrice', 'Birim fiyat', 6);
        const discountPct = num('discountPct', 'İskonto', 4, true) ?? '0';
        if (dec(discountPct).lt(0) || dec(discountPct).gt(100)) rs.error('discountPct', 'DISCOUNT_INVALID', 'İskonto 0 ile 100 arasında olmalı');

        const unitText = cellOf(row, 'unit');
        let unit: DocLine['unit'] = null;
        if (unitText !== '') {
          const u = UNIT_WORDS[foldKey(unitText)];
          if (!u) rs.error('unit', 'UNIT_UNKNOWN', `"${unitText}" tanınan bir birim değil`);
          else unit = u;
        }

        // KDV: kod ya da oran; fatura tarihinde geçerli olan kayıtlarla eşlenir. Boşsa kartın KDV kodu.
        let vatCode: string | null = null;
        const vatText = cellOf(row, 'vatCode');
        if (vatText !== '' && date) {
          const valid = rateRows.filter((r) => r.validFrom <= date! && (!r.validTo || r.validTo >= date!));
          const byCode = valid.find((r) => foldKey(r.code) === foldKey(vatText));
          if (byCode) vatCode = byCode.code;
          else {
            const numeric = parseDecimal(vatText.replace(/[%\s]|kdv/gi, ''), 'auto', { maxDp: 4 });
            const hits = numeric.ok ? [...new Set(valid.filter((r) => dec(r.rate).eq(numeric.value)).map((r) => r.code))] : [];
            if (hits.length === 1) vatCode = hits[0]!;
            else if (hits.length > 1) rs.error('vatCode', 'VAT_AMBIGUOUS', `%${vatText} oranı birden çok KDV koduna karşılık geliyor; kodu yazın`);
            else rs.error('vatCode', 'VAT_CODE_UNKNOWN', `"${vatText}" ${date} tarihinde geçerli bir KDV kodu ya da oranı değil (Ayarlar > KDV oranları)`);
          }
        } else if (item?.vatCode) vatCode = item.vatCode;

        // --- Belgeye ekle ---
        const key = `${docNo.toLowerCase()}|${party?.id ?? foldKey(partyText)}`;
        let doc = docs.get(key);
        if (!doc) {
          const dupNo = party ? existingKey.get(`${party.id}|${foldKey(docNo)}`) : undefined;
          doc = { key, docNo, date, dueDate, party, currency, fxRate, description: head.description || null, first: rs, lines: [], duplicate: dupNo !== undefined ? { invoiceNo: dupNo } : null };
          docs.set(key, doc);
        } else {
          if (date && doc.date && date !== doc.date) rs.error('date', 'HEADER_CONFLICT', `Aynı belgenin satırlarında fatura tarihi farklı (${doc.date})`);
          if (currency && doc.currency && currency !== doc.currency) rs.error('currencyCode', 'HEADER_CONFLICT', 'Aynı belgenin satırlarında para birimi farklı');
        }
        if (quantity !== null && unitPrice !== null) {
          doc.lines.push({ state: rs, item, description: description.slice(0, 300), quantity, unit, unitPrice, discountPct, vatCode });
        }
      }

      // --- Belge düzeyi doğrulama: mükerrer, satır sınırı, fatura servisi kuralları ---
      const general: PlanResult['general'] = [];
      const valid: { doc: Doc; input: CreateInvoiceInput }[] = [];
      let net = dec(0);
      let gross = dec(0);
      for (const doc of docs.values()) {
        const rowsOfDoc = doc.lines.map((l) => l.state);
        const all = rowsOfDoc.length ? rowsOfDoc : [doc.first];
        if (doc.duplicate) {
          const msg = `${doc.party?.name ?? ''} carisinde ${doc.docNo} numaralı fatura zaten var${doc.duplicate.invoiceNo ? ` (${doc.duplicate.invoiceNo})` : ''}`;
          if (opts.skipDuplicates) for (const s of all) s.skip('DUPLICATE', `${msg}; atlandı`);
          else doc.first.error('docNo', 'DUPLICATE', msg);
          continue;
        }
        if (doc.lines.length > 300) {
          doc.first.error('docNo', 'TOO_MANY_LINES', 'Bir faturada en çok 300 kalem olabilir');
          continue;
        }
        if (all.some((s) => s.status === 'error') || !doc.party || !doc.date) continue;
        const input: CreateInvoiceInput = {
          type,
          partyId: doc.party.id,
          invoiceDate: doc.date,
          dueDate: doc.dueDate ?? undefined,
          externalNo: doc.docNo,
          currency: (doc.currency ?? doc.party.currencyCode) as CreateInvoiceInput['currency'],
          fxRate: doc.fxRate ?? undefined,
          vatIncluded: opts.vatIncluded,
          description: doc.description ?? undefined,
          lines: doc.lines.map((l) => ({
            itemId: l.item?.id ?? null,
            description: l.description,
            quantity: l.quantity,
            unit: l.unit,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
            vatCode: l.vatCode,
          })),
          post: false,
        };
        try {
          const prepared = await prepareLines(tx, type, doc.date, input.lines, input.vatIncluded, company.id);
          net = net.plus(prepared.totals.net);
          gross = gross.plus(prepared.totals.gross);
          valid.push({ doc, input });
        } catch (e) {
          if (e instanceof AppError) {
            // "Satır n" iletisinden ilgili dosya satırını bul
            const m = /^Satır (\d+):/.exec(e.message);
            const target = m ? (doc.lines[Number(m[1]) - 1]?.state ?? doc.first) : doc.first;
            target.error(undefined, e.code, e.message);
          } else throw e;
        }
      }

      const unmatched: ImportUnmatched[] = [
        ...[...unmatchedParty.values()].map((u) => ({ field: 'party' as const, text: u.text, rows: u.rows, candidates: suggest(u.text, partyRows, (p) => `${p.code} ${p.name}`) })),
        ...[...unmatchedItem.values()].map((u) => ({ field: 'item' as const, text: u.text, rows: u.rows, candidates: suggest(u.text, itemRows, (i) => `${i.code} ${i.name}`) })),
      ];

      const duplicates = [...docs.values()].filter((d) => d.duplicate).length;
      return {
        rows: states.map((s) => s.preview()),
        general,
        unmatched,
        summary: [
          { label: 'Oluşacak taslak fatura', value: String(valid.length) },
          { label: 'Fatura kalemi', value: String(valid.reduce((s, v) => s + v.input.lines.length, 0)) },
          { label: 'Toplam (KDV hariç, para birimleri karışık olabilir)', value: net.toFixed(2) },
          { label: 'Toplam (KDV dahil, para birimleri karışık olabilir)', value: gross.toFixed(2) },
          { label: 'Mükerrer (atlanacak) fatura', value: String(duplicates) },
        ],
        apply: async () => {
          const entries: { type: 'invoice'; id: string; no: string }[] = [];
          for (const { doc, input } of valid) {
            const id = await createInvoiceDraft(tx, { companyId: company.id, userId: ctx.userId, baseCurrency: company.baseCurrency, reportingCurrency: company.reportingCurrency, allowNegativeStock: company.allowNegativeStock }, input);
            entries.push({ type: 'invoice', id, no: doc.docNo });
          }
          return {
            created: entries.length,
            skipped: duplicates,
            summary: [{ label: 'Taslak fatura', value: String(entries.length) }, { label: 'Durum', value: 'Taslak (fatura ekranından kaydedin)' }],
            entries,
          };
        },
      };
    },
  };
}

export const salesInvoicesHandler = invoicesHandler('sales');
export const purchaseInvoicesHandler = invoicesHandler('purchases');
