import { ArrowLeft } from 'lucide-react';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ApprovalRequestRow, PurchaseRequestDetail, RfqDetail } from '../../lib/types';
import { ApprovalStatusBadge } from '../subcontracts/common';
import { useProjectOptions } from '../projects/common';
import { emptyLine, LinesEditor, lineValid, num, PROCUREMENT_INVALIDATE, RequestStatusBadge, RfqStatusBadge, OrderStatusBadge, type LineDraft } from './common';
import { fmtDate } from '../../lib/license';

export function PurchaseRequestEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const base = useCompany().baseCurrency;
  const isNew = !id || id === 'new';
  const { projects } = useProjectOptions();

  const detailQ = useCQuery<PurchaseRequestDetail>(['purchase-request', id], isNew ? null : `/api/purchase-requests/${id}`);
  const { data: inbox } = useCQuery<{ requests: ApprovalRequestRow[] }>(['approvals', 'inbox'], '/api/approvals/inbox');
  const detail = detailQ.data;
  const status = isNew ? 'draft' : detail?.request.status ?? 'draft';
  const editable = status === 'draft' && can('procurement.manage');

  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [needDate, setNeedDate] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [error, setError] = useState<Error | null>(null);
  const [decideNote, setDecideNote] = useState('');
  const [rfqOpen, setRfqOpen] = useState(false);
  const [dueDate, setDueDate] = useState('');

  useEffect(() => {
    if (!detail) return;
    setProjectId(detail.request.projectId);
    setTitle(detail.request.title);
    setNeedDate(detail.request.needDate ?? '');
    setNote(detail.request.note ?? '');
    setLines(detail.lines.map((l) => ({ key: l.id, itemId: l.itemId ?? '', description: l.description, unit: l.unit, quantity: String(Number(l.quantity)), price: l.estUnitPrice ? String(Number(l.estUnitPrice)) : '', wbsId: l.wbsId ?? '' })));
  }, [detail]);

  const body = () => ({
    ...(isNew ? { projectId } : {}),
    title: title.trim(),
    needDate: needDate || null,
    note: note.trim() || null,
    lines: lines.map((l) => ({ itemId: l.itemId || null, description: l.description.trim(), unit: l.unit.trim(), quantity: num(l.quantity), estUnitPrice: l.price.trim() ? num(l.price) : null, wbsId: l.wbsId || null })),
  });
  const invalid = title.trim().length < 2 || (isNew && !projectId) || lines.some((l) => !lineValid(l, false));

  const save = useCMutation(
    (_: void, call) => (isNew ? call<PurchaseRequestDetail>('/api/purchase-requests', { method: 'POST', body: body() }) : call<PurchaseRequestDetail>(`/api/purchase-requests/${id}`, { method: 'PUT', body: body() })),
    PROCUREMENT_INVALIDATE,
  );
  const submit = useCMutation(async (_: void, call) => {
    const saved = isNew
      ? await call<PurchaseRequestDetail>('/api/purchase-requests', { method: 'POST', body: body() })
      : await call<PurchaseRequestDetail>(`/api/purchase-requests/${id}`, { method: 'PUT', body: body() });
    return call<PurchaseRequestDetail>(`/api/purchase-requests/${saved.request.id}/submit`, { method: 'POST', body: {} });
  }, PROCUREMENT_INVALIDATE);
  const act = useCMutation((v: 'withdraw' | 'cancel', call) => call(`/api/purchase-requests/${id}/${v}`, { method: 'POST', body: {} }), PROCUREMENT_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/purchase-requests/${id}`, { method: 'DELETE' }), PROCUREMENT_INVALIDATE);
  const decide = useCMutation((v: { requestId: string; decision: 'approve' | 'reject' }, call) => call(`/api/approvals/${v.requestId}/decide`, { method: 'POST', body: { decision: v.decision, ...(decideNote.trim() ? { note: decideNote.trim() } : {}) } }), PROCUREMENT_INVALIDATE);
  const createRfq = useCMutation((_: void, call) => call<RfqDetail>('/api/rfqs', { method: 'POST', body: { requestId: id, dueDate: dueDate || null } }), PROCUREMENT_INVALIDATE);

  const fail = (e: Error) => setError(e);
  const go = <T,>(fn: (o: { onSuccess: (r: T) => void; onError: (e: Error) => void }) => void, ok: (r: T) => void) => {
    setError(null);
    fn({ onSuccess: ok, onError: fail });
  };

  if (!isNew && detailQ.isPending) return <PageLoading />;
  const r = detail?.request;
  const pending = detail?.approvals.find((a) => a.status === 'pending');
  const myTurn = !!pending && !!inbox?.requests.some((x) => x.id === pending.id);
  const estimated = lines.reduce((s, l) => s + (Number(num(l.quantity)) || 0) * (Number(num(l.price)) || 0), 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/purchasing/requests" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {t('procurement.requests.title')}
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl">
          {isNew ? t('procurement.requests.newTitle') : r?.code}
          {!isNew && <RequestStatusBadge status={status} />}
        </h1>
      </div>

      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {r?.rejectionNote && status === 'rejected' && <Callout tone="warning" title={t('procurement.requests.rejected')}>{r.rejectionNote}</Callout>}

      <Card>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <Field label={t('procurement.requests.project')} required>
            {(fid) => (
              <Combobox id={fid} disabled={!isNew} value={projectId || null} onChange={setProjectId} placeholder={t('procurement.requests.projectPlaceholder')}
                options={projects.filter((p) => p.status !== 'completed' && p.status !== 'cancelled').map((p) => ({ value: p.id, label: `${p.code} — ${p.name}`, keywords: `${p.code} ${p.name}` }))} />
            )}
          </Field>
          <Field label={t('procurement.requests.titleField')} required>{(fid) => <Input id={fid} value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} maxLength={200} />}</Field>
          <Field label={t('procurement.requests.needDate')}>{(fid) => <Input id={fid} type="date" value={needDate} onChange={(e) => setNeedDate(e.target.value)} disabled={!editable} />}</Field>
          <div className="sm:col-span-3">
            <Field label={t('procurement.requests.note')}>{(fid) => <Textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={!editable} maxLength={1000} />}</Field>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('procurement.requests.linesTitle')} description={t('procurement.requests.linesDesc', { currency: base })} />
        <LinesEditor projectId={projectId} lines={lines} onChange={setLines} disabled={!editable} priceLabel={t('procurement.requests.estPrice')} />
        <div className="flex justify-end border-t border-border px-4 py-3 text-sm">
          <span className="text-muted">{t('procurement.requests.estimatedTotal')}:&nbsp;</span>
          <span className="num">{money(editable || !r ? estimated.toFixed(2) : r.estimatedTotal)} {base}</span>
        </div>
      </Card>

      {detail && (detail.rfq || detail.orders.length > 0) && (
        <Card>
          <CardHeader title={t('procurement.requests.linked')} />
          <ul className="flex flex-col gap-2 p-4 text-sm">
            {detail.rfq && (
              <li className="flex items-center gap-2">
                <Link className="text-brand hover:underline" to={`/purchasing/rfqs/${detail.rfq.id}`}>{detail.rfq.code}</Link>
                <RfqStatusBadge status={detail.rfq.status} />
              </li>
            )}
            {detail.orders.map((o) => (
              <li key={o.id} className="flex items-center gap-2">
                <Link className="text-brand hover:underline" to={`/purchasing/orders/${o.id}`}>{o.code}</Link>
                <OrderStatusBadge status={o.status} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {detail && detail.approvals.length > 0 && (
        <Card>
          <CardHeader title={t('subcontracts.approval.historyTitle')} />
          <div className="flex flex-col gap-4 p-4">
            {detail.approvals.map((a) => (
              <div key={a.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm">
                  <ApprovalStatusBadge status={a.status} />
                  <span className="text-muted">{fmtDate(a.requestedAt)}</span>
                </div>
                <ol className="flex flex-col gap-1 text-sm">
                  {a.steps.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <span className="w-6 text-muted">{s.stepNo}.</span>
                      <span>{s.label ?? (s.approverRole ? t(`subcontracts.approval.roles.${s.approverRole}` as 'subcontracts.approval.roles.owner') : t('subcontracts.approval.defaultStep'))}</span>
                      <Badge tone={s.status === 'approved' ? 'success' : s.status === 'rejected' ? 'danger' : 'neutral'}>{t(`subcontracts.approval.stepStatus.${s.status}`)}</Badge>
                      {s.note && <span className="text-muted">— {s.note}</span>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {myTurn && pending && (
          <>
            <Input aria-label={t('subcontracts.approval.note')} className="w-64" placeholder={t('subcontracts.approval.note')} value={decideNote} onChange={(e) => setDecideNote(e.target.value)} />
            <Button variant="danger" loading={decide.isPending} onClick={() => go((o) => decide.mutate({ requestId: pending.id, decision: 'reject' }, o), () => toast.success(t('subcontracts.approval.rejectedToast')))}>{t('subcontracts.approval.reject')}</Button>
            <Button variant="primary" loading={decide.isPending} onClick={() => go((o) => decide.mutate({ requestId: pending.id, decision: 'approve' }, o), () => toast.success(t('subcontracts.approval.approvedToast')))}>{t('subcontracts.approval.approve')}</Button>
          </>
        )}
        {status === 'submitted' && can('procurement.manage') && (
          <Button loading={act.isPending} onClick={() => go((o) => act.mutate('withdraw', o), () => toast.success(t('procurement.requests.withdrawn')))}>{t('procurement.requests.withdraw')}</Button>
        )}
        {(status === 'approved' || status === 'rejected') && can('procurement.manage') && (
          <Button variant="danger" loading={act.isPending} onClick={() => go((o) => act.mutate('cancel', o), () => toast.success(t('procurement.requests.cancelled')))}>{t('procurement.requests.cancel')}</Button>
        )}
        {status === 'approved' && can('procurement.manage') && !detail?.rfq && (
          <Button onClick={() => { setDueDate(''); setRfqOpen(true); }}>{t('procurement.requests.createRfq')}</Button>
        )}
        {status === 'approved' && can('procurement.manage') && (
          <Button variant="primary" onClick={() => navigate(`/purchasing/orders/new?requestId=${id}`)}>{t('procurement.requests.createOrder')}</Button>
        )}
        {!isNew && status === 'draft' && can('procurement.manage') && (
          <Button variant="danger" loading={remove.isPending} onClick={() => go((o) => remove.mutate(undefined, o), () => { toast.success(t('common.deleted')); navigate('/purchasing/requests'); })}>{t('common.delete')}</Button>
        )}
        {editable && (
          <>
            <Button loading={save.isPending} disabled={invalid} onClick={() => go<PurchaseRequestDetail>((o) => save.mutate(undefined, o), (res) => { toast.success(t('common.saved')); if (isNew) navigate(`/purchasing/requests/${res.request.id}`, { replace: true }); })}>{t('procurement.requests.saveDraft')}</Button>
            <Button variant="primary" loading={submit.isPending} disabled={invalid} onClick={() => go<PurchaseRequestDetail>((o) => submit.mutate(undefined, o), (res) => { toast.success(t('procurement.requests.submitted')); navigate(`/purchasing/requests/${res.request.id}`, { replace: true }); })}>{t('procurement.requests.submit')}</Button>
          </>
        )}
      </div>

      <PrintSignatures labels={[t('printDoc.requester'), t('printDoc.siteChief'), t('printDoc.approved')]} />
      <PrintNote />

      <Modal
        open={rfqOpen}
        onOpenChange={setRfqOpen}
        title={t('procurement.requests.rfqTitle')}
        description={t('procurement.requests.rfqDesc')}
        footer={
          <>
            <Button onClick={() => setRfqOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={createRfq.isPending} onClick={() => go<RfqDetail>((o) => createRfq.mutate(undefined, o), (res) => { setRfqOpen(false); navigate(`/purchasing/rfqs/${res.rfq.id}`); })}>{t('procurement.requests.createRfq')}</Button>
          </>
        }
      >
        <Field label={t('procurement.rfqs.dueDate')}>{(fid) => <Input id={fid} type="date" min={todayIso()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}</Field>
      </Modal>
    </div>
  );
}
