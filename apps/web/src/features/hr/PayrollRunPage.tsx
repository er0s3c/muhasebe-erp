import { PAYROLL_PARAM_META, todayIso } from '@erp/shared';
import { AlertTriangle, ArrowLeft, Calculator, CheckCircle2, FileText, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { PayrollItemRow, PayrollLineRow, PayrollRunDetail } from '../../lib/types';
import { formatParamValue, PAYROLL_INVALIDATE, PayrollStatusBadge, UnverifiedBadge, useWarningText } from './payroll-common';

type DoneKey = 'payroll.run.approved' | 'payroll.run.paid' | 'payroll.run.unpaid' | 'payroll.run.cancelled';
type Dlg = null | 'approve' | 'pay' | 'unpay' | 'cancel' | 'delete';

/** Bordro çalıştırması: satırlar, elle ek ödeme/kesinti, onay (yevmiye), ödeme takibi, iptal. */
export function PayrollRunPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const manage = can('hr.payroll_manage');
  const { data, isPending, error: loadError } = useCQuery<PayrollRunDetail>(['payroll', 'run', id], `/api/payroll/runs/${id}`);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [text, setText] = useState('');
  const [paidAt, setPaidAt] = useState(todayIso());
  const [error, setError] = useState<Error | null>(null);
  const [adjusting, setAdjusting] = useState<PayrollLineRow | null>(null);
  const warningText = useWarningText();

  const act = useCMutation((v: { path: string; body?: unknown }, call) => call<PayrollRunDetail>(`/api/payroll/runs/${id}/${v.path}`, { method: 'POST', body: v.body ?? {} }), PAYROLL_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/payroll/runs/${id}`, { method: 'DELETE' }), PAYROLL_INVALIDATE);

  if (isPending) return <PageLoading />;
  if (!data) return <Callout tone="danger">{errorMessage(loadError)}</Callout>;
  const { run, lines, missingTerms, lock } = data;
  const draft = run.status === 'draft';
  const money2 = (v: string) => money(v);
  const warned = lines.filter((l) => l.warnings.length > 0).length;

  const open = (d: Dlg) => {
    setError(null);
    setText('');
    setDlg(d);
  };
  const run1 = (path: string, body: unknown, done: DoneKey) =>
    act.mutate({ path, body }, { onSuccess: () => { toast.success(t(done)); setDlg(null); }, onError: setError });
  const doDelete = () => remove.mutate(undefined, { onSuccess: () => { toast.success(t('payroll.run.deleted')); navigate('/hr/payroll'); }, onError: setError });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/hr/payroll" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {t('payroll.title')}
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl">
          {t('payroll.run.title', { month: run.month })}
          <span className="font-mono text-[15px] text-muted">{run.number}</span>
          <PayrollStatusBadge status={run.status} />
          {run.hasUnverifiedParams && <UnverifiedBadge />}
        </h1>
      </div>

      <Callout tone="warning">{t('payroll.notice')}</Callout>
      {error && !dlg && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {run.hasUnverifiedParams && <Callout tone="warning">{t('payroll.run.unverifiedWarn')}</Callout>}
      {!run.hasUnverifiedParams && run.paramsSnapshot.length === 0 && <Callout tone="info">{t('payroll.run.noParams')}</Callout>}
      {draft && !lock.closed && (
        <Callout tone="warning" action={<Link to="/hr/attendance" className="text-sm underline">{t('payroll.run.toAttendance')}</Link>}>
          {t('payroll.run.monthOpen', { month: run.month })}
        </Callout>
      )}
      {draft && lock.closed && <Callout tone="info">{t('payroll.run.monthClosed', { month: run.month })}</Callout>}
      {run.status === 'approved' || run.status === 'paid' ? (
        <Callout tone="info">{t('payroll.run.postedInfo', { no: run.entryNo ?? '—' })}</Callout>
      ) : null}
      {run.status === 'paid' && <Callout tone="info">{t('payroll.run.paidInfo', { date: run.paidAt ?? '' })}{run.paidNote ? ` — ${run.paidNote}` : ''}</Callout>}
      {run.status === 'cancelled' && <Callout tone="danger" title={t('payroll.run.cancelledTitle')}>{run.cancelReason}</Callout>}
      {draft && missingTerms.length > 0 && (
        <Callout tone="warning" action={<Link to="/hr/payroll/settings" className="text-sm underline">{t("payroll.run.toTerms")}</Link>}>
          {t('payroll.run.missingTerms', { count: missingTerms.length })}: {missingTerms.map((m) => `${m.code} ${m.fullName}`).join(', ')}
        </Callout>
      )}
      {warned > 0 && <Callout tone="warning">{t('payroll.run.warned', { count: warned })}</Callout>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={t('payroll.cols.gross')}>{money2(run.grossTotal)}</Stat>
        <Stat label={t('payroll.cols.deductions')}>{money2(run.deductionsTotal)}</Stat>
        <Stat label={t('payroll.cols.net')}>{money2(run.netTotal)}</Stat>
        <Stat label={t('payroll.cols.employer')} sub={t('payroll.run.employerSub')}>{money2(run.employerTotal)}</Stat>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
        <ExportMenu exportKey="payroll-register" params={{ id }} print={false} disabled={lines.length === 0} />
        {manage && draft && (
          <>
            <Button variant="danger" onClick={() => open('delete')}>{t('common.delete')}</Button>
            <Button loading={act.isPending} onClick={() => act.mutate({ path: 'calculate' }, { onSuccess: () => toast.success(t('payroll.run.recalculated')), onError: setError })}>
              <Calculator className="size-4" aria-hidden />
              {t('payroll.run.recalculate')}
            </Button>
            <Button variant="primary" disabled={!lock.closed || lines.length === 0} title={!lock.closed ? t('payroll.run.monthOpen', { month: run.month }) : undefined} onClick={() => open('approve')}>
              <CheckCircle2 className="size-4" aria-hidden />
              {t('payroll.run.approve')}
            </Button>
          </>
        )}
        {manage && run.status === 'approved' && (
          <>
            <Button variant="danger" onClick={() => open('cancel')}>{t('payroll.run.cancel')}</Button>
            <Button variant="primary" onClick={() => open('pay')}>{t('payroll.run.markPaid')}</Button>
          </>
        )}
        {manage && run.status === 'paid' && <Button onClick={() => open('unpay')}>{t('payroll.run.unpay')}</Button>}
      </div>

      <TableWrap>
        <Table aria-label={t('payroll.run.linesTitle')}>
          <thead>
            <tr>
              <Th>{t('payroll.line.employee')}</Th>
              <Th>{t('payroll.line.basis')}</Th>
              <Th num>{t('payroll.line.hours')}</Th>
              <Th num>{t('payroll.cols.gross')}</Th>
              <Th num>{t('payroll.cols.deductions')}</Th>
              <Th num>{t('payroll.cols.net')}</Th>
              <Th num>{t('payroll.cols.employer')}</Th>
              <Th className="w-40"><span className="sr-only">{t('common.actions')}</span></Th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <Td colSpan={8} className="text-muted">{t('payroll.run.noLines')}</Td>
              </tr>
            )}
            {lines.map((l) => (
              <Tr key={l.id}>
                <Td className="whitespace-nowrap">
                  <span className="font-mono text-[12px] text-muted">{l.employeeCode}</span> {l.employeeName}
                  {l.warnings.length > 0 && (
                    <span className="ml-2 inline-flex items-center text-warning" title={l.warnings.map(warningText).join('\n')}>
                      <AlertTriangle className="size-4" aria-label={t('payroll.line.warnings')} />
                    </span>
                  )}
                </Td>
                <Td className="text-muted">{t(`payroll.basis.${l.payBasis}`)} · {money2(l.rate)}</Td>
                <Td num>{money(l.normalHours)}{Number(l.overtimeHours) > 0 ? ` + ${money(l.overtimeHours)}` : ''}</Td>
                <Td num>{money2(l.gross)}</Td>
                <Td num>{money2(l.deductionsTotal)}</Td>
                <Td num className={Number(l.net) < 0 ? 'text-danger' : undefined}>{money2(l.net)}</Td>
                <Td num>{money2(l.employerTotal)}</Td>
                <Td>
                  <div className="flex justify-end gap-2 print:hidden">
                    {manage && draft && (
                      <Button size="sm" aria-label={t('payroll.adjust.open', { name: l.employeeName })} onClick={() => { setError(null); setAdjusting(l); }}>
                        <Plus className="size-4" aria-hidden />
                        {t('payroll.adjust.short')}
                      </Button>
                    )}
                    <Link to={`/hr/payroll/${run.id}/slip/${l.employeeId}`} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-surface-2" aria-label={t('payroll.slip.open', { name: l.employeeName })}>
                      <FileText className="size-4" aria-hidden />
                      {t('payroll.slip.short')}
                    </Link>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>

      {run.paramsSnapshot.length > 0 && (
        <Card>
          <CardHeader title={t('payroll.run.usedParams')} description={t('payroll.run.usedParamsDesc')} />
          <ul className="flex flex-col gap-1.5 p-4 text-sm">
            {run.paramsSnapshot.map((p) => (
              <li key={p.key} className="flex flex-wrap items-center gap-2">
                <span>{t(`payroll.params.keys.${p.key}`)}</span>
                <span className="font-mono">{formatParamValue(PAYROLL_PARAM_META[p.key].unit, p.value)}</span>
                {p.verified ? <Badge tone="success">{t('payroll.params.verified')}</Badge> : <UnverifiedBadge />}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={dlg === 'approve'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={t('payroll.run.approveTitle')}
        description={t('payroll.run.approveDesc', { month: run.month })}
        footer={
          <>
            <Button onClick={() => setDlg(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={act.isPending} onClick={() => run1('approve', {}, 'payroll.run.approved')}>
              {t('payroll.run.approve')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          {run.hasUnverifiedParams && <Callout tone="warning">{t('payroll.run.unverifiedWarn')}</Callout>}
          <p className="text-sm text-muted">{t('payroll.run.approveHint')}</p>
        </div>
      </Modal>

      <Modal
        open={dlg === 'pay'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={t('payroll.run.payTitle')}
        description={t('payroll.run.payDesc')}
        footer={
          <>
            <Button onClick={() => setDlg(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={act.isPending} disabled={!paidAt} onClick={() => run1('pay', { paidAt, ...(text.trim() ? { note: text.trim() } : {}) }, 'payroll.run.paid')}>
              {t('payroll.run.markPaid')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('payroll.run.paidAt')} required>{(fid) => <Input id={fid} type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />}</Field>
          <Field label={t('payroll.run.paidNote')}>{(fid) => <Textarea id={fid} rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        </div>
      </Modal>

      <Modal
        open={dlg === 'unpay' || dlg === 'cancel'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={dlg === 'cancel' ? t('payroll.run.cancelTitle') : t('payroll.run.unpayTitle')}
        description={dlg === 'cancel' ? t('payroll.run.cancelDesc') : t('payroll.run.unpayDesc')}
        footer={
          <>
            <Button onClick={() => setDlg(null)}>{t('common.cancel')}</Button>
            <Button
              variant={dlg === 'cancel' ? 'danger' : 'primary'}
              loading={act.isPending}
              disabled={text.trim().length < 3}
              onClick={() => run1(dlg === 'cancel' ? 'cancel' : 'unpay', { reason: text.trim() }, dlg === 'cancel' ? 'payroll.run.cancelled' : 'payroll.run.unpaid')}
            >
              {dlg === 'cancel' ? t('payroll.run.cancel') : t('payroll.run.unpay')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('payroll.run.reason')} required>{(fid) => <Textarea id={fid} rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        </div>
      </Modal>

      <Modal
        open={dlg === 'delete'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={t('payroll.run.deleteTitle')}
        description={t('payroll.run.deleteDesc')}
        footer={
          <>
            <Button onClick={() => setDlg(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={remove.isPending} onClick={doDelete}>{t('common.delete')}</Button>
          </>
        }
      >
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      </Modal>

      {adjusting && <AdjustModal runId={id} line={adjusting} detail={data} onClose={() => setAdjusting(null)} />}
    </div>
  );
}

/** Personel için elle ek ödeme / kesinti: kalem seç, tutar yaz; yeniden hesaplama sunucuda yapılır. */
function AdjustModal({ runId, line, detail, onClose }: { runId: string; line: PayrollLineRow; detail: PayrollRunDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const { data } = useCQuery<{ items: PayrollItemRow[] }>(['payroll', 'items'], '/api/payroll/items');
  const items = (data?.items ?? []).filter((i) => i.isActive);
  const [itemId, setItemId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const add = useCMutation((_: void, call) => call(`/api/payroll/runs/${runId}/adjustments`, { method: 'PUT', body: { employeeId: line.employeeId, itemId, amount: amount.replace(',', '.'), ...(note.trim() ? { note: note.trim() } : {}) } }), PAYROLL_INVALIDATE);
  const del = useCMutation((adjId: string, call) => call(`/api/payroll/runs/${runId}/adjustments/${adjId}`, { method: 'DELETE' }), PAYROLL_INVALIDATE);
  const mine = detail.adjustments.filter((a) => a.employeeId === line.employeeId);
  const valid = !!itemId && /^\d{1,15}([.,]\d{1,4})?$/.test(amount.trim());

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('payroll.adjust.title', { name: line.employeeName })}
      description={t('payroll.adjust.desc')}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {items.length === 0 ? (
          <Callout tone="info" action={<Link to="/hr/payroll/settings" className="text-sm underline">{t('payroll.adjust.toItems')}</Link>}>{t('payroll.adjust.noItems')}</Callout>
        ) : (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_8rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setAmount(''); setNote(''); }, onError: setError });
            }}
          >
            <Field label={t('payroll.adjust.item')}>
              {(fid) => (
                <Select id={fid} value={itemId} onChange={(e) => setItemId(e.target.value)}>
                  <option value="">{t('payroll.adjust.pick')}</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>{i.code} — {i.name} ({t(`payroll.items.kinds.${i.kind}`)})</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('payroll.adjust.amount')}>{(fid) => <Input id={fid} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!valid}>{t('common.add')}</Button>
            <div className="sm:col-span-3">
              <Field label={t('payroll.adjust.note')}>{(fid) => <Input id={fid} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            </div>
          </form>
        )}
        {mine.length > 0 && (
          <ul className="flex flex-col gap-1.5 text-sm" aria-label={t('payroll.adjust.list')}>
            {mine.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5">
                <span>
                  {a.itemCode} — {a.itemName} <Badge className="ml-1">{t(`payroll.items.kinds.${a.kind}`)}</Badge>
                  {a.note ? <span className="ml-2 text-muted">{a.note}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <span className="num">{money(a.amount)}</span>
                  <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger" aria-label={t('common.delete')} onClick={() => del.mutate(a.id, { onError: setError })}>
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
