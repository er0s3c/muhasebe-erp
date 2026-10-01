import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { buildInstallmentPlan, dec, planTotals, todayIso } from '@erp/shared';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { SalesContractDetail, UnitRow } from '../../lib/types';
import { usePartyOptions } from '../invoices/common';
import { TransactionSheet } from '../treasury/TransactionSheet';
import { accountLabel, useTreasuryAccounts } from '../treasury/common';
import { ContractStatusBadge, REAL_ESTATE_INVALIDATE, unitLabel } from './common';

interface Row {
  key: string;
  kind: 'down_payment' | 'installment' | 'balloon';
  dueDate: string;
  amount: string;
}
const num = (v: string) => v.trim().replace(',', '.');

export function SalesContractPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const can = useCan();
  const base = useCompany().baseCurrency;
  const isNew = !id || id === 'new';
  const treasuryOn = useModuleEnabled('core.treasury');

  const detailQ = useCQuery<SalesContractDetail>(['sales-contract', id], isNew ? null : `/api/sales-contracts/${id}`);
  const detail = detailQ.data;
  const c = detail?.contract;
  const status = isNew ? 'draft' : c?.status ?? 'draft';
  const editable = status === 'draft' && can('realestate.manage');

  const { data: unitData } = useCQuery<{ units: UnitRow[] }>(['units', 'available'], '/api/real-estate/units?status=available', { enabled: isNew });
  const { options: buyers } = usePartyOptions('customer');

  const [unitId, setUnitId] = useState(params.get('unitId') ?? '');
  const [partyId, setPartyId] = useState('');
  const [currencyCode, setCurrencyCode] = useState('GBP');
  const [contractDate, setContractDate] = useState(todayIso());
  const [plannedHandover, setPlannedHandover] = useState('');
  const [price, setPrice] = useState('');
  const [down, setDown] = useState('0');
  const [penaltyNote, setPenaltyNote] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState('12');
  const [interval, setInterval] = useState('1');
  const [firstDue, setFirstDue] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [modal, setModal] = useState<null | 'activate' | 'handover' | 'cancel' | 'terminate'>(null);
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [retained, setRetained] = useState('0');
  const [refundAccountId, setRefundAccountId] = useState('');
  const [collecting, setCollecting] = useState(false);
  const accountsQ = useTreasuryAccounts(treasuryOn && modal === 'terminate');

  useEffect(() => {
    if (!detail) return;
    const k = detail.contract;
    setUnitId(k.unitId);
    setPartyId(k.partyId);
    setCurrencyCode(k.currencyCode);
    setContractDate(k.contractDate);
    setPlannedHandover(k.plannedHandover ?? '');
    setPrice(String(Number(k.price)));
    setDown(String(Number(k.downPayment)));
    setPenaltyNote(k.penaltyNote ?? '');
    setRows(detail.installments.map((i) => ({ key: i.id, kind: i.kind, dueDate: i.dueDate, amount: String(Number(i.amount)) })));
  }, [detail]);
  // Birim listede seçiliyse bedel ve para birimi liste fiyatından önerilir
  useEffect(() => {
    if (!isNew || !unitId) return;
    const u = unitData?.units.find((x) => x.id === unitId);
    if (u?.listPrice && u.listCurrency && !price) { setPrice(String(Number(u.listPrice))); setCurrencyCode(u.listCurrency); }
  }, [isNew, unitId, unitData, price]);

  const totals = useMemo(() => planTotals(rows.map((r) => ({ amount: num(r.amount) || '0' })), num(price) || '0'), [rows, price]);
  const generate = () => {
    try {
      const plan = buildInstallmentPlan({ price: num(price), downPayment: num(down) || '0', downDue: contractDate, count: Number(count), intervalMonths: Number(interval), firstDue: firstDue || contractDate });
      setRows(plan.map((p) => ({ key: crypto.randomUUID(), kind: p.kind, dueDate: p.dueDate, amount: p.amount })));
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  };
  const body = () => ({
    contractDate,
    plannedHandover: plannedHandover || null,
    price: num(price),
    downPayment: num(down) || '0',
    penaltyNote: penaltyNote.trim() || null,
    installments: rows.map((r) => ({ kind: r.kind, dueDate: r.dueDate, amount: num(r.amount) })),
  });
  const valid = (!!unitId || !isNew) && (!!partyId || !isNew) && Number(num(price)) > 0 && rows.length > 0 && totals.ok && rows.every((r) => r.dueDate && Number(num(r.amount)) > 0);

  const save = useCMutation(
    (_: void, call) => (isNew ? call<SalesContractDetail>('/api/sales-contracts', { method: 'POST', body: { unitId, partyId, currencyCode, ...body() } }) : call<SalesContractDetail>(`/api/sales-contracts/${id}`, { method: 'PUT', body: body() })),
    REAL_ESTATE_INVALIDATE,
  );
  const act = useCMutation(
    (v: { action: string; body: Record<string, unknown> }, call) => call<SalesContractDetail>(`/api/sales-contracts/${id}/${v.action}`, { method: 'POST', body: v.body }),
    REAL_ESTATE_INVALIDATE,
  );
  const run = (action: string, b: Record<string, unknown>, ok: string) => {
    setError(null);
    act.mutate({ action, body: b }, { onSuccess: () => { setModal(null); toast.success(ok); }, onError: (e) => { setModal(null); setError(e); } });
  };

  if (!isNew && detailQ.isPending) return <PageLoading />;
  const paid = dec(c?.paid ?? 0);
  const cur = c?.currencyCode ?? currencyCode;
  const unitOptions = (unitData?.units ?? []).map((u) => ({ value: u.id, label: `${u.projectCode} · ${unitLabel(u)}${u.grossM2 ? ` · ${Number(u.grossM2)} m²` : ''}`, keywords: `${u.projectCode} ${u.block} ${u.unitNo}` }));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/real-estate/contracts" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {t('realEstate.contracts.title')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl">
            {isNew ? t('realEstate.contracts.newTitle') : c?.code}
            {!isNew && <ContractStatusBadge status={status} />}
          </h1>
          {!isNew && <ExportMenu exportKey="sales-schedule" params={{ contractId: id }} />}
        </div>
        {c && <p className="mt-1 text-sm text-muted">{c.projectCode} · {unitLabel(c)} · {c.partyName}</p>}
      </div>

      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {c?.status === 'cancelled' && <Callout tone="danger" title={t('realEstate.contracts.cancelledTitle')}>{c.cancelReason}</Callout>}
      <Callout tone="info">{t('realEstate.contracts.legalNote')}</Callout>

      <Card>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <Field label={t('realEstate.cols.unit')} required>
            {(fid) => isNew ? <Combobox id={fid} value={unitId || null} onChange={setUnitId} options={unitOptions} placeholder={t('realEstate.contracts.unitPlaceholder')} /> : <Input id={fid} value={c ? `${c.projectCode} · ${unitLabel(c)}` : ''} disabled />}
          </Field>
          <Field label={t('realEstate.cols.buyer')} required>
            {(fid) => isNew ? <Combobox id={fid} value={partyId || null} onChange={setPartyId} options={buyers} placeholder={t('realEstate.contracts.buyerPlaceholder')} /> : <Input id={fid} value={c?.partyName ?? ''} disabled />}
          </Field>
          <Field label={t('realEstate.units.currency')} hint={cur !== base ? t('realEstate.contracts.fxHint', { base }) : undefined}>
            {(fid) => <Select id={fid} value={currencyCode} disabled={!isNew} onChange={(e) => setCurrencyCode(e.target.value)}><CurrencyOptions wide /></Select>}
          </Field>
          <Field label={t('realEstate.cols.date')} required>{(fid) => <Input id={fid} type="date" value={contractDate} disabled={!editable} onChange={(e) => setContractDate(e.target.value)} />}</Field>
          <Field label={t('realEstate.contracts.plannedHandover')}>{(fid) => <Input id={fid} type="date" value={plannedHandover} disabled={!editable} onChange={(e) => setPlannedHandover(e.target.value)} />}</Field>
          <div />
          <Field label={t('realEstate.cols.price')} required>{(fid) => <Input id={fid} inputMode="decimal" className="num text-right" value={price} disabled={!editable} onChange={(e) => setPrice(e.target.value)} />}</Field>
          <Field label={t('realEstate.contracts.downPayment')}>{(fid) => <Input id={fid} inputMode="decimal" className="num text-right" value={down} disabled={!editable} onChange={(e) => setDown(e.target.value)} />}</Field>
          <div className="sm:col-span-3">
            <Field label={t('realEstate.contracts.penaltyNote')}>{(fid) => <Textarea id={fid} rows={2} value={penaltyNote} disabled={!editable && status !== 'active'} onChange={(e) => setPenaltyNote(e.target.value)} maxLength={1000} />}</Field>
          </div>
        </div>
      </Card>

      {editable && (
        <Card>
          <CardHeader title={t('realEstate.contracts.generatorTitle')} description={t('realEstate.contracts.generatorDesc')} />
          <div className="grid grid-cols-2 items-end gap-3 p-4 sm:grid-cols-4">
            <Field label={t('realEstate.contracts.count')}>{(fid) => <Input id={fid} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />}</Field>
            <Field label={t('realEstate.contracts.interval')}>{(fid) => <Input id={fid} inputMode="numeric" value={interval} onChange={(e) => setInterval(e.target.value.replace(/\D/g, ''))} />}</Field>
            <Field label={t('realEstate.contracts.firstDue')}>{(fid) => <Input id={fid} type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />}</Field>
            <Button onClick={generate} disabled={!(Number(num(price)) > 0)}>{t('realEstate.contracts.generate')}</Button>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title={t('realEstate.contracts.planTitle')}
          description={editable ? t('realEstate.contracts.planDesc') : undefined}
          action={editable ? <Button size="sm" onClick={() => setRows((r) => [...r, { key: crypto.randomUUID(), kind: 'installment', dueDate: contractDate, amount: '' }])}><Plus className="size-4" aria-hidden />{t('realEstate.contracts.addRow')}</Button> : undefined}
        />
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted">{t('realEstate.contracts.planEmpty')}</p>
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th className="w-10">#</Th>
                  <Th className="w-40">{t('realEstate.cols.kind')}</Th>
                  <Th className="w-40">{t('realEstate.cols.due')}</Th>
                  <Th num>{t('realEstate.cols.amount')}</Th>
                  {!editable && <Th num>{t('realEstate.cols.paid')}</Th>}
                  {!editable && <Th num>{t('realEstate.cols.remaining')}</Th>}
                  {!editable && <Th className="w-32">{t('realEstate.cols.state')}</Th>}
                  {editable && <Th className="w-10" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const d = detail?.installments[i];
                  return (
                    <Tr key={r.key}>
                      <Td className="text-muted">{i + 1}</Td>
                      <Td>
                        {editable ? (
                          <Select aria-label={`${t('realEstate.cols.kind')} ${i + 1}`} value={r.kind} onChange={(e) => setRows((x) => x.map((y) => (y.key === r.key ? { ...y, kind: e.target.value as Row['kind'] } : y)))}>
                            <option value="down_payment">{t('realEstate.kinds.down_payment')}</option>
                            <option value="installment">{t('realEstate.kinds.installment')}</option>
                            <option value="balloon">{t('realEstate.kinds.balloon')}</option>
                          </Select>
                        ) : t(`realEstate.kinds.${r.kind}`)}
                      </Td>
                      <Td>{editable ? <Input aria-label={`${t('realEstate.cols.due')} ${i + 1}`} type="date" value={r.dueDate} onChange={(e) => setRows((x) => x.map((y) => (y.key === r.key ? { ...y, dueDate: e.target.value } : y)))} /> : formatDateTR(r.dueDate)}</Td>
                      <Td num>{editable ? <Input aria-label={`${t('realEstate.cols.amount')} ${i + 1}`} inputMode="decimal" className="num text-right" value={r.amount} onChange={(e) => setRows((x) => x.map((y) => (y.key === r.key ? { ...y, amount: e.target.value } : y)))} /> : moneyIn(r.amount, cur)}</Td>
                      {!editable && <Td num>{d ? moneyIn(d.paid, cur) : ''}</Td>}
                      {!editable && <Td num>{d ? moneyIn(d.remaining, cur) : ''}</Td>}
                      {!editable && (
                        <Td>
                          {d && (status === 'active' || status === 'handed_over') ? (
                            dec(d.remaining).isZero() ? <Badge tone="success">{t('realEstate.installments.paid')}</Badge> : d.daysOverdue > 0 ? <Badge tone="danger">{t('realEstate.installments.daysOverdue', { n: d.daysOverdue })}</Badge> : <Badge tone="neutral">{t('realEstate.installments.upcoming')}</Badge>
                          ) : null}
                        </Td>
                      )}
                      {editable && (
                        <Td>
                          <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${i + 1}`} onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </Td>
                      )}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <dl className="flex flex-col items-end gap-1 border-t border-border px-4 py-3 text-sm">
          <div className="flex gap-6"><dt className="text-muted">{t('realEstate.contracts.planTotal')}</dt><dd className="num w-40 text-right">{moneyIn(totals.total, cur)}</dd></div>
          {editable && !totals.ok && <div className="flex gap-6 text-danger"><dt>{t('realEstate.contracts.planDiff')}</dt><dd className="num w-40 text-right">{moneyIn(totals.diff, cur)}</dd></div>}
          {c && (status === 'active' || status === 'handed_over') && (
            <>
              <div className="flex gap-6"><dt className="text-muted">{t('realEstate.cols.paid')}</dt><dd className="num w-40 text-right">{moneyIn(c.paid, cur)}</dd></div>
              <div className="flex gap-6 font-medium"><dt>{t('realEstate.cols.remaining')}</dt><dd className="num w-40 text-right">{moneyIn(c.remaining, cur)}</dd></div>
              {!dec(c.overdue).isZero() && <div className="flex gap-6 text-danger"><dt>{t('realEstate.installments.overdue')}</dt><dd className="num w-40 text-right">{moneyIn(c.overdue, cur)}</dd></div>}
            </>
          )}
        </dl>
      </Card>

      {detail?.termination && (
        <Card>
          <CardHeader title={t('realEstate.contracts.terminationTitle')} />
          <dl className="grid grid-cols-2 gap-3 p-4 text-sm sm:grid-cols-4">
            <div><dt className="text-muted">{t('realEstate.cols.date')}</dt><dd>{formatDateTR(detail.termination.terminationDate)}</dd></div>
            <div><dt className="text-muted">{t('realEstate.contracts.collected')}</dt><dd className="num">{moneyIn(detail.termination.collected, cur)}</dd></div>
            <div><dt className="text-muted">{t('realEstate.contracts.retained')}</dt><dd className="num">{moneyIn(detail.termination.retained, cur)}</dd></div>
            <div><dt className="text-muted">{t('realEstate.contracts.refund')}</dt><dd className="num">{moneyIn(detail.termination.refund, cur)}</dd></div>
            <div className="col-span-full"><dt className="text-muted">{t('realEstate.contracts.reason')}</dt><dd>{detail.termination.reason}</dd></div>
          </dl>
        </Card>
      )}

      {c?.activatedOn && (
        <p className="text-xs text-muted">
          {t('realEstate.contracts.activatedOn', { date: formatDateTR(c.activatedOn) })}
          {c.activationFx && c.currencyCode !== base ? ` · ${t('realEstate.contracts.activationFx', { fx: Number(c.activationFx).toFixed(4), cur: c.currencyCode, base })}` : ''}
          {c.handedOverOn ? ` · ${t('realEstate.contracts.handedOverOn', { date: formatDateTR(c.handedOverOn) })}` : ''}
        </p>
      )}

      <PrintSignatures labels={[t('realEstate.print.seller'), t('realEstate.print.buyer')]} />
      <PrintNote />

      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === 'active' && can('realestate.approve') && (
          <>
            {treasuryOn && can('treasury.manage') && <Button onClick={() => setCollecting(true)}>{t('realEstate.contracts.collect')}</Button>}
            {paid.isZero() && <Button variant="danger" onClick={() => { setReason(''); setModal('cancel'); }}>{t('realEstate.contracts.cancel')}</Button>}
            <Button variant="danger" onClick={() => { setReason(''); setRetained('0'); setRefundAccountId(''); setDate(todayIso()); setModal('terminate'); }}>{t('realEstate.contracts.terminate')}</Button>
            <Button variant="primary" onClick={() => { setDate(todayIso()); setModal('handover'); }}>{t('realEstate.contracts.handover')}</Button>
          </>
        )}
        {!isNew && status === 'draft' && can('realestate.approve') && (
          <Button variant="danger" onClick={() => { setReason(''); setModal('cancel'); }}>{t('realEstate.contracts.cancel')}</Button>
        )}
        {editable && (
          <Button
            loading={save.isPending}
            disabled={!valid}
            onClick={() => { setError(null); save.mutate(undefined, { onSuccess: (r) => { toast.success(t('common.saved')); if (isNew) navigate(`/real-estate/contracts/${r.contract.id}`, { replace: true }); }, onError: setError }); }}
          >
            {t('realEstate.contracts.saveDraft')}
          </Button>
        )}
        {!isNew && status === 'draft' && can('realestate.approve') && (
          <Button variant="primary" disabled={!valid} onClick={() => { setDate(contractDate); setModal('activate'); }}>{t('realEstate.contracts.activate')}</Button>
        )}
      </div>

      <Modal
        open={modal !== null}
        onOpenChange={(o) => !o && setModal(null)}
        title={modal ? t(`realEstate.modal.${modal}.title`) : ''}
        description={modal ? t(`realEstate.modal.${modal}.desc`) : undefined}
        footer={
          <>
            <Button onClick={() => setModal(null)}>{t('common.cancel')}</Button>
            {modal === 'activate' && <Button variant="primary" loading={act.isPending} onClick={() => run('activate', { date }, t('realEstate.contracts.activated'))}>{t('realEstate.contracts.activate')}</Button>}
            {modal === 'handover' && <Button variant="primary" loading={act.isPending} onClick={() => run('handover', { date }, t('realEstate.contracts.handedOver'))}>{t('realEstate.contracts.handover')}</Button>}
            {modal === 'cancel' && <Button variant="danger" loading={act.isPending} disabled={reason.trim().length < 3} onClick={() => run('cancel', { reason: reason.trim() }, t('realEstate.contracts.cancelled'))}>{t('realEstate.contracts.cancel')}</Button>}
            {modal === 'terminate' && (
              <Button variant="danger" loading={act.isPending} disabled={reason.trim().length < 3 || dec(num(retained) || 0).gt(paid) || (paid.minus(num(retained) || 0).gt(0) && !refundAccountId)} onClick={() => run('terminate', { date, reason: reason.trim(), retained: num(retained) || '0', refundAccountId: refundAccountId || null }, t('realEstate.contracts.terminated'))}>
                {t('realEstate.contracts.terminate')}
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {(modal === 'activate' || modal === 'handover' || modal === 'terminate') && (
            <Field label={t('realEstate.cols.date')} required>{(fid) => <Input id={fid} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          )}
          {(modal === 'cancel' || modal === 'terminate') && (
            <Field label={modal === 'cancel' ? t('realEstate.contracts.cancelReason') : t('realEstate.contracts.reason')} required>{(fid) => <Input id={fid} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>
          )}
          {modal === 'terminate' && (
            <>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div><div className="text-muted">{t('realEstate.contracts.collected')}</div><div className="num">{moneyIn(paid.toFixed(2), cur)}</div></div>
                <Field label={t('realEstate.contracts.retained')}>{(fid) => <Input id={fid} inputMode="decimal" className="num text-right" value={retained} onChange={(e) => setRetained(e.target.value)} />}</Field>
                <div><div className="text-muted">{t('realEstate.contracts.refund')}</div><div className="num">{moneyIn(paid.minus(num(retained) || 0).toFixed(2), cur)}</div></div>
              </div>
              {paid.minus(num(retained) || 0).gt(0) && (
                <Field label={t('realEstate.contracts.refundAccount')} required hint={t('realEstate.contracts.refundAccountHint')}>
                  {(fid) => (
                    <Select id={fid} value={refundAccountId} onChange={(e) => setRefundAccountId(e.target.value)}>
                      <option value="">{t('realEstate.contracts.selectAccount')}</option>
                      {(accountsQ.data?.accounts ?? []).filter((a) => a.isActive && (a.currencyCode === base || a.currencyCode === cur)).map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
                    </Select>
                  )}
                </Field>
              )}
            </>
          )}
        </div>
      </Modal>

      {c && treasuryOn && (
        <TransactionSheet
          open={collecting}
          onOpenChange={setCollecting}
          initialType="receipt"
          initialPartyId={c.partyId}
          onSaved={() => { void qc.invalidateQueries({ queryKey: ['sales-contract'] }); void qc.invalidateQueries({ queryKey: ['sales-installments'] }); void qc.invalidateQueries({ queryKey: ['sales-summary'] }); }}
        />
      )}
    </div>
  );
}
