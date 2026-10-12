import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  createPaymentBatchSchema,
  dec,
  idParam,
  paymentBankFileCsv,
  paymentBatchCancelSchema,
  paymentBatchSuggestQuerySchema,
  type PaymentBatchStatus,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../http/errors';
import type { LedgerCtx } from '../ledger/journal';
import { decryptField } from '../hr/crypto';
import { allOpenItems } from '../parties/service';
import { postTreasuryTransaction } from './posting';

/** Toplu ödeme (öneri 54); akış için bkz. packages/shared/src/payment-batches.ts. */
const read = { module: 'core.treasury', permission: 'treasury.read' } as const;
const manage = { module: 'core.treasury', permission: 'treasury.manage' } as const;
const post = { module: 'core.treasury', permission: 'treasury.post' } as const;

const ledgerCtx = ({ company, user }: TenantCtx): LedgerCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
});

interface BatchRow extends Record<string, unknown> {
  id: string;
  batchNo: string;
  accountId: string;
  accountName: string;
  paymentDate: string;
  status: PaymentBatchStatus;
  currency: string;
  total: string;
  note: string;
  createdBy: string;
  approvedBy: string | null;
  version: number;
}
const batchFields = sql`b.id,b.batch_no as "batchNo",b.account_id as "accountId",ta.name as "accountName",b.payment_date::text as "paymentDate",b.status,b.currency,b.total,b.note,
  b.created_by as "createdBy",cu.full_name as "createdByName",b.created_at as "createdAt",b.approved_by as "approvedBy",au.full_name as "approvedByName",b.approved_at as "approvedAt",
  b.posted_at as "postedAt",b.cancelled_at as "cancelledAt",b.cancel_reason as "cancelReason",b.version`;
const batchFrom = sql`from payment_batches b join treasury_accounts ta on ta.id=b.account_id join users cu on cu.id=b.created_by left join users au on au.id=b.approved_by`;

async function batch(c: TenantCtx, id: string, lock = false) {
  if (lock) await c.tx.execute(sql`select id from payment_batches where id=${id}::uuid for update`);
  const row = (await c.tx.execute<BatchRow>(sql`select ${batchFields} ${batchFrom} where b.id=${id}::uuid`)).rows[0];
  if (!row) throw notFound('Ödeme listesi');
  return row;
}
async function lines(c: TenantCtx, id: string) {
  return (
    await c.tx.execute<{ id: string; lineNo: number; partyId: string; partyName: string; bankAccountId: string; ibanLast4: string; holderName: string; bankStatus: string; amount: string; items: unknown[]; description: string; treasuryTransactionId: string | null }>(
      sql`select l.id,l.line_no as "lineNo",l.party_id as "partyId",p.name as "partyName",l.bank_account_id as "bankAccountId",ba.iban_last4 as "ibanLast4",ba.holder_name as "holderName",ba.status as "bankStatus",
        l.amount,l.items,l.description,l.treasury_transaction_id as "treasuryTransactionId"
        from payment_batch_lines l join parties p on p.id=l.party_id join party_bank_accounts ba on ba.id=l.bank_account_id where l.batch_id=${id}::uuid order by l.line_no`,
    )
  ).rows;
}
/** Tek etkin üyeli şirkette dört göz kuralı uygulanamaz; hazırlayan onaylayabilir. */
async function singleMember(c: TenantCtx) {
  const r = (await c.tx.execute<{ n: number }>(sql`select count(*)::int as n from memberships where company_id=${c.company.id}::uuid and is_active`)).rows[0]!;
  return r.n <= 1;
}
async function assertVerified(c: TenantCtx, id: string) {
  const bad = (await lines(c, id)).filter((l) => l.bankStatus !== 'verified');
  if (bad.length) throw unprocessable(`Doğrulanmamış banka hesabı: ${bad.map((l) => l.partyName).join(', ')}`, 'PAYMENT_BANK_NOT_VERIFIED');
}

export const paymentBatchRoutes: FastifyPluginAsync = async (app) => {
  const secret = app.config.JWT_SECRET;

  // Vadesi gelen tedarikçi borçları (hesap para biriminde), doğrulanmış IBAN'ıyla birlikte cari bazında
  app.get(
    '/api/payment-batches/suggestions',
    tenantRoute(app, read, async (c) => {
      const q = paymentBatchSuggestQuerySchema.parse(c.req.query);
      const account = (await c.tx.execute<{ currency_code: string; kind: string }>(sql`select currency_code,kind from treasury_accounts where id=${q.accountId}::uuid and is_active`)).rows[0];
      if (!account) throw notFound('Banka hesabı');
      const items = (await allOpenItems(c.tx, 'payable', q.dueUntil)).filter((i) => i.currencyCode === account.currency_code && i.dueDate <= q.dueUntil && dec(i.remaining).gt(0));
      const partyIds = [...new Set(items.map((i) => i.partyId))];
      const banks = partyIds.length
        ? (
            await c.tx.execute<{ id: string; party_id: string; iban_last4: string; holder_name: string }>(
              sql`select distinct on (party_id) id,party_id,iban_last4,holder_name from party_bank_accounts where status='verified' and party_id in (${sql.join(partyIds.map((p) => sql`${p}::uuid`), sql`,`)}) order by party_id,decided_at desc`,
            )
          ).rows
        : [];
      const parties = partyIds.map((partyId) => {
        const own = items.filter((i) => i.partyId === partyId).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
        const bank = banks.find((b) => b.party_id === partyId) ?? null;
        return {
          partyId,
          partyName: own[0]!.partyName,
          total: own.reduce((s, i) => s.plus(i.remaining), dec(0)).toFixed(2),
          oldestDue: own[0]!.dueDate,
          bankAccount: bank ? { id: bank.id, ibanLast4: bank.iban_last4, holderName: bank.holder_name } : null,
          items: own.map((i) => ({ lineId: i.lineId, entryNo: i.entryNo, dueDate: i.dueDate, description: i.description, remaining: i.remaining })),
        };
      });
      return { currency: account.currency_code, parties: parties.sort((a, b) => a.oldestDue.localeCompare(b.oldestDue)) };
    }),
  );
  app.get(
    '/api/payment-batches',
    tenantRoute(app, read, async (c) => ({ batches: (await c.tx.execute(sql`select ${batchFields} ${batchFrom} order by b.created_at desc limit 200`)).rows })),
  );
  app.get(
    '/api/payment-batches/:id',
    tenantRoute(app, read, async (c) => {
      const id = idParam.parse(c.req.params).id;
      return { batch: await batch(c, id), lines: await lines(c, id) };
    }),
  );
  app.post(
    '/api/payment-batches',
    tenantRoute(app, manage, async (c) => {
      const input = createPaymentBatchSchema.parse(c.req.body);
      const account = (await c.tx.execute<{ currency_code: string; kind: string }>(sql`select currency_code,kind from treasury_accounts where id=${input.accountId}::uuid and is_active`)).rows[0];
      if (!account || account.kind !== 'bank') throw badRequest('Toplu ödeme için etkin bir banka hesabı seçin.', 'PAYMENT_BATCH_ACCOUNT');
      // Satır cari ve banka hesabı eşleşmeli; banka hesabı en az bekleyen olmalı (onayda doğrulanmış olması aranır)
      for (const l of input.lines) {
        const ok = (
          await c.tx.execute(
            sql`select 1 from party_bank_accounts ba join parties p on p.id=ba.party_id where ba.id=${l.bankAccountId}::uuid and ba.party_id=${l.partyId}::uuid and ba.status in ('pending','verified') and p.kind in ('supplier','both')`,
          )
        ).rows[0];
        if (!ok) throw badRequest('Satırdaki banka hesabı tedarikçiye ait ve geçerli olmalı.', 'PAYMENT_BATCH_LINE');
      }
      const total = input.lines.reduce((s, l) => s.plus(l.amount), dec(0)).toFixed(2);
      const seq = (await c.tx.execute<{ n: number }>(sql`select count(*)::int+1 as n from payment_batches where batch_no like ${'TO-' + input.paymentDate.slice(0, 4) + '-%'}`)).rows[0]!.n;
      const id = uuidv7(),
        batchNo = `TO-${input.paymentDate.slice(0, 4)}-${String(seq).padStart(4, '0')}`;
      await c.tx.execute(
        sql`insert into payment_batches(id,company_id,batch_no,account_id,payment_date,currency,total,note,created_by) values(${id},${c.company.id},${batchNo},${input.accountId},${input.paymentDate},${account.currency_code},${total},${input.note},${c.user.id})`,
      );
      for (const [n, l] of input.lines.entries())
        await c.tx.execute(
          sql`insert into payment_batch_lines(id,company_id,batch_id,line_no,party_id,bank_account_id,amount,items,description) values(${uuidv7()},${c.company.id},${id},${n + 1},${l.partyId},${l.bankAccountId},${dec(l.amount).toFixed(2)},${JSON.stringify(l.items)}::jsonb,${l.description})`,
        );
      void c.reply.code(201);
      return { batch: await batch(c, id), lines: await lines(c, id) };
    }),
  );
  app.post(
    '/api/payment-batches/:id/approve',
    tenantRoute(app, post, async (c) => {
      const id = idParam.parse(c.req.params).id;
      const b = await batch(c, id, true);
      if (b.status !== 'draft') throw conflict('Yalnız taslak liste onaylanır.', 'PAYMENT_BATCH_STATUS');
      if (b.createdBy === c.user.id && !(await singleMember(c)))
        throw forbidden('Ödeme listesini hazırlayan kişi onaylayamaz; başka bir yetkili onaylamalı.', 'PAYMENT_BATCH_FOUR_EYES');
      await assertVerified(c, id);
      await c.tx.execute(sql`update payment_batches set status='approved',approved_by=${c.user.id},approved_at=now(),version=version+1 where id=${id}::uuid`);
      return { batch: await batch(c, id), lines: await lines(c, id) };
    }),
  );
  // Banka dosyası: tam IBAN yalnız onaylı listede ve doğrulanmış hesaplarla açılır
  app.get(
    '/api/payment-batches/:id/bank-file',
    tenantRoute(app, { ...post, operation: 'export' }, async (c) => {
      const id = idParam.parse(c.req.params).id;
      const b = await batch(c, id);
      if (!['approved', 'posted'].includes(b.status)) throw conflict('Banka dosyası yalnız onaylı listeden alınır.', 'PAYMENT_BATCH_STATUS');
      await assertVerified(c, id);
      const rows = (
        await c.tx.execute<{ iban_enc: string; holder_name: string; amount: string; description: string; party_name: string }>(
          sql`select ba.iban_enc,ba.holder_name,l.amount,l.description,p.name as party_name from payment_batch_lines l join party_bank_accounts ba on ba.id=l.bank_account_id join parties p on p.id=l.party_id where l.batch_id=${id}::uuid order by l.line_no`,
        )
      ).rows;
      const csv = paymentBankFileCsv(
        rows.map((r) => ({ iban: decryptField(r.iban_enc, secret), holderName: r.holder_name, amount: r.amount, currency: b.currency, description: r.description || `${b.batchNo} ${r.party_name}`.slice(0, 140) })),
      );
      void c.reply
        .header('cache-control', 'no-store')
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${b.batchNo}.csv"`);
      return '﻿' + csv;
    }),
  );
  app.post(
    '/api/payment-batches/:id/post',
    tenantRoute(app, { ...post, idempotent: true }, async (c) => {
      const id = idParam.parse(c.req.params).id;
      const b = await batch(c, id, true);
      if (b.status !== 'approved') throw conflict('Yalnız onaylı liste kaydedilir.', 'PAYMENT_BATCH_STATUS');
      await assertVerified(c, id);
      for (const l of await lines(c, id)) {
        const result = await postTreasuryTransaction(c.tx, ledgerCtx(c), {
          type: 'payment',
          date: b.paymentDate,
          accountId: b.accountId,
          amount: l.amount,
          partyId: l.partyId,
          items: l.items as never,
          description: (l.description || `${b.batchNo} toplu ödeme`).slice(0, 300),
        });
        await c.tx.execute(sql`update payment_batch_lines set treasury_transaction_id=${result.transaction.id}::uuid where id=${l.id}::uuid`);
      }
      await c.tx.execute(sql`update payment_batches set status='posted',posted_by=${c.user.id},posted_at=now(),version=version+1 where id=${id}::uuid`);
      return { batch: await batch(c, id), lines: await lines(c, id) };
    }),
  );
  app.post(
    '/api/payment-batches/:id/cancel',
    tenantRoute(app, manage, async (c) => {
      const id = idParam.parse(c.req.params).id,
        { reason } = paymentBatchCancelSchema.parse(c.req.body);
      const b = await batch(c, id, true);
      if (!['draft', 'approved'].includes(b.status)) throw conflict('Kayıtlı liste iptal edilemez; ödemeleri hazine ekranından iptal edin.', 'PAYMENT_BATCH_STATUS');
      await c.tx.execute(sql`update payment_batches set status='cancelled',cancelled_by=${c.user.id},cancelled_at=now(),cancel_reason=${reason},version=version+1 where id=${id}::uuid`);
      return { batch: await batch(c, id), lines: await lines(c, id) };
    }),
  );
};
