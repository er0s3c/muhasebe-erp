import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { approvalRequests, financialApprovalDrafts } from '../../db/schema';
import { conflict, unprocessable } from '../../http/errors';
import { resolveRule } from './service';
import type { GeneralApprovalType } from './document-policy';

export async function assertDocumentNotPending(tx: Tx, type: GeneralApprovalType, id: string) {
  const [pending] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.docType, type),
        eq(approvalRequests.docId, id),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .limit(1);
  if (pending)
    throw conflict(
      'Belge onay bekliyor. Düzenlemek için önce talebi geri çekin.',
      'APPROVAL_PENDING',
    );
}

export async function assertDocumentApproved(
  tx: Tx,
  type: GeneralApprovalType,
  id: string,
  amount: string,
  hash: string,
  projectId: string | null = null,
) {
  await assertDocumentNotPending(tx, type, id);
  const [approved] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.docType, type),
        eq(approvalRequests.docId, id),
        eq(approvalRequests.status, 'approved'),
        eq(approvalRequests.payloadHash, hash),
      ),
    )
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(1);
  if (approved) return;
  if ((await resolveRule(tx, type, projectId, amount)).ruleId)
    throw unprocessable(
      'Bu belge için güncel içerikle ayrı bir onay talebi tamamlanmalı.',
      'APPROVAL_REQUIRED',
    );
}

/** Mali taslağın son onayında kullanılan tek işlem içi kanıt; istemci bunu ayarlayamaz. */
export async function assertFinancialApproved(
  tx: Tx,
  type: 'payment' | 'expense',
  requestId: string | undefined,
  amount: string,
  hash: string,
  projectId: string | null = null,
) {
  if (requestId) {
    const [approved] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .innerJoin(financialApprovalDrafts, eq(financialApprovalDrafts.id, approvalRequests.docId))
      .where(
        and(
          eq(approvalRequests.id, requestId),
          eq(approvalRequests.docType, type),
          eq(approvalRequests.status, 'approved'),
          eq(approvalRequests.payloadHash, hash),
          // financial-service.onResolved awaits posting BEFORE changing the draft to posted.
          // The locked draft remains submitted throughout both posting service calls.
          // A finalized draft cannot supply the same approval proof for a second payment.
          eq(financialApprovalDrafts.payloadHash, hash),
          eq(financialApprovalDrafts.status, 'submitted'),
        ),
      )
      .limit(1);
    if (!approved)
      throw unprocessable(
        'Mali belge onayının içeriği değişti. Taslağı yeniden sunun.',
        'APPROVAL_DOCUMENT_CHANGED',
      );
    return;
  }
  if ((await resolveRule(tx, type, projectId, amount)).ruleId)
    throw unprocessable(
      'Bu işlem için önce mali taslak hazırlayıp ayrı onay alın.',
      'APPROVAL_REQUIRED',
    );
}
