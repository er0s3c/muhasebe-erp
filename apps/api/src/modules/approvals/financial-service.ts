import { desc, eq } from 'drizzle-orm';
import { createExpenseEntrySchema, createTreasuryTransactionSchema } from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies, financialApprovalDrafts } from '../../db/schema';
import type { TenantCtx } from '../../http/context';
import { forbidden, notFound, unprocessable } from '../../http/errors';
import { createExpenseEntry } from '../expenses/service';
import { postTreasuryTransaction } from '../treasury/posting';
import { postInvoice } from '../invoices/posting';
import { transitionSalesDoc } from '../sales/orders';
import { requireDocumentAccess, requireLiveDecision, withDocumentBranch } from './document-access';
import { assertDocumentNotPending } from './document-gate';
import { financialSnapshot } from './financial-snapshot';
import { captureInvoice, captureQuote } from './source-snapshot';
import {
  canDecideRequest,
  getRequest,
  registerApprovalHandler,
  requestApproval,
  requestsForDoc,
  type ApprovalCtx,
  type ApprovalRequestWithSteps,
} from './service';

export const approvalContext = (c: TenantCtx): ApprovalCtx => ({
  companyId: c.company.id,
  userId: c.user.id,
  role: c.role,
  permissions: c.access.permissions,
});
export async function getFinancialDraft(tx: Tx, id: string, lock = false) {
  const query = tx.select().from(financialApprovalDrafts).where(eq(financialApprovalDrafts.id, id));
  const [draft] = await (lock ? query.for('update') : query);
  if (!draft) throw notFound('Mali onay taslağı');
  return draft;
}
export async function saveFinancialDraft(
  c: TenantCtx,
  type: 'payment' | 'expense',
  value: unknown,
  id?: string,
) {
  requireDocumentAccess(c, type, 'manage', id ? 'update' : 'create');
  const old = id ? await getFinancialDraft(c.tx, id, true) : null;
  if (old && (old.docType !== type || old.createdBy !== c.user.id))
    throw forbidden('Taslağı yalnızca hazırlayan kullanıcı düzenleyebilir');
  if (old && !['draft', 'rejected'].includes(old.status))
    throw unprocessable('Onaydaki veya kesinleşmiş taslak düzenlenemez', 'APPROVAL_PENDING');
  if (type === 'expense' && createExpenseEntrySchema.parse(value).paymentKind === 'employee')
    c.require('hr.payroll_manage');
  const branchId = old ? old.branchId : c.branch.activeBranchId;
  const proof = await withDocumentBranch(c.tx, branchId, () =>
    financialSnapshot(c.tx, { ...c.company, companyId: c.company.id, branchId }, type, value),
  );
  const values = {
    payload: proof.payload,
    payloadHash: proof.hash,
    amount: proof.amount,
    currency: proof.currency,
    documentDate: proof.documentDate,
    status: 'draft' as const,
    updatedAt: new Date(),
  };
  const [draft] = old
    ? await c.tx
        .update(financialApprovalDrafts)
        .set(values)
        .where(eq(financialApprovalDrafts.id, old.id))
        .returning()
    : await c.tx
        .insert(financialApprovalDrafts)
        .values({
          ...values,
          companyId: c.company.id,
          docType: type,
          branchId,
          createdBy: c.user.id,
        })
        .returning();
  return draft!;
}
export async function submitFinancialDraft(c: TenantCtx, id: string) {
  const draft = await getFinancialDraft(c.tx, id, true);
  requireDocumentAccess(c, draft.docType, 'manage');
  if (draft.createdBy !== c.user.id)
    throw forbidden('Taslağı yalnızca hazırlayan kullanıcı onaya gönderebilir');
  if (!['draft', 'rejected'].includes(draft.status))
    throw unprocessable('Taslak onaya zaten gönderilmiş veya sonuçlanmış', 'APPROVAL_NOT_DRAFT');
  const proof = await withDocumentBranch(c.tx, draft.branchId, () =>
    financialSnapshot(
      c.tx,
      { ...c.company, companyId: c.company.id, branchId: draft.branchId },
      draft.docType,
      draft.payload,
    ),
  );
  await c.tx
    .update(financialApprovalDrafts)
    .set({
      payload: proof.payload,
      payloadHash: proof.hash,
      amount: proof.amount,
      documentDate: proof.documentDate,
      currency: proof.currency,
      status: 'submitted',
      updatedAt: new Date(),
    })
    .where(eq(financialApprovalDrafts.id, id));
  return requestApproval(c.tx, approvalContext(c), {
    docType: draft.docType,
    docId: id,
    projectId: proof.projectId,
    amount: proof.amount,
    branchId: draft.branchId,
    payloadHash: proof.hash,
    documentSnapshot: proof.snapshot,
  });
}
export async function submitSourceDocument(
  c: TenantCtx,
  type: 'invoice' | 'sales_quote',
  id: string,
) {
  requireDocumentAccess(c, type, 'manage');
  const proof =
    type === 'invoice'
      ? await captureInvoice(
          c.tx,
          { companyId: c.company.id, baseCurrency: c.company.baseCurrency },
          id,
        )
      : await captureQuote(
          c.tx,
          { companyId: c.company.id, baseCurrency: c.company.baseCurrency },
          id,
        );
  if (type === 'sales_quote' && 'status' in proof && proof.status !== 'draft')
    throw unprocessable('Yalnızca taslak teklif onaya gönderilebilir', 'SO_NOT_DRAFT');
  await assertDocumentNotPending(c.tx, type, id);
  return requestApproval(c.tx, approvalContext(c), {
    docType: type,
    docId: id,
    projectId: proof.projectId,
    amount: proof.amount,
    branchId: proof.branchId,
    payloadHash: proof.hash,
    documentSnapshot: proof.snapshot,
  });
}
async function companyContext(tx: Tx, ctx: ApprovalCtx) {
  const [company] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId));
  if (!company) throw notFound('Şirket');
  return {
    companyId: company.id,
    userId: ctx.userId,
    baseCurrency: company.baseCurrency,
    reportingCurrency: company.reportingCurrency,
    allowNegativeStock: company.allowNegativeStock,
  };
}
const assertHash = (request: ApprovalRequestWithSteps, hash: string) => {
  if (request.payloadHash !== hash)
    throw unprocessable(
      'Belge veya hesap parametreleri onaydan sonra değişti. Talebi geri çekip yeniden gönderin.',
      'APPROVAL_DOCUMENT_CHANGED',
    );
};

/** Mali belgeye ilişkin karar ve nihai kayıt tek transaction'da tamamlanır. */
export function registerDocumentApprovalHandlers() {
  for (const type of ['invoice', 'sales_quote'] as const)
    registerApprovalHandler(type, {
      beforeDecision: async (tx, ctx, request, input) => {
        await requireLiveDecision(tx, ctx, type, request.branchId);
        const company = await companyContext(tx, ctx);
        if (input.decision === 'approve') {
          const proof =
            type === 'invoice'
              ? await captureInvoice(tx, company, request.docId)
              : await captureQuote(tx, company, request.docId);
          assertHash(request, proof.hash);
        }
      },
      onResolved: async (tx, ctx, request, outcome) => {
        if (outcome !== 'approved') return;
        await requireLiveDecision(tx, ctx, type, request.branchId);
        const company = await companyContext(tx, ctx);
        await withDocumentBranch(tx, request.branchId, async () => {
          if (type === 'invoice') await postInvoice(tx, company, request.docId);
          else await transitionSalesDoc(tx, company, request.docId, 'sent');
        });
      },
    });
  for (const type of ['payment', 'expense'] as const)
    registerApprovalHandler(type, {
      beforeDecision: async (tx, ctx, request, input) => {
        const draft = await getFinancialDraft(tx, request.docId, true);
        if (draft.status !== 'submitted')
          throw unprocessable('Mali taslak onayda değil', 'APPROVAL_NOT_PENDING');
        await requireLiveDecision(
          tx,
          ctx,
          type,
          request.branchId,
          type === 'expense' && draft.payload.paymentKind === 'employee',
        );
        if (input.decision === 'approve') {
          const company = await companyContext(tx, ctx);
          const proof = await withDocumentBranch(tx, request.branchId, () =>
            financialSnapshot(tx, { ...company, branchId: request.branchId }, type, draft.payload),
          );
          assertHash(request, proof.hash);
        }
      },
      onResolved: async (tx, ctx, request, outcome) => {
        const draft = await getFinancialDraft(tx, request.docId, true);
        if (outcome === 'rejected') {
          await tx
            .update(financialApprovalDrafts)
            .set({ status: 'rejected', updatedAt: new Date() })
            .where(eq(financialApprovalDrafts.id, draft.id));
          return;
        }
        await requireLiveDecision(
          tx,
          ctx,
          type,
          request.branchId,
          type === 'expense' && draft.payload.paymentKind === 'employee',
        );
        const company = await companyContext(tx, ctx);
        const postedDocId = await withDocumentBranch(tx, request.branchId, async () => {
          const ledger = { ...company, approvalRequestId: request.id };
          if (type === 'payment')
            return (
              await postTreasuryTransaction(
                tx,
                ledger,
                createTreasuryTransactionSchema.parse(draft.payload),
              )
            ).transaction.id;
          return (
            await createExpenseEntry(tx, ledger, createExpenseEntrySchema.parse(draft.payload))
          ).id as string;
        });
        await tx
          .update(financialApprovalDrafts)
          .set({ status: 'posted', postedDocId, postedAt: new Date(), updatedAt: new Date() })
          .where(eq(financialApprovalDrafts.id, draft.id));
      },
      onCancelled: async (tx, _ctx, request) => {
        await getFinancialDraft(tx, request.docId, true);
        await tx
          .update(financialApprovalDrafts)
          .set({ status: 'rejected', updatedAt: new Date() })
          .where(eq(financialApprovalDrafts.id, request.docId));
      },
    });
}
export async function listFinancialDrafts(c: TenantCtx) {
  const rows = await c.tx
    .select()
    .from(financialApprovalDrafts)
    .orderBy(desc(financialApprovalDrafts.createdAt))
    .limit(100);
  const out = [];
  for (const draft of rows) {
    try {
      requireDocumentAccess(c, draft.docType, 'read');
      out.push({ ...draft, requests: await requestsForDoc(c.tx, draft.docType, draft.id) });
    } catch {
      /* Türün okuma izni olmayan kullanıcıya mali görüntü verilmez. */
    }
  }
  return out;
}
export async function generalRequest(c: TenantCtx, id: string) {
  const request = await getRequest(c.tx, id);
  if (!['invoice', 'sales_quote', 'payment', 'expense'].includes(request.docType))
    throw notFound('Mali onay talebi');
  requireDocumentAccess(
    c,
    request.docType as 'invoice' | 'sales_quote' | 'payment' | 'expense',
    'read',
  );
  return { ...request, canDecide: canDecideRequest(request, approvalContext(c)) };
}
