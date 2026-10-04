import { ArrowLeft, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery, type useCompanyApi } from '../../lib/queries';
import type { ApprovalRequestRow, SubcontractRevisionDetail, VariationDetail, VariationLine, VariationReason } from '../../lib/types';
import { BoqEditor, type BoqBody } from './BoqEditor';
import { ApprovalStatusBadge, SUBCONTRACT_INVALIDATE, VARIATION_REASONS, VariationStatusBadge } from './common';
import { DeltaText } from './VariationsTab';
import { fmtDate } from '../../lib/license';

const qty = (v: string | null) => (v === null ? '—' : money(v, 4).replace(/,?0+$/, ''));
const CHANGE_TONE = { added: 'success', removed: 'danger', changed: 'warning', same: 'neutral' } as const;

/**
 * Değişiklik emri: başlık (gerekçe, süre uzatımı), BOQ değişikliği (sözleşme BOQ editörü), önceki/yeni karşılaştırması,
 * onay akışı ve işveren kabulü. Yazdırıldığında imzalı DE belgesidir.
 */
export function VariationPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const { data, isPending, error: loadError } = useCQuery<VariationDetail>(['variation', id], id ? `/api/variation-orders/${id}` : null);
  const vo = data?.variation;
  const revQ = useCQuery<SubcontractRevisionDetail>(['subcontract', vo?.subcontractId, 'revision', vo?.revisionId], vo?.revisionId ? `/api/subcontract-revisions/${vo.revisionId}` : null);
  const { data: inbox } = useCQuery<{ requests: ApprovalRequestRow[] }>(['approvals', 'inbox'], '/api/approvals/inbox');

  const editable = !!vo && (vo.status === 'draft' || vo.status === 'rejected') && !!vo.revisionId && can('subcontracts.manage');
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState<VariationReason>('client_request');
  const [days, setDays] = useState('0');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [decideNote, setDecideNote] = useState('');
  const [dialog, setDialog] = useState<'accept' | 'reject' | 'cancel' | null>(null);
  const [acceptedAt, setAcceptedAt] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [rejectNote, setRejectNote] = useState('');

  useEffect(() => {
    if (!vo) return;
    setTitle(vo.title);
    setReason(vo.reason);
    setDays(String(vo.timeExtensionDays));
    setDescription(vo.description ?? '');
  }, [vo]);

  const header = () => ({ title: title.trim(), reason, timeExtensionDays: Number(days || 0), description: description.trim() || null });
  const saveAll = async (body: BoqBody | null, call: ReturnType<typeof useCompanyApi>['call']) => {
    await call(`/api/variation-orders/${id}`, { method: 'PUT', body: header() });
    if (body && vo?.revisionId) await call(`/api/subcontract-revisions/${vo.revisionId}/lines`, { method: 'PUT', body: { lines: body } });
  };
  const save = useCMutation(async (body: BoqBody | null, call) => saveAll(body, call), SUBCONTRACT_INVALIDATE);
  // Gönderim ekrandaki son hâli de kaydeder (kaydedilmemiş değişiklik sessizce atlanmasın)
  const submit = useCMutation(async (body: BoqBody | null, call) => {
    await saveAll(body, call);
    return call(`/api/variation-orders/${id}/submit`, { method: 'POST', body: {} });
  }, SUBCONTRACT_INVALIDATE);
  const cancel = useCMutation((_: void, call) => call(`/api/variation-orders/${id}`, { method: 'DELETE' }), SUBCONTRACT_INVALIDATE);
  const accept = useCMutation((_: void, call) => call(`/api/variation-orders/${id}/client-accept`, { method: 'POST', body: { acceptedAt, reference: reference.trim() } }), SUBCONTRACT_INVALIDATE);
  const clientReject = useCMutation((_: void, call) => call(`/api/variation-orders/${id}/client-reject`, { method: 'POST', body: { note: rejectNote.trim() } }), SUBCONTRACT_INVALIDATE);
  const decide = useCMutation(
    (v: { requestId: string; decision: 'approve' | 'reject' }, call) =>
      call(`/api/approvals/${v.requestId}/decide`, { method: 'POST', body: { decision: v.decision, ...(decideNote.trim() ? { note: decideNote.trim() } : {}) } }),
    SUBCONTRACT_INVALIDATE,
  );

  const run = <V,>(m: { mutate: (v: V, o: { onSuccess: () => void; onError: (e: Error) => void }) => void }, v: V, done: string, after?: () => void) => {
    setError(null);
    m.mutate(v, { onSuccess: () => { toast.success(done); after?.(); }, onError: (e) => { setError(e); setDialog(null); } });
  };

  if (loadError instanceof ApiError && loadError.status === 404) {
    return <EmptyState title={t('variations.notFound')} action={<Button onClick={() => navigate('/variation-orders')}><ArrowLeft className="size-4" aria-hidden />{t('variations.back')}</Button>} />;
  }
  if (isPending || !data || !vo) return <PageLoading />;
  const cur = vo.currencyCode;
  const receivable = vo.direction === 'receivable';
  const pending = data.approvals.find((a) => a.status === 'pending');
  const myTurn = !!pending && !!inbox?.requests.some((r) => r.id === pending.id);
  const headerValid = title.trim().length >= 2 && Number.isInteger(Number(days)) && Number(days) >= 0;
  const endDate = vo.status === 'applied' ? vo.newEndDate : vo.projectedEndDate ?? vo.contractEndDate;
  const changed = data.lines.filter((l) => l.change !== 'same');

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to={`/subcontracts/${vo.subcontractId}`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {vo.subcontractCode} — {vo.subcontractTitle}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex flex-wrap items-center gap-3 text-2xl">
              <span className="font-mono text-[15px] text-muted">{vo.code}</span>
              {t('variations.docTitle')}
              <VariationStatusBadge status={vo.status} />
            </h1>
            <p className="mt-1 text-sm text-muted">
              {vo.partyName} ({receivable ? t('variations.direction.receivable') : t('variations.direction.payable')}) · {vo.projectCode} {vo.projectName}
              {vo.revisionNo ? ` · ${t('variations.revisionInfo', { base: vo.baseRevisionNo, rev: vo.revisionNo })}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <ExportMenu exportKey="variation-order" params={{ id: vo.id }} print={false} />
            <Button onClick={() => window.print()}>
              <Printer className="size-4" aria-hidden />
              {t('variations.print')}
            </Button>
          </div>
        </div>
      </div>

      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {vo.status === 'rejected' && vo.rejectionNote && <Callout tone="warning" title={t('variations.rejectedTitle')}>{vo.rejectionNote}</Callout>}
      {vo.status === 'awaiting_client' && <Callout tone="info" title={t('variations.awaitingTitle')}>{t('variations.awaitingBody')}</Callout>}
      {vo.status === 'submitted' && <Callout tone="info">{t('variations.submittedBody')}</Callout>}
      {editable && <Callout tone="info">{t('variations.editHint')}</Callout>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('variations.kpi.before')}>{moneyIn(vo.amountBefore, cur)}</Stat>
        <Stat label={t('variations.kpi.delta')}><DeltaText value={vo.amountDelta} currency={cur} /></Stat>
        <Stat label={t('variations.kpi.after')}>{moneyIn(vo.amountAfter, cur)}</Stat>
        <Stat
          label={t('variations.kpi.time')}
          sub={endDate ? t(vo.status === 'applied' ? 'variations.kpi.timeApplied' : 'variations.kpi.timeProjected', { date: formatDateTR(endDate) }) : t('variations.kpi.noEnd')}
        >
          {vo.timeExtensionDays > 0 ? t('variations.daysValue', { n: vo.timeExtensionDays }) : t('variations.kpi.noExtension')}
        </Stat>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <Field label={t('variations.form.title')} required>
            {(fid) => <Input id={fid} value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} maxLength={200} />}
          </Field>
          <Field label={t('variations.form.reason')} required>
            {(fid) => (
              <Select id={fid} value={reason} onChange={(e) => setReason(e.target.value as VariationReason)} disabled={!editable}>
                {VARIATION_REASONS.map((r) => <option key={r} value={r}>{t(`variations.reasons.${r}`)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('variations.form.days')} hint={t('variations.form.daysHint')}>
            {(fid) => <Input id={fid} inputMode="numeric" className="num text-right" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} disabled={!editable} />}
          </Field>
          <div className="sm:col-span-3">
            <Field label={t('variations.form.description')}>
              {(fid) => <Textarea id={fid} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} maxLength={2000} />}
            </Field>
          </div>
          {vo.clientAcceptedAt && (
            <p className="text-sm text-muted sm:col-span-3">{t('variations.clientAccepted', { date: formatDateTR(vo.clientAcceptedAt), ref: vo.clientReference })}</p>
          )}
        </div>
      </Card>

      {editable && revQ.data && (
        <div className="print:hidden">
          <BoqEditor
            data={revQ.data}
            projectId={vo.projectId}
            currencyCode={cur}
            editable
            title={t('variations.boqTitle', { rev: vo.revisionNo })}
            description={t('variations.boqDesc')}
            footer={({ body, valid }) => (
              <div className="flex flex-wrap justify-end gap-2 border-t border-border p-4">
                <Button variant="danger" onClick={() => setDialog('cancel')}>{t('variations.cancel')}</Button>
                <Button loading={save.isPending} disabled={!valid || !headerValid} onClick={() => run(save, body, t('variations.saved'))}>{t('variations.save')}</Button>
                <Button variant="primary" loading={submit.isPending} disabled={!valid || !headerValid} onClick={() => run(submit, body, t('variations.submittedToast'))}>{t('variations.submit')}</Button>
              </div>
            )}
          />
        </div>
      )}
      {editable && !revQ.data && <PageLoading />}

      <Card>
        <CardHeader title={t('variations.compareTitle')} description={t('variations.compareDesc', { n: changed.length })} />
        <TableWrap className="rounded-none border-0">
          <Table>
            <thead>
              <tr>
                <Th className="w-16">{t('subcontracts.boq.cols.itemNo')}</Th>
                <Th>{t('subcontracts.boq.cols.description')}</Th>
                <Th num className="w-24">{t('variations.compare.oldQty')}</Th>
                <Th num className="w-24">{t('variations.compare.newQty')}</Th>
                <Th num className="w-28">{t('variations.compare.oldPrice')}</Th>
                <Th num className="w-28">{t('variations.compare.newPrice')}</Th>
                <Th num className="w-32">{t('variations.compare.oldAmount')}</Th>
                <Th num className="w-32">{t('variations.compare.newAmount')}</Th>
                <Th num className="w-32">{t('variations.compare.delta')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l: VariationLine) => (
                <Tr key={l.lineKey} className={cn(l.change === 'same' && 'text-muted')}>
                  <Td className="font-mono text-[13px] text-muted">{l.itemNo}</Td>
                  <Td>
                    {l.description} <span className="text-xs text-muted">({l.unit})</span>
                    {l.change !== 'same' && <Badge tone={CHANGE_TONE[l.change]} className="ml-2">{t(`variations.change.${l.change}`)}</Badge>}
                  </Td>
                  <Td num>{qty(l.oldQty)}</Td>
                  <Td num className={cn(l.oldQty !== l.newQty && 'font-medium')}>{qty(l.newQty)}</Td>
                  <Td num>{l.oldPrice === null ? '—' : money(l.oldPrice)}</Td>
                  <Td num className={cn(l.oldPrice !== l.newPrice && 'font-medium')}>{l.newPrice === null ? '—' : money(l.newPrice)}</Td>
                  <Td num>{l.oldAmount === null ? '—' : money(l.oldAmount)}</Td>
                  <Td num>{l.newAmount === null ? '—' : money(l.newAmount)}</Td>
                  <Td num>{l.change === 'same' ? '—' : <DeltaText value={l.delta} currency={cur} />}</Td>
                </Tr>
              ))}
              <Tr className="border-t border-text bg-surface-2">
                <Td colSpan={6}>{t('common.total')}</Td>
                <Td num>{moneyIn(vo.amountBefore, cur)}</Td>
                <Td num>{moneyIn(vo.amountAfter, cur)}</Td>
                <Td num><DeltaText value={vo.amountDelta} currency={cur} /></Td>
              </Tr>
            </tbody>
          </Table>
        </TableWrap>
        {vo.status !== 'applied' && vo.status !== 'cancelled' && <p className="px-4 pb-4 text-xs text-muted print:hidden">{t('variations.compareLive')}</p>}
      </Card>

      {data.approvals.length > 0 && (
        <Card className="print:hidden">
          <CardHeader title={t('subcontracts.approval.historyTitle')} />
          <div className="flex flex-col gap-4 p-4">
            {data.approvals.map((a) => (
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

      <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
        {myTurn && pending && (
          <>
            <Input aria-label={t('subcontracts.approval.note')} className="w-64" placeholder={t('subcontracts.approval.note')} value={decideNote} onChange={(e) => setDecideNote(e.target.value)} />
            <Button variant="danger" loading={decide.isPending} onClick={() => run(decide, { requestId: pending.id, decision: 'reject' as const }, t('subcontracts.approval.rejectedToast'))}>
              {t('subcontracts.approval.reject')}
            </Button>
            <Button variant="primary" loading={decide.isPending} onClick={() => run(decide, { requestId: pending.id, decision: 'approve' as const }, t('subcontracts.approval.approvedToast'))}>
              {t('subcontracts.approval.approve')}
            </Button>
          </>
        )}
        {vo.status === 'awaiting_client' && can('subcontracts.manage') && (
          <>
            <Button variant="danger" onClick={() => { setRejectNote(''); setDialog('reject'); }}>{t('variations.clientReject')}</Button>
            <Button variant="primary" onClick={() => { setReference(''); setAcceptedAt(todayIso()); setDialog('accept'); }}>{t('variations.clientAccept')}</Button>
          </>
        )}
        {(vo.status === 'submitted' || vo.status === 'awaiting_client') && can('subcontracts.manage') && (
          <Button onClick={() => setDialog('cancel')}>{t('variations.cancel')}</Button>
        )}
      </div>

      <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.siteChief'), t('printDoc.approved'), receivable ? t('printDoc.employer') : t('printDoc.subcontractor')]} />
      <PrintNote />

      <Modal
        open={dialog === 'accept'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t('variations.acceptTitle')}
        description={t('variations.acceptDesc')}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={accept.isPending} disabled={!reference.trim() || !acceptedAt} onClick={() => run(accept, undefined, t('variations.acceptedToast'), () => setDialog(null))}>
              {t('variations.clientAccept')}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('variations.acceptedAt')} required>{(fid) => <Input id={fid} type="date" value={acceptedAt} onChange={(e) => setAcceptedAt(e.target.value)} />}</Field>
          <Field label={t('variations.reference')} required hint={t('variations.referenceHint')}>{(fid) => <Input id={fid} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />}</Field>
        </div>
      </Modal>
      <Modal
        open={dialog === 'reject'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t('variations.clientRejectTitle')}
        description={t('variations.clientRejectDesc')}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={clientReject.isPending} disabled={rejectNote.trim().length < 3} onClick={() => run(clientReject, undefined, t('variations.clientRejectedToast'), () => setDialog(null))}>
              {t('variations.clientReject')}
            </Button>
          </>
        }
      >
        <Field label={t('variations.rejectNote')} required>{(fid) => <Input id={fid} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} maxLength={500} />}</Field>
      </Modal>
      <Modal
        open={dialog === 'cancel'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t('variations.cancelTitle')}
        description={t('variations.cancelDesc')}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={cancel.isPending} onClick={() => run(cancel, undefined, t('variations.cancelledToast'), () => setDialog(null))}>
              {t('variations.cancel')}
            </Button>
          </>
        }
      >
        <span />
      </Modal>
    </div>
  );
}
