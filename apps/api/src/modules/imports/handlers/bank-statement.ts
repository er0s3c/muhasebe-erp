import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { bankStatementOptionsSchema, currencySymbol, dec, formatDateTR, formatMoney, formatTR, type ImportMessage, type ImportRow, type MoneyValue, sum, toDbAmount } from '@erp/shared';
import { bankStatementLines, bankStatements, treasuryAccounts } from '../../../db/schema';
import { foldKey, parseDate, parseDecimal } from '../values';
import { RowState, cellOf, type ImportCtx, type ImportHandler, type PlanResult } from './common';

/** Yön sözcükleri: Banka ekstresinde Borç = çıkan, Alacak = giren kabul edilir (banka defteri görünümü). */
const IN_WORDS = new Set(['giris', 'yatan', 'alacak', 'gelen', 'tahsilat', 'a', 'in', 'credit', 'cr']);
const OUT_WORDS = new Set(['cikis', 'cekilen', 'borc', 'giden', 'odeme', 'b', 'out', 'debit', 'dr']);

interface Parsed {
  no: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string | null;
  amount: MoneyValue;
  balance: MoneyValue | null;
  key: string;
}

/**
 * Ekstre satırlarının sırasından bakiye yönünü bulur ve açılış/kapanış bakiyesini çıkarır. Dosya eskiden yeniye ya
 * da yeniden eskiye olabilir: hangisi bakiyelerle daha çok tutarlıysa o kabul edilir; belirsizse eskiden yeniye.
 */
export function balancesOf(rows: readonly { amount: MoneyValue; balance: MoneyValue | null }[]): { opening: MoneyValue; closing: MoneyValue } | null {
  const seq = rows.filter((r): r is { amount: MoneyValue; balance: MoneyValue } => r.balance !== null);
  if (seq.length === 0) return null;
  let asc = 0;
  let desc = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i]!.balance.minus(seq[i - 1]!.balance).equals(seq[i]!.amount)) asc++;
    if (seq[i - 1]!.balance.minus(seq[i]!.balance).equals(seq[i - 1]!.amount)) desc++;
  }
  if (asc >= desc) {
    const first = seq[0]!;
    return { opening: first.balance.minus(first.amount), closing: seq[seq.length - 1]!.balance };
  }
  const last = seq[seq.length - 1]!;
  return { opening: last.balance.minus(last.amount), closing: seq[0]!.balance };
}

/**
 * Banka ekstresi: satır başına işaretli tutar (+ giriş / − çıkış). Tutar üç biçimden biriyle gelir: tek işaretli
 * sütun, Giriş/Çıkış sütunları ya da Tutar + Yön. Aynı satır (tarih, tutar, açıklama, referans, dosyadaki sıra) ikinci
 * kez alınmaz (çakışan dönemli ekstreler); aynı içerikli ekstre bütünüyle reddedilir.
 */
export const bankStatementHandler: ImportHandler = {
  kind: 'bank_statement',
  module: 'core.treasury',
  permission: 'treasury.post',

  async plan(ctx: ImportCtx, rows: ImportRow[], rawOptions): Promise<PlanResult> {
    const opts = bankStatementOptionsSchema.parse(rawOptions);
    const { tx, company } = ctx;
    const general: ImportMessage[] = [];

    const [account] = await tx.select().from(treasuryAccounts).where(eq(treasuryAccounts.id, opts.accountId));
    if (!account) general.push({ severity: 'error', code: 'ACCOUNT_NOT_FOUND', message: 'Banka hesabı bulunamadı' });
    else if (account.kind !== 'bank') general.push({ severity: 'error', code: 'NOT_A_BANK_ACCOUNT', message: 'Ekstre yalnızca banka hesaplarına aktarılabilir' });
    else if (!account.isActive) general.push({ severity: 'error', code: 'ACCOUNT_INACTIVE', message: `${account.name} hesabı pasif` });

    const existing = account
      ? new Set((await tx.select({ key: bankStatementLines.dedupeKey }).from(bankStatementLines).where(eq(bankStatementLines.accountId, account.id))).map((r) => r.key))
      : new Set<string>();

    const states: RowState[] = [];
    const parsedAll: Parsed[] = [];
    const toWrite: Parsed[] = [];
    const seenBase = new Map<string, number>();

    for (const row of rows) {
      const rs = new RowState(row.row, '');
      states.push(rs);

      const dateText = cellOf(row, 'date');
      let txnDate: string | null = null;
      if (dateText === '') rs.error('date', 'DATE_REQUIRED', 'Tarih boş');
      else {
        const d = parseDate(dateText);
        if (!d.ok) rs.error('date', d.code, `Tarih: ${d.message}`);
        else txnDate = d.value;
      }
      let valueDate: string | null = null;
      const valueText = cellOf(row, 'valueDate');
      if (valueText !== '') {
        const v = parseDate(valueText);
        if (!v.ok) rs.error('valueDate', v.code, `Valör: ${v.message}`);
        else valueDate = v.value;
      }

      const description = cellOf(row, 'description').replace(/\s+/g, ' ');
      const reference = cellOf(row, 'reference') || null;
      if (description.length > 500) rs.error('description', 'TOO_LONG', 'Açıklama en çok 500 karakter olabilir');
      if (reference && reference.length > 100) rs.error('reference', 'TOO_LONG', 'Referans en çok 100 karakter olabilir');
      rs.label = description || reference || dateText;

      // Tutar
      const num = (text: string, field: string, label: string): MoneyValue | null => {
        const p = parseDecimal(text, opts.numberFormat, { maxDp: 2, allowNegative: true });
        if (!p.ok) {
          rs.error(field, p.code, `${label}: ${p.message}`);
          return null;
        }
        return dec(p.value);
      };
      const inText = cellOf(row, 'moneyIn');
      const outText = cellOf(row, 'moneyOut');
      const amountText = cellOf(row, 'amount');
      let amount: MoneyValue | null = null;
      if (inText !== '' || outText !== '') {
        const i = inText !== '' ? num(inText, 'moneyIn', 'Giriş') : dec(0);
        const o = outText !== '' ? num(outText, 'moneyOut', 'Çıkış') : dec(0);
        if (i && o) {
          if (!i.isZero() && !o.isZero()) rs.error('moneyIn', 'BOTH_SIDES', 'Giriş ve Çıkış birlikte dolu olamaz');
          else amount = i.abs().minus(o.abs());
        }
      } else if (amountText !== '') {
        const a = num(amountText, 'amount', 'Tutar');
        const dirText = cellOf(row, 'direction');
        if (a) {
          if (dirText === '') amount = a;
          else {
            const key = foldKey(dirText);
            if (IN_WORDS.has(key)) amount = a.abs();
            else if (OUT_WORDS.has(key)) amount = a.abs().negated();
            else rs.error('direction', 'DIRECTION_UNKNOWN', `"${dirText}" yön değil (Giriş/Çıkış ya da Alacak/Borç)`);
          }
        }
      } else {
        rs.error('amount', 'AMOUNT_REQUIRED', 'Tutar (ya da Giriş/Çıkış) boş');
      }
      if (rs.ok && amount !== null && amount.isZero()) rs.skip('ZERO_AMOUNT', 'Tutar sıfır; atlandı');

      let balance: MoneyValue | null = null;
      const balanceText = cellOf(row, 'balance');
      if (balanceText !== '') balance = num(balanceText, 'balance', 'Bakiye');

      if (rs.status !== 'error' && txnDate && amount !== null && !amount.isZero()) {
        const base = `${txnDate}|${amount.toFixed(2)}|${foldKey(description)}|${(reference ?? '').toLowerCase()}`;
        const occurrence = seenBase.get(base) ?? 0;
        seenBase.set(base, occurrence + 1);
        const item: Parsed = { no: row.row, txnDate, valueDate, description, reference, amount, balance, key: `${base}|${occurrence}` };
        parsedAll.push(item);
        if (existing.has(item.key)) rs.skip('DUPLICATE_LINE', 'Bu satır daha önce içe aktarılmış; atlandı');
        else toWrite.push(item);
      }
    }

    // Aynı içerikli ekstre (satır listesi birebir aynı) tekrar alınamaz
    const hash = createHash('sha256')
      .update(JSON.stringify([opts.accountId, ...parsedAll.map((p) => [p.txnDate, p.amount.toFixed(2), p.description, p.reference])]))
      .digest('hex');
    if (account) {
      const [dup] = await tx
        .select({ id: bankStatements.id, fileName: bankStatements.fileName })
        .from(bankStatements)
        .where(and(eq(bankStatements.accountId, account.id), eq(bankStatements.fileHash, hash)));
      if (dup) {
        general.push({ severity: 'error', code: 'STATEMENT_DUPLICATE', message: `Bu ekstre daha önce içe aktarılmış (${dup.fileName}); aynı ekstre iki kez alınamaz` });
      }
    }

    // Bakiyeler: açık kapanış bakiyesi girildiyse o, yoksa bakiye sütunundan
    let closingOverride: MoneyValue | null = null;
    if (opts.closingBalance) {
      const c = parseDecimal(opts.closingBalance, opts.numberFormat, { maxDp: 2, allowNegative: true });
      if (!c.ok) general.push({ severity: 'error', code: c.code, message: `Kapanış bakiyesi: ${c.message}` });
      else closingOverride = dec(c.value);
    }
    const computed = balancesOf(parsedAll);
    const closing = closingOverride ?? computed?.closing ?? null;
    const opening = closingOverride ? closingOverride.minus(sum(parsedAll.map((p) => p.amount))) : (computed?.opening ?? null);

    const dates = toWrite.map((p) => p.txnDate).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    const totalIn = sum(toWrite.filter((p) => p.amount.gt(0)).map((p) => p.amount));
    const totalOut = sum(toWrite.filter((p) => p.amount.lt(0)).map((p) => p.amount.abs()));
    const skipped = states.filter((s) => s.status === 'skip').length;
    const cur = account?.currencyCode ?? company.baseCurrency;

    return {
      rows: states.map((s) => s.preview()),
      general,
      summary: [
        { label: 'Banka hesabı', value: account ? account.name : '—' },
        { label: 'Ekstre aralığı', value: from && to ? `${formatDateTR(from)} – ${formatDateTR(to)}` : '—' },
        { label: 'Alınacak satır', value: String(toWrite.length) },
        { label: `Giren toplam (${currencySymbol(cur)})`, value: formatTR(totalIn) },
        { label: `Çıkan toplam (${currencySymbol(cur)})`, value: formatTR(totalOut) },
        { label: 'Kapanış bakiyesi', value: closing ? formatMoney(closing, cur) : 'bilinmiyor' },
        { label: 'Atlanacak satır', value: String(skipped) },
      ],
      apply: async () => {
        const [statement] = await tx
          .insert(bankStatements)
          .values({
            companyId: company.id,
            accountId: account!.id,
            fileName: opts.fileName || 'ekstre',
            fileHash: hash,
            fromDate: from!,
            toDate: to!,
            openingBalance: opening ? toDbAmount(opening) : null,
            closingBalance: closing ? toDbAmount(closing) : null,
            lineCount: toWrite.length,
            mapping: opts.mapping ?? {},
            createdBy: ctx.userId,
          })
          .returning({ id: bankStatements.id });
        for (let i = 0; i < toWrite.length; i += 500) {
          await tx.insert(bankStatementLines).values(
            toWrite.slice(i, i + 500).map((p) => ({
              companyId: company.id,
              statementId: statement!.id,
              accountId: account!.id,
              lineNo: p.no,
              txnDate: p.txnDate,
              valueDate: p.valueDate,
              description: p.description,
              reference: p.reference,
              amount: toDbAmount(p.amount),
              balance: p.balance ? toDbAmount(p.balance) : null,
              currencyCode: account!.currencyCode,
              dedupeKey: p.key,
            })),
          );
        }
        return {
          created: toWrite.length,
          skipped,
          summary: [
            { label: 'Ekstre aralığı', value: from && to ? `${formatDateTR(from)} – ${formatDateTR(to)}` : '—' },
            { label: 'Alınan satır', value: String(toWrite.length) },
            { label: 'Kapanış bakiyesi', value: closing ? formatMoney(closing, cur) : 'bilinmiyor' },
          ],
          entries: [],
        };
      },
    };
  },
};
