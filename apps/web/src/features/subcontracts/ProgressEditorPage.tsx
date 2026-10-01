import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { computeProgress, dec, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { ApprovalRequestRow, ProgressDetail, SubcontractBalances } from '../../lib/types';
import { ApprovalStatusBadge, ProgressStatusBadge, SUBCONTRACT_INVALIDATE } from './common';

interface Basis {
  subcontract: { id: string; code: string; title: string; status: string; direction: 'payable' | 'receivable'; currencyCode: string; paymentDays: number; retentionPct: string; advanceRecoupPct: string; withholdingPct: string };
  lines: { lineKey: string; lineNo: number; itemNo: string | null; description: string; unit: string; quantity: string; unitPrice: string; prevQty: string; wbsCode: string; costCode: string | null }[];
  balances: SubcontractBalances;
}
interface TaxRate {
  id: string;
  code: string;
  name: string;
  rate: string;
  validFrom: string;
  validTo: string | null;
  verifiedAt: string | null;
}
interface DeductionDraft {
  key: string;
  description: string;
  amount: string;
}

const qtyText = (v: string) => String(Number(v));

export function ProgressEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const isNew = !id || id === 'new';

  const detailQ = useCQuery<ProgressDetail>(['progress', id], isNew ? null : `/api/progress-payments/${id}`);
  const subcontractId = isNew ? params.get('subcontractId') : detailQ.data?.payment.subcontractId ?? null;
  const basisQ = useCQuery<Basis>(['subcontract', subcontractId, 'basis'], subcontractId ? `/api/subcontracts/${subcontractId}/progress-basis` : null);
  const { data: taxData } = useCQuery<{ taxRates: TaxRate[] }>(['tax-rates'], '/api/tax-rates');
  const { data: inbox } = useCQuery<{ requests: ApprovalRequestRow[] }>(['approvals', 'inbox'], '/api/approvals/inbox');

  const detail = detailQ.data;
  const basis = basisQ.data;
  const status = isNew ? 'draft' : detail?.payment.status ?? 'draft';
  const editable = status === 'draft' && can('subcontracts.manage');

  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [vatCode, setVatCode] = useState('');
  const [note, setNote] = useState('');
  const [cum, setCum] = useState<Record<string, string>>({});
  const [deductions, setDeductions] = useState<DeductionDraft[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [decideNote, setDecideNote] = useState('');

  // Form durumu: taslaktan ya da (yeni hakedişte) önceki kümülatiften başlar
  useEffect(() => {
    if (!basis) return;
    if (detail) {
      setPeriodEnd(detail.payment.periodEnd);
      setVatCode(detail.payment.vatCode ?? '');
      setNote(detail.payment.note ?? '');
      setDeductions(detail.deductions.map((d) => ({ key: d.id, description: d.description, amount: d.amount })));
      const next: Record<string, string> = {};
      for (const l of basis.lines) next[l.lineKey] = qtyText(detail.lines.find((x) => x.lineKey === l.lineKey)?.cumQty ?? l.prevQty);
      setCum(next);
    } else if (isNew) {
      setCum(Object.fromEntries(basis.lines.map((l) => [l.lineKey, qtyText(l.prevQty)])));
    }
  }, [basis, detail, isNew]);

  const vatOptions = useMemo(() => {
    const seen = new Map<string, TaxRate>();
    for (const r of [...(taxData?.taxRates ?? [])].sort((a, b) => b.validFrom.localeCompare(a.validFrom))) {
      if (r.validFrom <= periodEnd && (!r.validTo || r.validTo >= periodEnd) && !seen.has(r.code)) seen.set(r.code, r);
    }
    return [...seen.values()];
  }, [taxData, periodEnd]);

  const cur = basis?.subcontract.currencyCode ?? detail?.payment.currencyCode ?? 'TRY';
  const rows = (basis?.lines ?? []).map((l) => {
    const c = cum[l.lineKey] ?? qtyText(l.prevQty);
    const thisQty = Math.max(Number(c) - Number(l.prevQty), 0);
    return { ...l, cum: c, thisQty, over: Number(c) > Number(l.quantity), below: Number(c) < Number(l.prevQty) };
  });
  const active = rows.filter((r) => r.thisQty > 0);
  const calc = useMemo(
    () =>
      basis
        ? computeProgress({
            lines: active.map((r) => ({ thisQty: String(r.thisQty), unitPrice: r.unitPrice })),
            vatRate: vatOptions.find((v) => v.code === vatCode)?.rate ?? '0',
            retentionPct: detail?.payment.retentionPct ?? basis.subcontract.retentionPct,
            advancePct: detail?.payment.advancePct ?? basis.subcontract.advanceRecoupPct,
            withholdingPct: detail?.payment.withholdingPct ?? basis.subcontract.withholdingPct,
            advanceBalance: basis.balances.advanceBalance,
            deductions: deductions.map((d) => d.amount.replace(',', '.') || '0'),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [basis, detail, vatCode, vatOptions, deductions, JSON.stringify(active.map((r) => [r.lineKey, r.thisQty]))],
  );
  const invalid = rows.some((r) => r.over || r.below) || active.length === 0 || deductions.some((d) => !d.description.trim() || !(Number(d.amount.replace(',', '.')) > 0)) || (calc ? calc.net.isNegative() : true);

  const body = () => ({
    periodEnd,
    vatCode: vatCode || null,
    note: note.trim() || null,
    lines: rows.map((r) => ({ lineKey: r.lineKey, cumulativeQty: r.cum })),
    deductions: deductions.map((d) => ({ description: d.description.trim(), amount: d.amount.replace(',', '.') })),
  });

  const save = useCMutation(async (_: void, call) => {
    if (isNew) return call<ProgressDetail>('/api/progress-payments', { method: 'POST', body: { subcontractId, ...body() } });
    return call<ProgressDetail>(`/api/progress-payments/${id}`, { method: 'PUT', body: body() });
  }, SUBCONTRACT_INVALIDATE);
  const submit = useCMutation(async (_: void, call) => {
    const saved = isNew
      ? await call<ProgressDetail>('/api/progress-payments', { method: 'POST', body: { subcontractId, ...body() } })
      : await call<ProgressDetail>(`/api/progress-payments/${id}`, { method: 'PUT', body: body() });
    return call<ProgressDetail>(`/api/progress-payments/${saved.payment.id}/submit`, { method: 'POST', body: {} });
  }, SUBCONTRACT_INVALIDATE);
  const withdraw = useCMutation((_: void, call) => call(`/api/progress-payments/${id}/withdraw`, { method: 'POST', body: {} }), SUBCONTRACT_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/progress-payments/${id}`, { method: 'DELETE' }), SUBCONTRACT_INVALIDATE);
  const cancel = useCMutation((_: void, call) => call(`/api/progress-payments/${id}/cancel`, { method: 'POST', body: { reason: cancelReason.trim() } }), SUBCONTRACT_INVALIDATE);
  const decide = useCMutation((v: { requestId: string; decision: 'approve' | 'reject' }, call) => call(`/api/approvals/${v.requestId}/decide`, { method: 'POST', body: { decision: v.decision, ...(decideNote.trim() ? { note: decideNote.trim() } : {}) } }), SUBCONTRACT_INVALIDATE);

  const run = <T,>(m: { mutate: (v: undefined, o: { onSuccess: (r: T) => void; onError: (e: Error) => void }) => void }, onOk: (r: T) => void) => {
    setError(null);
    m.mutate(undefined, { onSuccess: onOk, onError: setError });
  };

  if ((!isNew && detailQ.isPending) || basisQ.isPending || !basis || (!isNew && !detail)) {
    if (subcontractId === null && isNew) return <Callout tone="warning">{t('subcontracts.progress.noContract')}</Callout>;
    return <PageLoading />;
  }

  const p = detail?.payment;
  const receivable = (p?.direction ?? basis.subcontract.direction) === 'receivable';
  const pending = detail?.approvals.find((a) => a.status === 'pending');
  const myTurn = !!pending && !!inbox?.requests.some((r) => r.id === pending.id);
  const money2 = (v: string | undefined) => moneyIn(v ?? '0', cur);
  const view = {
    gross: editable || !p ? calc?.gross.toFixed(2) : p.gross,
    vat: editable || !p ? calc?.vat.toFixed(2) : p.vat,
    retention: editable || !p ? calc?.retention.toFixed(2) : p.retention,
    advance: editable || !p ? calc?.advance.toFixed(2) : p.advance,
    withholding: editable || !p ? calc?.withholding.toFixed(2) : p.withholding,
    other: editable || !p ? calc?.otherDeductions.toFixed(2) : p.otherDeductions,
    net: editable || !p ? calc?.net.toFixed(2) : p.net,
  };
  const pct = (v: string) => `%${Number(v)}`;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to={`/subcontracts/${basis.subcontract.id}`} className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {basis.subcontract.code} — {basis.subcontract.title}
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl">
          {isNew ? (receivable ? t('subcontracts.employer.claimNew') : t('subcontracts.progress.newTitle')) : receivable ? t('subcontracts.employer.claimEdit', { no: p?.paymentNo }) : t('subcontracts.progress.editTitle', { no: p?.paymentNo })}
          {p?.number && <span className="font-mono text-[15px] text-muted">{p.number}</span>}
          <ProgressStatusBadge status={status} />
        </h1>
      </div>

      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {p?.rejectionNote && status === 'draft' && <Callout tone="warning" title={t('subcontracts.progress.rejected')}>{p.rejectionNote}</Callout>}
      {p?.status === 'cancelled' && <Callout tone="danger" title={t('subcontracts.progress.cancelledTitle')}>{p.cancelReason}</Callout>}
      <Callout tone="info">{t('subcontracts.progress.legalNote')}</Callout>

      <Card>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <Field label={t('subcontracts.progress.periodEnd')} required>
            {(fid) => <Input id={fid} type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} disabled={!editable} />}
          </Field>
          <Field label={t('subcontracts.progress.vatCode')} hint={vatOptions.find((v) => v.code === vatCode && !v.verifiedAt) ? t('subcontracts.progress.vatUnverified') : undefined}>
            {(fid) => (
              <Select id={fid} value={vatCode} onChange={(e) => setVatCode(e.target.value)} disabled={!editable}>
                <option value="">{t('subcontracts.progress.noVat')}</option>
                {vatOptions.map((v) => (
                  <option key={v.code} value={v.code}>{v.code} — %{Number(v.rate)}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('subcontracts.progress.note')}>{(fid) => <Textarea id={fid} rows={1} value={note} onChange={(e) => setNote(e.target.value)} disabled={!editable} maxLength={500} />}</Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('subcontracts.progress.linesTitle')} description={t('subcontracts.progress.linesDesc')} />
        <TableWrap className="rounded-none border-0">
          <Table>
            <thead>
              <tr>
                <Th className="w-16">{t('subcontracts.boq.cols.itemNo')}</Th>
                <Th>{t('subcontracts.boq.cols.description')}</Th>
                <Th num className="w-28">{t('subcontracts.progress.cols.contractQty')}</Th>
                <Th num className="w-28">{t('subcontracts.progress.cols.prevQty')}</Th>
                <Th num className="w-36">{t('subcontracts.progress.cols.cumQty')}</Th>
                <Th num className="w-28">{t('subcontracts.progress.cols.thisQty')}</Th>
                <Th num className="w-28">{t('subcontracts.boq.cols.unitPrice')}</Th>
                <Th num className="w-32">{t('subcontracts.boq.cols.amount')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Tr key={r.lineKey}>
                  <Td className="font-mono text-[13px] text-muted">{r.itemNo}</Td>
                  <Td>
                    {r.description} <span className="text-xs text-muted">({r.unit})</span>
                    {(r.over || r.below) && <Badge tone="danger" className="ml-2">{r.over ? t('subcontracts.progress.overContract') : t('subcontracts.progress.belowPrev')}</Badge>}
                  </Td>
                  <Td num className="text-muted">{qtyText(r.quantity)}</Td>
                  <Td num className="text-muted">{qtyText(r.prevQty)}</Td>
                  <Td num>
                    {editable ? (
                      <Input aria-label={`${t('subcontracts.progress.cols.cumQty')} ${i + 1}`} inputMode="decimal" className="num text-right" value={cum[r.lineKey] ?? ''} onChange={(e) => setCum((c) => ({ ...c, [r.lineKey]: e.target.value.replace(',', '.') }))} />
                    ) : (
                      qtyText(r.cum)
                    )}
                  </Td>
                  <Td num>{r.thisQty ? qtyText(String(r.thisQty)) : '—'}</Td>
                  <Td num className="text-muted">{money(r.unitPrice)}</Td>
                  <Td num>{r.thisQty ? money(dec(r.thisQty).times(r.unitPrice).toDecimalPlaces(2).toFixed(2)) : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={t('subcontracts.progress.deductionsTitle')}
            description={t('subcontracts.progress.deductionsDesc')}
            action={editable ? (
              <Button size="sm" onClick={() => setDeductions((d) => [...d, { key: crypto.randomUUID(), description: '', amount: '' }])}>
                <Plus className="size-4" aria-hidden />
                {t('subcontracts.progress.addDeduction')}
              </Button>
            ) : undefined}
          />
          <div className="flex flex-col gap-2 p-4">
            {deductions.length === 0 && <p className="text-sm text-muted">{t('subcontracts.progress.noDeductions')}</p>}
            {deductions.map((d, i) => (
              <div key={d.key} className="flex items-center gap-2">
                <Input aria-label={`${t('subcontracts.progress.deductionDesc')} ${i + 1}`} value={d.description} disabled={!editable} onChange={(e) => setDeductions((ds) => ds.map((x) => (x.key === d.key ? { ...x, description: e.target.value } : x)))} placeholder={t('subcontracts.progress.deductionDesc')} />
                <Input aria-label={`${t('subcontracts.progress.deductionAmount')} ${i + 1}`} inputMode="decimal" className="num w-36 text-right" disabled={!editable} value={d.amount} onChange={(e) => setDeductions((ds) => ds.map((x) => (x.key === d.key ? { ...x, amount: e.target.value } : x)))} />
                {editable && (
                  <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${i + 1}`} onClick={() => setDeductions((ds) => ds.filter((x) => x.key !== d.key))}>
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title={t('subcontracts.progress.summaryTitle')} description={editable ? t('subcontracts.progress.summaryDraftDesc') : undefined} />
          <dl className="flex flex-col gap-2 p-4 text-sm">
            <Row label={t('subcontracts.progress.sum.gross')} value={money2(view.gross)} />
            <Row label={`${t('subcontracts.progress.sum.vat')}${vatCode ? ` (${vatCode})` : ''}`} value={`+ ${money2(view.vat)}`} />
            <Row label={`${receivable ? t('subcontracts.employer.sum.retention') : t('subcontracts.progress.sum.retention')} ${pct(p?.retentionPct ?? basis.subcontract.retentionPct)}`} value={`− ${money2(view.retention)}`} />
            <Row label={`${t('subcontracts.progress.sum.advance')} ${pct(p?.advancePct ?? basis.subcontract.advanceRecoupPct)}`} value={`− ${money2(view.advance)}`} hint={editable ? (receivable ? t('subcontracts.employer.sum.advanceBalance', { balance: money2(basis.balances.advanceBalance) }) : t('subcontracts.progress.sum.advanceBalance', { balance: money2(basis.balances.advanceBalance) })) : undefined} />
            <Row label={`${receivable ? t('subcontracts.employer.sum.withholding') : t('subcontracts.progress.sum.withholding')} ${pct(p?.withholdingPct ?? basis.subcontract.withholdingPct)}`} value={`− ${money2(view.withholding)}`} />
            <Row label={t('subcontracts.progress.sum.other')} value={`− ${money2(view.other)}`} />
            <div className="mt-1 flex items-baseline justify-between border-t border-text pt-3 text-base">
              <dt>{receivable ? t('subcontracts.employer.sum.net') : t('subcontracts.progress.sum.net')}</dt>
              <dd className="num">{money2(view.net)}</dd>
            </div>
            {calc?.net.isNegative() && editable && <Callout tone="danger">{t('subcontracts.progress.netNegative')}</Callout>}
          </dl>
        </Card>
      </div>

      {detail && detail.approvals.length > 0 && (
        <Card>
          <CardHeader title={t('subcontracts.approval.historyTitle')} />
          <div className="flex flex-col gap-4 p-4">
            {detail.approvals.map((a) => (
              <div key={a.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm">
                  <ApprovalStatusBadge status={a.status} />
                  <span className="text-muted">{formatDateTR(a.requestedAt.slice(0, 10))}</span>
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
            <Button variant="danger" loading={decide.isPending} onClick={() => run({ mutate: (_v, o) => decide.mutate({ requestId: pending.id, decision: 'reject' }, o) }, () => toast.success(t('subcontracts.approval.rejectedToast')))}>
              {t('subcontracts.approval.reject')}
            </Button>
            <Button variant="primary" loading={decide.isPending} onClick={() => run({ mutate: (_v, o) => decide.mutate({ requestId: pending.id, decision: 'approve' }, o) }, () => toast.success(t('subcontracts.approval.approvedToast')))}>
              {t('subcontracts.approval.approve')}
            </Button>
          </>
        )}
        {status === 'submitted' && can('subcontracts.manage') && (
          <Button loading={withdraw.isPending} onClick={() => run(withdraw, () => toast.success(t('subcontracts.progress.withdrawn')))}>{t('subcontracts.progress.withdraw')}</Button>
        )}
        {status === 'posted' && can('subcontracts.approve') && (
          <Button variant="danger" onClick={() => { setCancelReason(''); setCancelOpen(true); }}>{t('subcontracts.progress.cancel')}</Button>
        )}
        {!isNew && status === 'draft' && can('subcontracts.manage') && (
          <Button variant="danger" loading={remove.isPending} onClick={() => run(remove, () => { toast.success(t('subcontracts.progress.deleted')); navigate(`/subcontracts/${basis.subcontract.id}`); })}>{t('common.delete')}</Button>
        )}
        {editable && (
          <>
            <Button loading={save.isPending} disabled={invalid} onClick={() => run<ProgressDetail>(save, (r) => { toast.success(t('subcontracts.progress.saved')); if (isNew) navigate(`/progress-payments/${r.payment.id}`, { replace: true }); })}>
              {t('subcontracts.progress.saveDraft')}
            </Button>
            <Button variant="primary" loading={submit.isPending} disabled={invalid} onClick={() => run<ProgressDetail>(submit, (r) => { toast.success(t('subcontracts.progress.submitted')); navigate(`/progress-payments/${r.payment.id}`, { replace: true }); })}>
              {t('subcontracts.progress.submit')}
            </Button>
          </>
        )}
      </div>

      <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.siteChief'), t('printDoc.approved'), receivable ? t('printDoc.employer') : t('printDoc.subcontractor')]} />
      <PrintNote />

      <Modal
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('subcontracts.progress.cancelTitle')}
        description={t('subcontracts.progress.cancelDesc')}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={cancel.isPending} disabled={cancelReason.trim().length < 3} onClick={() => run(cancel, () => { setCancelOpen(false); toast.success(t('subcontracts.progress.cancelled')); })}>
              {t('subcontracts.progress.cancel')}
            </Button>
          </>
        }
      >
        <Field label={t('subcontracts.progress.cancelReason')} required>{(fid) => <Input id={fid} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={300} />}</Field>
      </Modal>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">
        {label}
        {hint && <span className="block text-xs">{hint}</span>}
      </dt>
      <dd className="num">{value}</dd>
    </div>
  );
}
