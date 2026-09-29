import {
  applyRate,
  type CurrencyCode,
  dec,
  formatTR,
  partyOpeningsOptionsSchema,
  sum,
  toDbRate,
  type ImportMessage,
  type ImportRow,
  type MoneyValue,
  type PartyKind,
} from '@erp/shared';
import { parties } from '../../../db/schema';
import { createJournalEntry, type AutoJournalLine } from '../../ledger/journal';
import { loadMappings } from '../../ledger/mappings';
import { foldKey, parseDate, parseDecimal } from '../values';
import { RowState, cellOf, ledgerCtxOf, money, type ImportCtx, type ImportHandler, type PlanResult } from './common';
import { fxResolver, periodProblem, resolveOffsetAccount } from './openings-common';
import { parseCurrency } from './parties';

const DEBIT_WORDS = new Set(['borc', 'b', 'd', 'debit', 'bizeborclu']);
const CREDIT_WORDS = new Set(['alacak', 'a', 'c', 'credit', 'bizborcluyuz']);

interface PartyRow {
  id: string;
  code: string;
  name: string;
  kind: PartyKind;
  isActive: boolean;
  currencyCode: CurrencyCode;
}

interface Planned {
  line: AutoJournalLine;
  debitBase: MoneyValue;
  creditBase: MoneyValue;
}

/**
 * Cari açılış bakiyeleri: tek açılış yevmiyesi. Cari türüne göre 120 (müşteri) ya da 320 (tedarikçi) kontrol hesabı;
 * her ikisi türünde borç → 120, alacak → 320. Fark, açılış karşı hesabına (varsayılan 500) tek satır olarak yazılır.
 * Yevmiye kaynaksızdır: yanlış yükleme normal ters kayıtla düzeltilebilir.
 */
export const partyOpeningsHandler: ImportHandler = {
  kind: 'party_openings',
  module: 'core.ledger',
  permission: 'ledger.post',

  async plan(ctx: ImportCtx, rows: ImportRow[], rawOptions): Promise<PlanResult> {
    const opts = partyOpeningsOptionsSchema.parse(rawOptions);
    const { tx, company } = ctx;
    const base = company.baseCurrency as CurrencyCode;
    const general: ImportMessage[] = [];

    const problem = await periodProblem(tx, opts.openingDate);
    if (problem) general.push(problem);
    const offset = await resolveOffsetAccount(tx, opts.offsetAccountId, general);
    const maps = await loadMappings(tx);
    const receivable = maps.get('receivable');
    const payable = maps.get('payable');
    if (!receivable || !payable) {
      general.push({ severity: 'error', code: 'ACCOUNT_MAPPING_MISSING', message: 'Alıcılar (120) ve Satıcılar (320) hesap eşlemesi eksik. Ayarlar > Hesap eşlemesi bölümünden tanımlayın' });
    }

    const partyRows = (await tx.select().from(parties)) as PartyRow[];
    const byCode = new Map(partyRows.map((p) => [p.code.toLowerCase(), p]));
    const byName = new Map<string, PartyRow[]>();
    for (const p of partyRows) byName.set(foldKey(p.name), [...(byName.get(foldKey(p.name)) ?? []), p]);
    const fx = fxResolver(tx, base, opts.openingDate, opts.numberFormat);

    const states: RowState[] = [];
    const planned: Planned[] = [];
    const seenParties = new Set<string>();

    for (const row of rows) {
      const partyText = cellOf(row, 'party');
      const rs = new RowState(row.row, partyText);
      states.push(rs);

      // Cari: kod, yoksa tam ünvan (tekil olmalı)
      let party: PartyRow | undefined;
      if (partyText === '') rs.error('party', 'PARTY_REQUIRED', 'Cari kodu ya da ünvanı boş');
      else {
        party = byCode.get(partyText.toLowerCase());
        if (!party) {
          const named = byName.get(foldKey(partyText)) ?? [];
          if (named.length === 1) party = named[0];
          else if (named.length > 1) rs.error('party', 'PARTY_AMBIGUOUS', `"${partyText}" ünvanlı birden çok cari var; cari kodunu yazın`);
          else rs.error('party', 'PARTY_NOT_FOUND', `"${partyText}" carisi bulunamadı (önce cari kartlarını içe aktarın)`);
        }
        if (party) {
          rs.label = `${party.code} ${party.name}`;
          if (!party.isActive) rs.error('party', 'PARTY_INACTIVE', `${party.name} carisi pasif`);
        }
      }

      // Tutar: Borç/Alacak sütunları ya da Tutar + Bakiye türü
      const debitText = cellOf(row, 'debit');
      const creditText = cellOf(row, 'credit');
      const amountText = cellOf(row, 'amount');
      let side: 'debit' | 'credit' | null = null;
      let amount: string | null = null;
      const number = (text: string, label: string) => {
        const p = parseDecimal(text, opts.numberFormat, { maxDp: 2 });
        if (!p.ok) {
          rs.error(label === 'Borç' ? 'debit' : label === 'Alacak' ? 'credit' : 'amount', p.code, `${label}: ${p.message}`);
          return null;
        }
        return p.value;
      };
      if (debitText !== '' || creditText !== '') {
        const d = debitText !== '' ? number(debitText, 'Borç') : '0';
        const c = creditText !== '' ? number(creditText, 'Alacak') : '0';
        if (d !== null && c !== null) {
          if (dec(d).gt(0) && dec(c).gt(0)) rs.error('debit', 'BOTH_SIDES', 'Borç ve Alacak birlikte girilemez; farkı tek sütuna yazın');
          else if (dec(d).gt(0)) [side, amount] = ['debit', d];
          else if (dec(c).gt(0)) [side, amount] = ['credit', c];
        }
        if (amountText !== '') rs.warn('amount', 'AMOUNT_IGNORED', 'Borç/Alacak sütunları dolu olduğu için Tutar sütunu yok sayıldı');
      } else if (amountText !== '') {
        const a = number(amountText, 'Tutar');
        const sideText = cellOf(row, 'side');
        const key = foldKey(sideText);
        if (sideText === '') rs.error('side', 'SIDE_REQUIRED', 'Tutar için Bakiye türü (Borç ya da Alacak) gerekli');
        else if (!DEBIT_WORDS.has(key) && !CREDIT_WORDS.has(key)) rs.error('side', 'SIDE_UNKNOWN', `"${sideText}" bakiye türü değil (Borç ya da Alacak)`);
        else if (a !== null && dec(a).gt(0)) [side, amount] = [DEBIT_WORDS.has(key) ? 'debit' : 'credit', a];
      } else {
        rs.error('debit', 'AMOUNT_REQUIRED', 'Borç/Alacak ya da Tutar girilmeli');
      }
      if (rs.ok && side === null) rs.skip('ZERO_AMOUNT', 'Tutar sıfır; atlandı');

      // Para birimi ve kur
      let currency = party?.currencyCode ?? base;
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

      let dueDate: string | undefined;
      const dueText = cellOf(row, 'dueDate');
      if (dueText !== '') {
        const d = parseDate(dueText);
        if (!d.ok) rs.error('dueDate', d.code, `Vade tarihi: ${d.message}`);
        else dueDate = d.value;
      }
      if (cellOf(row, 'description').length > 300) rs.error('description', 'TOO_LONG', 'Açıklama en çok 300 karakter olabilir');

      if (rs.ok && party && side && amount && receivable && payable) {
        // Kontrol hesabı cari türüne göre; "her ikisi" türünde işarete göre
        const useReceivable = party.kind === 'customer' ? true : party.kind === 'supplier' ? false : side === 'debit';
        const accountId = (useReceivable ? receivable : payable).id;
        const amt = dec(amount);
        const baseAmt = applyRate(amt, rate);
        if (seenParties.has(party.id)) rs.warn('party', 'PARTY_REPEATED', 'Bu cari dosyada birden çok satırda var (her satır ayrı kalem olur)');
        seenParties.add(party.id);
        planned.push({
          line: {
            accountId,
            description: cellOf(row, 'description') || 'Açılış bakiyesi',
            currency,
            debit: side === 'debit' ? money(amt) : '0',
            credit: side === 'credit' ? money(amt) : '0',
            fxRate: currency === base ? undefined : toDbRate(rate),
            partyId: party.id,
            dueDate,
          },
          debitBase: side === 'debit' ? baseAmt : dec(0),
          creditBase: side === 'credit' ? baseAmt : dec(0),
        });
      }
    }

    const debitTotal = sum(planned.map((p) => p.debitBase));
    const creditTotal = sum(planned.map((p) => p.creditBase));
    const net = debitTotal.minus(creditTotal);
    const skipped = states.filter((s) => s.status === 'skip').length;
    const offsetText = offset ? `${offset.code} ${offset.name}` : '—';

    return {
      rows: states.map((s) => s.preview()),
      general,
      summary: [
        { label: 'Açılış tarihi', value: opts.openingDate.split('-').reverse().join('.') },
        { label: 'Yevmiye satırı (cari)', value: String(planned.length) },
        { label: `Borç toplamı (${base})`, value: formatTR(debitTotal) },
        { label: `Alacak toplamı (${base})`, value: formatTR(creditTotal) },
        { label: 'Karşı hesap', value: net.isZero() ? 'gerekmiyor (dengeli)' : `${offsetText}: ${formatTR(net.abs())} ${net.gt(0) ? 'alacak' : 'borç'}` },
        { label: 'Atlanacak satır', value: String(skipped) },
      ],
      apply: async () => {
        const lines: AutoJournalLine[] = planned.map((p) => p.line);
        if (!net.isZero()) {
          lines.push({
            accountId: offset!.id,
            description: 'Açılış karşı hesabı',
            currency: base,
            debit: net.lt(0) ? money(net.abs()) : '0',
            credit: net.gt(0) ? money(net) : '0',
          });
        }
        const entry = await createJournalEntry(
          tx,
          ledgerCtxOf(ctx),
          { entryDate: opts.openingDate, description: 'Açılış bakiyeleri (cari) — içe aktarma', lines, post: true },
        );
        return {
          created: planned.length,
          skipped,
          summary: [
            { label: 'Yevmiye', value: entry.entryNo ?? '' },
            { label: 'Cari satırı', value: String(planned.length) },
          ],
          entries: [{ type: 'journal', id: entry.id, no: entry.entryNo ?? '' }],
        };
      },
    };
  },
};
