import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { decryptField } from '../hr/crypto';

/** Kişi verisi dışa aktarma/erişim talebi için bir personelin yabancı işçi belgeleri (açık numara dahil), yenileme geçmişi ve teminatları. */
export async function employeeForeignRows(tx: Tx, employeeId: string, secret: string) {
  const docs = await tx.execute<Record<string, unknown>>(sql`
    select d.id, t.name as "type", d.number_enc as "numberEnc", d.issuing_authority as "issuingAuthority", d.issue_date::text as "issueDate",
           d.expiry_date::text as "expiryDate", d.reference_note as "referenceNote", d.note, d.revoked_at as "revokedAt", d.revoke_reason as "revokeReason"
      from foreign_worker_docs d join foreign_doc_types t on t.id = d.type_id where d.employee_id = ${employeeId} order by t.name, d.created_at`);
  const renewals = await tx.execute<Record<string, unknown>>(sql`
    select r.doc_id as "docId", r.prev_issue_date::text as "prevIssueDate", r.prev_expiry_date::text as "prevExpiryDate", r.new_issue_date::text as "newIssueDate",
           r.new_expiry_date::text as "newExpiryDate", r.note, r.renewed_at as "renewedAt"
      from foreign_doc_renewals r join foreign_worker_docs d on d.id = r.doc_id where d.employee_id = ${employeeId} order by r.renewed_at`);
  const guarantees = await tx.execute<Record<string, unknown>>(sql`
    select amount::text as amount, currency, deposited_date::text as "depositedDate", deposit_reference as "depositReference", status,
           resolved_date::text as "resolvedDate", resolution_note as "resolutionNote"
      from foreign_worker_guarantees where employee_id = ${employeeId} order by deposited_date`);
  return {
    documents: docs.rows.map(({ numberEnc, ...d }) => ({ ...d, documentNo: numberEnc ? decryptField(numberEnc as string, secret) : null })),
    renewals: renewals.rows,
    guarantees: guarantees.rows,
  };
}
