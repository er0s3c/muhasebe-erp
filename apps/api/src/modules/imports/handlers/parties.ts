import {
  CURRENCY_CODES,
  type CurrencyCode,
  createPartySchema,
  partiesImportOptionsSchema,
  type CreatePartyInput,
  type ImportRow,
  type PartyKind,
} from '@erp/shared';
import { parties } from '../../../db/schema';
import { createParty } from '../../parties/service';
import { foldKey, parseDecimal, parseInteger } from '../values';
import { CODE_RE, EMAIL_RE, RowState, cellOf, type ImportCtx, type ImportHandler, type PlanResult } from './common';

const KIND_WORDS: Record<string, PartyKind> = {
  musteri: 'customer',
  alici: 'customer',
  customer: 'customer',
  tedarikci: 'supplier',
  satici: 'supplier',
  supplier: 'supplier',
  herikisi: 'both',
  heriki: 'both',
  ikisi: 'both',
  both: 'both',
  musteritedarikci: 'both',
};

const CURRENCY_WORDS: Record<string, string> = { tl: 'TRY', try: 'TRY', gbp: 'GBP', eur: 'EUR', usd: 'USD', sterlin: 'GBP', euro: 'EUR', dolar: 'USD' };

export function parseCurrency(text: string): CurrencyCode | null {
  if (text === '') return null;
  const key = foldKey(text);
  const mapped = CURRENCY_WORDS[key] ?? key.toUpperCase();
  return (CURRENCY_CODES as readonly string[]).includes(mapped) ? (mapped as CurrencyCode) : null;
}

interface Planned {
  state: RowState;
  input: CreatePartyInput;
}

/** Cari kartları: mevcut kod / vergi no → atla (ya da hata); kod boşsa doğrulamadan sonra otomatik verilir. */
export const partiesHandler: ImportHandler = {
  kind: 'parties',
  module: 'core.parties',
  permission: 'parties.manage',

  async plan(ctx: ImportCtx, rows: ImportRow[], rawOptions): Promise<PlanResult> {
    const opts = partiesImportOptionsSchema.parse(rawOptions);
    const { tx, company } = ctx;

    const existing = await tx.select({ code: parties.code, name: parties.name, taxNumber: parties.taxNumber }).from(parties);
    const takenCodes = new Set(existing.map((p) => p.code.toLowerCase()));
    const takenTax = new Set(existing.filter((p) => p.taxNumber).map((p) => p.taxNumber!.replace(/\s/g, '').toLowerCase()));
    const knownNames = new Set(existing.map((p) => foldKey(p.name)));

    const states: RowState[] = [];
    const planned: Planned[] = [];
    const seenCodes = new Set<string>();
    const seenTax = new Set<string>();
    /** Dosyadaki açık kodlar: otomatik kod üretimi bunları atlar. */
    const explicitCodes = new Set<string>();

    for (const row of rows) {
      const name = cellOf(row, 'name');
      const rs = new RowState(row.row, name);
      states.push(rs);

      if (name.length < 2) rs.error('name', 'NAME_REQUIRED', 'Ünvan en az 2 karakter olmalı');
      else if (name.length > 160) rs.error('name', 'NAME_TOO_LONG', 'Ünvan en çok 160 karakter olabilir');

      const kindText = cellOf(row, 'kind');
      let kind: PartyKind = 'customer';
      if (kindText !== '') {
        const k = KIND_WORDS[foldKey(kindText)];
        if (!k) rs.error('kind', 'KIND_UNKNOWN', `"${kindText}" cari türü değil (Müşteri, Tedarikçi ya da Her ikisi)`);
        else kind = k;
      }

      const code = cellOf(row, 'code');
      if (code !== '') {
        if (code.length > 30 || !CODE_RE.test(code)) rs.error('code', 'CODE_INVALID', 'Kod en çok 30 karakter; yalnızca harf, rakam ve . _ / - içerebilir');
      }

      const email = cellOf(row, 'email');
      if (email !== '' && (email.length > 254 || !EMAIL_RE.test(email))) rs.error('email', 'EMAIL_INVALID', `"${email}" geçerli bir e-posta adresi değil`);

      const currencyText = cellOf(row, 'currencyCode');
      const currency = currencyText === '' ? 'TRY' : parseCurrency(currencyText);
      if (!currency) rs.error('currencyCode', 'CURRENCY_UNKNOWN', `"${currencyText}" desteklenen bir para birimi değil (TRY, GBP, EUR, USD)`);

      const termText = cellOf(row, 'paymentTermDays');
      let paymentTermDays = 0;
      if (termText !== '') {
        const t = parseInteger(termText, 0, 365);
        if (!t.ok) rs.error('paymentTermDays', t.code, `Vade: ${t.message}`);
        else paymentTermDays = t.value;
      }

      const limitText = cellOf(row, 'creditLimit');
      let creditLimit: string | undefined;
      if (limitText !== '') {
        const l = parseDecimal(limitText, opts.numberFormat, { maxDp: 4 });
        if (!l.ok) rs.error('creditLimit', l.code, `Kredi limiti: ${l.message}`);
        else creditLimit = l.value;
      }

      for (const [key, max, label] of [
        ['taxNumber', 40, 'Vergi no'],
        ['taxOffice', 120, 'Vergi dairesi'],
        ['phone', 40, 'Telefon'],
        ['address', 300, 'Adres'],
        ['notes', 1000, 'Not'],
      ] as const) {
        if (cellOf(row, key).length > max) rs.error(key, 'TOO_LONG', `${label} en çok ${max} karakter olabilir`);
      }

      // Yinelenenler: mevcut kayıt ya da dosyada daha önce geçen
      const taxNumber = cellOf(row, 'taxNumber').replace(/\s/g, '').toLowerCase();
      const duplicate = (field: string, message: string) => {
        if (opts.skipDuplicates) rs.skip('DUPLICATE', `${message}; atlandı`);
        else rs.error(field, 'DUPLICATE', message);
      };
      if (code !== '' && rs.status !== 'error') {
        const key = code.toLowerCase();
        if (takenCodes.has(key)) duplicate('code', `${code} kodlu cari zaten var`);
        else if (seenCodes.has(key)) duplicate('code', `${code} kodu dosyada daha önce geçiyor`);
        else seenCodes.add(key);
      }
      if (taxNumber !== '' && rs.ok) {
        if (takenTax.has(taxNumber)) duplicate('taxNumber', `${cellOf(row, 'taxNumber')} vergi numaralı cari zaten var`);
        else if (seenTax.has(taxNumber)) duplicate('taxNumber', `${cellOf(row, 'taxNumber')} vergi numarası dosyada daha önce geçiyor`);
        else seenTax.add(taxNumber);
      }
      if (rs.ok && name !== '' && knownNames.has(foldKey(name))) {
        rs.warn('name', 'SAME_NAME', 'Aynı ünvanda başka bir cari var (farklı kodla oluşturulacak)');
      }

      if (rs.ok) {
        const input = {
          code: code === '' ? undefined : code,
          name,
          kind,
          taxNumber: cellOf(row, 'taxNumber') || undefined,
          taxOffice: cellOf(row, 'taxOffice') || undefined,
          phone: cellOf(row, 'phone') || undefined,
          email: email || undefined,
          address: cellOf(row, 'address') || undefined,
          currencyCode: currency!,
          creditLimit,
          paymentTermDays,
          notes: cellOf(row, 'notes') || undefined,
        };
        // Yukarıdaki denetimler Türkçe iletilidir; şema yalnızca güvenlik ağıdır
        const parsed = createPartySchema.safeParse(input);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) rs.error(String(issue.path[0] ?? ''), 'INVALID', `Geçersiz değer: ${issue.message}`);
        } else {
          if (parsed.data.code) explicitCodes.add(parsed.data.code);
          planned.push({ state: rs, input: parsed.data });
        }
      }
    }

    const okCount = planned.length;
    const skipped = states.filter((s) => s.status === 'skip').length;
    return {
      rows: states.map((s) => s.preview()),
      general: [],
      summary: [
        { label: 'Oluşturulacak cari', value: String(okCount) },
        { label: 'Atlanacak satır', value: String(skipped) },
      ],
      apply: async () => {
        // Açık kodlu satırlar dosya sırasıyla, kodsuzlar otomatik numarayla oluşur; çakışan numara atlanır
        const taken = new Set([...explicitCodes, ...existing.map((p) => p.code)]);
        for (const p of planned) await createParty(tx, company.id, p.input, taken);
        return { created: okCount, skipped, summary: [{ label: 'Oluşturulan cari', value: String(okCount) }], entries: [] };
      },
    };
  },
};
