import {
  applyRate,
  type CurrencyCode,
  dec,
  formatTR,
  ledgerOpeningsOptionsSchema,
  sum,
  toDbRate,
  type ImportMessage,
  type ImportRow,
  type MoneyValue,
} from '@erp/shared';
import { accounts } from '../../../db/schema';
import { createJournalEntry, type AutoJournalLine } from '../../ledger/journal';
import { loadMappings } from '../../ledger/mappings';
import { parseDecimal } from '../values';
import { RowState, cellOf, ledgerCtxOf, money, type ImportCtx, type ImportHandler, type PlanResult } from './common';
import { fxResolver, periodProblem, resolveOffsetAccount } from './openings-common';

interface Planned {
  line: AutoJournalLine;
  debitBase: MoneyValue;
  creditBase: MoneyValue;
}

/**
 * Genel mizan açılışı: hesap kodu + borç/alacak bakiyesi → tek açılış yevmiyesi. Cari kontrol hesapları (120/320…)
 * ve stok hesapları (150–157, stok mutabakatının kapsadığı hesaplar) reddedilir: bunların bakiyesi cari/stok açılışından girilmelidir; aksi halde alt defter ile
 * hesap ayrışır ya da çift kayıt oluşur. Borç-alacak farkı seçenekle açılış karşı hesabına atılır.
 */
export const ledgerOpeningsHandler: ImportHandler = {
  kind: 'ledger_openings',
  module: 'core.ledger',
  permission: 'ledger.post',

  async plan(ctx: ImportCtx, rows: ImportRow[], rawOptions): Promise<PlanResult> {
    const opts = ledgerOpeningsOptionsSchema.parse(rawOptions);
    const { tx, company } = ctx;
    const base = company.baseCurrency as CurrencyCode;
    const general: ImportMessage[] = [];

    const problem = await periodProblem(tx, opts.openingDate);
    if (problem) general.push(problem);
    // Farkı atmayacaksak karşı hesap yalnızca seçilmişse doğrulanır
    const offset = opts.plugDifference || opts.offsetAccountId ? await resolveOffsetAccount(tx, opts.offsetAccountId, general) : null;
    const stockAccountId = (await loadMappings(tx)).get('stock')?.id;

    const all = await tx.select().from(accounts);
    const byCode = new Map(all.map((a) => [a.code.toLowerCase(), a]));
    const fx = fxResolver(tx, base, opts.openingDate, opts.numberFormat);

    const states: RowState[] = [];
    const planned: Planned[] = [];

    for (const row of rows) {
      const codeText = cellOf(row, 'account');
      const rs = new RowState(row.row, codeText);
      states.push(rs);

      const account = codeText === '' ? undefined : byCode.get(codeText.toLowerCase());
      if (codeText === '') rs.error('account', 'ACCOUNT_REQUIRED', 'Hesap kodu boş');
      else if (!account) rs.error('account', 'ACCOUNT_NOT_FOUND', `${codeText} hesap kodu hesap planında yok`);
      else {
        rs.label = `${account.code} ${account.name}`;
        if (!account.isPostable) rs.error('account', 'ACCOUNT_NOT_POSTABLE', `${account.code} hesabına kayıt atılamaz (alt hesabı var); alt hesap kodunu yazın`);
        else if (!account.isActive) rs.error('account', 'ACCOUNT_INACTIVE', `${account.code} hesabı pasif`);
        else if (account.partyControl) {
          rs.error('account', 'PARTY_CONTROL_ACCOUNT', `${account.code} cari kontrol hesabıdır; cari bakiyelerini Açılış bakiyeleri > Cari bakiyeleri sekmesinden girin`);
        } else if (/^15[0-7]/.test(account.code) || account.id === stockAccountId) {
          rs.error('account', 'STOCK_ACCOUNT', `${account.code} stok hesabıdır; stok değerini Açılış bakiyeleri > Stok sekmesinden girin`);
        }
      }

      const parse = (text: string, field: 'debit' | 'credit', label: string): string => {
        if (text === '') return '0';
        const p = parseDecimal(text, opts.numberFormat, { maxDp: 2 });
        if (!p.ok) {
          rs.error(field, p.code, `${label}: ${p.message}`);
          return '0';
        }
        return p.value;
      };
      const debit = dec(parse(cellOf(row, 'debit'), 'debit', 'Borç'));
      const credit = dec(parse(cellOf(row, 'credit'), 'credit', 'Alacak'));
      // Hem borç hem alacak doluysa (dönem hareketi biçimi) net tutar tek satır olur
      const net = debit.minus(credit);
      if (debit.gt(0) && credit.gt(0)) rs.warn('debit', 'NETTED', `Borç ve alacak birlikte dolu: net ${formatTR(net.abs())} ${net.gt(0) ? 'borç' : 'alacak'} olarak alındı`);
      if (rs.ok && net.isZero()) rs.skip('ZERO_AMOUNT', 'Tutar sıfır; atlandı');

      if (rs.ok && account) {
        const currency = (account.currencyCode ?? base) as CurrencyCode;
        const r = await fx(currency, cellOf(row, 'fxRate'));
        if (!r.ok) rs.error('fxRate', r.code, r.message);
        else {
          const amount = net.abs();
          const baseAmt = applyRate(amount, r.value);
          const isDebit = net.gt(0);
          planned.push({
            line: {
              accountId: account.id,
              description: 'Açılış bakiyesi',
              currency,
              debit: isDebit ? money(amount) : '0',
              credit: isDebit ? '0' : money(amount),
              fxRate: currency === base ? undefined : toDbRate(r.value),
            },
            debitBase: isDebit ? baseAmt : dec(0),
            creditBase: isDebit ? dec(0) : baseAmt,
          });
        }
      }
    }

    const debitTotal = sum(planned.map((p) => p.debitBase));
    const creditTotal = sum(planned.map((p) => p.creditBase));
    const diff = debitTotal.minus(creditTotal);
    if (!diff.isZero() && !opts.plugDifference) {
      general.push({
        severity: 'error',
        code: 'LEDGER_UNBALANCED',
        message: `Borç ve alacak toplamı eşit değil (fark ${formatTR(diff.abs())} ${base}); dosyayı düzeltin ya da farkı açılış karşı hesabına atma seçeneğini açın`,
      });
    }
    const skipped = states.filter((s) => s.status === 'skip').length;
    const plugText = diff.isZero() ? 'gerekmiyor (dengeli)' : opts.plugDifference && offset ? `${offset.code} ${offset.name}: ${formatTR(diff.abs())} ${diff.gt(0) ? 'alacak' : 'borç'}` : 'yok (hata)';

    return {
      rows: states.map((s) => s.preview()),
      general,
      summary: [
        { label: 'Açılış tarihi', value: opts.openingDate.split('-').reverse().join('.') },
        { label: 'Yevmiye satırı', value: String(planned.length) },
        { label: `Borç toplamı (${base})`, value: formatTR(debitTotal) },
        { label: `Alacak toplamı (${base})`, value: formatTR(creditTotal) },
        { label: 'Fark / karşı hesap satırı', value: plugText },
        { label: 'Atlanacak satır', value: String(skipped) },
      ],
      apply: async () => {
        const lines: AutoJournalLine[] = planned.map((p) => p.line);
        if (!diff.isZero()) {
          lines.push({
            accountId: offset!.id,
            description: 'Açılış karşı hesabı (fark)',
            currency: base,
            debit: diff.lt(0) ? money(diff.abs()) : '0',
            credit: diff.gt(0) ? money(diff) : '0',
          });
        }
        const entry = await createJournalEntry(tx, ledgerCtxOf(ctx), {
          entryDate: opts.openingDate,
          description: 'Açılış bakiyeleri (mizan) — içe aktarma',
          lines,
          post: true,
        });
        return {
          created: planned.length,
          skipped,
          summary: [
            { label: 'Yevmiye', value: entry.entryNo ?? '' },
            { label: 'Hesap satırı', value: String(planned.length) },
          ],
          entries: [{ type: 'journal', id: entry.id, no: entry.entryNo ?? '' }],
        };
      },
    };
  },
};
