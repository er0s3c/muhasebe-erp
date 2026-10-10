import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCanOperation, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany, useSession } from '../../lib/session';

export type DocumentApprovalType = 'invoice' | 'sales_quote' | 'payment' | 'expense';
export const APPROVAL_LABELS: Record<DocumentApprovalType, string> = {
  invoice: 'Fatura',
  sales_quote: 'Satış teklifi',
  payment: 'Ödeme',
  expense: 'Gider',
};
export const APPROVAL_STATUS = {
  pending: 'Onay bekliyor',
  approved: 'Onaylandı',
  rejected: 'Reddedildi',
  cancelled: 'Geri çekildi',
};
export interface DocumentApproval {
  id: string;
  docType: DocumentApprovalType;
  docId: string;
  status: keyof typeof APPROVAL_STATUS;
  requestedBy: string;
  amount: string;
  requestedAt: string;
  canDecide?: boolean;
  documentSnapshot: Record<string, unknown> | null;
  steps: {
    id: string;
    stepNo: number;
    label: string | null;
    approverRole: string | null;
    status: string;
    note: string | null;
  }[];
}
export interface FinancialDraft {
  id: string;
  docType: 'payment' | 'expense';
  status: 'draft' | 'submitted' | 'rejected' | 'posted' | 'cancelled';
  payload: Record<string, unknown>;
  amount: string;
  currency: string;
  documentDate: string;
  createdBy: string;
  postedDocId: string | null;
  requests: DocumentApproval[];
}
export const APPROVAL_INVALIDATE = [
  ['document-approvals'],
  ['financial-approval-drafts'],
  ['invoice'],
  ['invoices'],
  ['sales-doc'],
  ['sales-docs'],
  ['treasury'],
  ['expense-entries'],
  ['journal'],
  ['parties'],
  ['party'],
  ['inventory'],
  ['reports'],
];
export const approvalModule = (type: DocumentApprovalType) =>
  type === 'invoice'
    ? 'core.invoices'
    : type === 'sales_quote'
      ? 'invoices.orders'
      : type === 'expense'
        ? 'treasury.expenses'
        : 'core.treasury';

export function useDocumentApprovals(type: 'invoice' | 'sales_quote', id?: string) {
  return useCQuery<{ requests: DocumentApproval[] }>(
    ['document-approvals', type, id],
    id ? `/api/document-approvals/documents/${type}/${id}` : null,
    { refetchOnWindowFocus: true },
  );
}

export function ApprovalRequestCard({
  request,
  allowDecision = false,
}: {
  request: DocumentApproval;
  allowDecision?: boolean;
}) {
  const toast = useToast(),
    company = useCompany(),
    user = useSession().user,
    can = useCan();
  const canUpdate = useCanOperation()(approvalModule(request.docType), 'update');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const action = useCMutation(
    (decision: 'approve' | 'reject' | 'cancel', call) =>
      call(`/api/document-approvals/${request.id}/${decision === 'cancel' ? 'cancel' : 'decide'}`, {
        method: 'POST',
        body: decision === 'cancel' ? {} : { decision, note: note.trim() || undefined },
      }),
    APPROVAL_INVALIDATE,
  );
  const submit = (decision: 'approve' | 'reject' | 'cancel') => {
    setError(null);
    action.mutate(decision, {
      onSuccess: () => {
        setNote('');
        toast.success(
          decision === 'approve'
            ? 'Onay kaydedildi'
            : decision === 'reject'
              ? 'Talep reddedildi; belge yeniden düzenlenebilir'
              : 'Talep geri çekildi; belge yeniden düzenlenebilir',
        );
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };
  const pending = request.status === 'pending',
    mayDecide =
      pending &&
      canUpdate &&
      request.requestedBy !== user?.id &&
      (request.canDecide ?? allowDecision) &&
      can(
        request.docType === 'invoice' || request.docType === 'sales_quote'
          ? 'invoices.post'
          : 'treasury.post',
      );
  const mayCancel =
    pending &&
    canUpdate &&
    (request.requestedBy === user?.id ||
      can(
        request.docType === 'invoice' || request.docType === 'sales_quote'
          ? 'invoices.post'
          : 'treasury.post',
      ));
  const snapshot = request.documentSnapshot ?? {},
    input = (snapshot.input ?? {}) as Record<string, unknown>;
  const sourcePath =
    request.docType === 'invoice'
      ? `/invoices/${request.docId}`
      : request.docType === 'sales_quote'
        ? `/sales/docs/${request.docId}`
        : request.docType === 'expense' && request.status === 'approved'
          ? '/treasury/expenses'
          : request.docType === 'payment' && request.status === 'approved'
            ? '/treasury/transactions'
            : null;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">
          {APPROVAL_LABELS[request.docType]} · {APPROVAL_STATUS[request.status]}
        </strong>
        <span className="text-sm num">{moneyIn(request.amount, company.baseCurrency)}</span>
      </div>
      <p className="text-xs text-muted">
        Gönderim: {formatDateTR(request.requestedAt.slice(0, 10))}
        {!!snapshot.party &&
          typeof (snapshot.party as Record<string, unknown>).name === 'string' &&
          ` · ${(snapshot.party as Record<string, unknown>).name}`}
        {typeof input.description === 'string' && ` · ${input.description}`}
        {typeof snapshot.description === 'string' && ` · ${snapshot.description}`}
        {sourcePath && (
          <>
            {' '}
            ·{' '}
            <Link className="link" to={sourcePath}>
              Belgeyi aç
            </Link>
          </>
        )}
      </p>
      <ol className="space-y-1 text-sm">
        {request.steps.map((step) => (
          <li key={step.id}>
            {step.stepNo}. {step.label ?? 'Onay'} ·{' '}
            {step.status === 'pending'
              ? 'Bekliyor'
              : step.status === 'approved'
                ? 'Onaylandı'
                : 'Reddedildi'}
            {step.note && <p className="mt-1 break-words text-muted">{step.note}</p>}
          </li>
        ))}
      </ol>
      {Array.isArray(snapshot.lines) && (
        <details>
          <summary className="cursor-pointer text-sm">Onaya gönderilen kalemler</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {(snapshot.lines as Record<string, unknown>[]).map((line, i) => (
              <li key={i}>
                {String(line.description ?? 'Kalem')} · {String(line.quantity ?? '')} ×{' '}
                {String(line.unitPrice ?? '')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {request.status === 'rejected' && (
        <Callout tone="warning">
          Belgeyi düzeltip yeniden onaya gönderebilirsiniz. Önceki ret kararı geçmişte korunur.
        </Callout>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      {mayDecide && (
        <Field label="Karar notu" hint="Ret gerekçesi belgeyi hazırlayan kişiye gösterilir.">
          {(id) => (
            <Input
              id={id}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      )}
      {(mayDecide || mayCancel) && (
        <div className="flex flex-wrap gap-2">
          {mayDecide && (
            <>
              <Button
                variant="primary"
                loading={action.isPending && action.variables === 'approve'}
                disabled={action.isPending}
                onClick={() => submit('approve')}
              >
                Onayla
              </Button>
              <Button
                variant="danger"
                loading={action.isPending && action.variables === 'reject'}
                disabled={action.isPending || !note.trim()}
                onClick={() => submit('reject')}
              >
                Reddet
              </Button>
            </>
          )}
          {mayCancel && (
            <Button disabled={action.isPending} onClick={() => submit('cancel')}>
              Talebi geri çek
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function DocumentApprovalPanel({
  type,
  id,
  status,
}: {
  type: 'invoice' | 'sales_quote';
  id: string;
  status: string;
}) {
  const query = useDocumentApprovals(type, id),
    can = useCan(),
    canUpdate = useCanOperation()(approvalModule(type), 'update'),
    toast = useToast();
  const submit = useCMutation(
    (_: void, call) =>
      call(`/api/document-approvals/documents/${type}/${id}/submit`, { method: 'POST', body: {} }),
    APPROVAL_INVALIDATE,
  );
  const [error, setError] = useState<string | null>(null);
  const requests = query.data?.requests ?? [],
    pending = requests.some((request) => request.status === 'pending');
  return (
    <section className="mb-4 flex flex-col gap-3 print:hidden" aria-label="Belge onayı">
      {pending && (
        <Callout tone="warning">
          Belge onay bekliyor. Bu sürüm düzenlenemez veya ayrıca kesinleştirilemez. Son onay
          tamamlandığında{' '}
          {type === 'invoice'
            ? 'fatura otomatik kaydedilir'
            : 'teklif müşteriye gönderilmiş durumuna geçer'}
          .
        </Callout>
      )}
      {status === 'draft' && !pending && can('invoices.manage') && canUpdate && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={submit.isPending}
            onClick={() => {
              setError(null);
              submit.mutate(undefined, {
                onSuccess: () => toast.success('Kaydedilmiş belge onaya gönderildi'),
                onError: (e) => setError(errorMessage(e)),
              });
            }}
          >
            Onaya gönder
          </Button>
          <p className="text-xs text-muted">
            Önce değişikliklerinizi taslak olarak kaydedin. Onaya kaydedilmiş sürüm gönderilir;
            gönderen kendi belgesini onaylayamaz.
          </p>
        </div>
      )}
      {(error || query.error) && (
        <Callout tone="danger">{error ?? errorMessage(query.error)}</Callout>
      )}
      {requests.map((request) => (
        <ApprovalRequestCard key={request.id} request={request} />
      ))}
    </section>
  );
}
