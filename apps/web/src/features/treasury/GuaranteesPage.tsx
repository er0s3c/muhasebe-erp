import { BANK_GUARANTEE_STATUSES, todayIso, type GuaranteeDirection } from '@erp/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { BankGuaranteeList, BankGuaranteeReport, BankGuaranteeRow, SubcontractRow } from '../../lib/types';
import { usePartyOptions } from '../invoices/common';
import { useProjectOptions } from '../projects/common';
import { DateField, UnverifiedNotice } from './cheques-common';

const GUARANTEE_INVALIDATE = [['guarantees']];

/** Durum rozeti: aktif mektupta süre durumu (dolmak üzere / süresi geçmiş) önceliklidir. */
function StateBadge({ g }: { g: BankGuaranteeRow }) {
  const { t } = useTranslation();
  if (g.status === 'active' && g.expiryState === 'lapsed') return <Badge tone="danger">{t('guarantees.state.lapsed')}</Badge>;
  if (g.status === 'active' && g.expiryState === 'expiring') return <Badge tone="warning">{t('guarantees.state.expiring')}</Badge>;
  return <Badge tone={g.status === 'active' ? 'success' : g.status === 'liquidated' ? 'danger' : 'neutral'}>{t(`guarantees.status.${g.status}`)}</Badge>;
}

/**
 * Banka teminat mektubu portföyü (Faz X1): nazım takip, yevmiye yazmaz. Komisyon ve süre bilgileri kullanıcı girişidir; uyarı günü
 * kullanıcı ayarıdır (boşsa "dolmak üzere" üretilmez).
 */
export function GuaranteesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const manage = can('treasury.manage');
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('active');
  const [within, setWithin] = useState('');
  const [q, setQ] = useState('');
  const params = { direction, status, withinDays: within, q };
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v.trim())).toString();
  const lim = useListLimit(qs);
  const { data, isPending } = useCQuery<BankGuaranteeList & { truncated?: boolean }>(['guarantees', 'list', qs, lim.limit], `/api/bank-guarantees?${qs}${qs ? '&' : ''}limit=${lim.limit}`);
  const report = useCQuery<BankGuaranteeReport>(['guarantees', 'report'], '/api/bank-guarantees/report');
  const [editing, setEditing] = useState<BankGuaranteeRow | 'new' | null>(null);
  const [resolving, setResolving] = useState<BankGuaranteeRow | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [warnInput, setWarnInput] = useState<string | null>(null);
  const rows = data?.guarantees ?? [];
  const warnShown = warnInput ?? (data?.warningDays != null ? String(data.warningDays) : '');

  const saveSettings = useCMutation((v: number | null, call) => call('/api/bank-guarantees/settings', { method: 'PUT', body: { guaranteeWarningDays: v } }), GUARANTEE_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/bank-guarantees/${id}`, { method: 'DELETE' }), GUARANTEE_INVALIDATE);

  return (
    <>
      <PageHeader
        title={t('guarantees.title')}
        description={t('guarantees.subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <ExportMenu exportKey="bank-guarantees" params={params} disabled={!data || rows.length === 0} />
            {manage && (
              <Button variant="primary" onClick={() => { setError(null); setEditing('new'); }}>
                <Plus className="size-4" aria-hidden />
                {t('guarantees.new')}
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-4">
        <Callout tone="warning">{t('guarantees.notice')}</Callout>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t('guarantees.warning.title')} description={t('guarantees.warning.desc')} />
          <div className="flex flex-wrap items-end gap-3 px-5 pb-5">
            <Field label={t('guarantees.warning.days')} className="w-40">
              {(id) => <Input id={id} type="number" min={0} max={3650} disabled={!manage} value={warnShown} onChange={(e) => setWarnInput(e.target.value)} />}
            </Field>
            {manage && (
              <Button
                loading={saveSettings.isPending}
                onClick={() =>
                  saveSettings.mutate(warnShown.trim() === '' ? null : Number(warnShown), {
                    onSuccess: () => { setWarnInput(null); toast.success(t('guarantees.warning.saved')); },
                    onError: (e) => toast.error(errorMessage(e)),
                  })
                }
              >
                {t('common.save')}
              </Button>
            )}
            {data && data.warningDays === null && <p className="text-xs text-muted">{t('guarantees.warning.none')}</p>}
            {data && (data.expiring > 0 || data.lapsed > 0) && (
              <p className="text-sm" role="status">
                {data.expiring > 0 && <Badge tone="warning" className="mr-2">{t('guarantees.warning.expiring', { n: data.expiring })}</Badge>}
                {data.lapsed > 0 && <Badge tone="danger">{t('guarantees.warning.lapsed', { n: data.lapsed })}</Badge>}
              </p>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title={t('guarantees.totals.title')} description={t('guarantees.totals.desc')} />
          <div className="px-5 pb-5">
            {(data?.activeTotals ?? []).length === 0 ? (
              <p className="text-sm text-muted">{t('guarantees.totals.none')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {data!.activeTotals.map((x) => (
                  <li key={`${x.direction}:${x.currency}`} className="flex justify-between">
                    <span>{t(`guarantees.direction.${x.direction}`)} ({x.count})</span>
                    <span className="num">{moneyIn(x.amount, x.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label={t('guarantees.filters.direction')} className="w-36">
          {(id) => (
            <Select id={id} value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="">{t('cheques.filters.all')}</option>
              <option value="given">{t('guarantees.direction.given')}</option>
              <option value="received">{t('guarantees.direction.received')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('guarantees.filters.status')} className="w-40">
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('cheques.filters.all')}</option>
              {BANK_GUARANTEE_STATUSES.map((s) => <option key={s} value={s}>{t(`guarantees.status.${s}`)}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('guarantees.filters.within')} className="w-36">{(id) => <Input id={id} type="number" min={0} max={3650} value={within} onChange={(e) => setWithin(e.target.value)} />}</Field>
        <Field label={t('guarantees.filters.search')} className="w-48">{(id) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
      </div>

      {error && !editing && !resolving && <div className="mb-3"><Callout tone="danger">{errorMessage(error)}</Callout></div>}
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title={t('guarantees.empty')} description={t('guarantees.emptyDesc')} />
        </Card>
      ) : (
        <>
          <TableWrap>
          <Table aria-label={t('guarantees.title')}>
            <thead>
              <tr>
                <Th className="w-24">{t('guarantees.cols.direction')}</Th>
                <Th className="w-32">{t('guarantees.cols.no')}</Th>
                <Th>{t('guarantees.cols.bank')}</Th>
                <Th>{t('guarantees.cols.party')}</Th>
                <Th>{t('guarantees.cols.project')}</Th>
                <Th num className="w-36">{t('guarantees.cols.amount')}</Th>
                <Th className="w-28">{t('guarantees.cols.expiry')}</Th>
                <Th num className="w-20">{t('guarantees.cols.days')}</Th>
                <Th num className="w-32">{t('guarantees.cols.commission')}</Th>
                <Th className="w-32">{t('guarantees.cols.status')}</Th>
                <Th className="w-44"><span className="sr-only">{t('common.actions')}</span></Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <Tr key={g.id}>
                  <Td><Badge tone={g.direction === 'given' ? 'warning' : 'success'}>{t(`guarantees.direction.${g.direction}`)}</Badge></Td>
                  <Td className="font-mono text-[13px]">{g.letterNo}</Td>
                  <Td className="text-muted">{g.bankName}{g.branch ? ` / ${g.branch}` : ''}</Td>
                  <Td>{g.counterpartyName}{g.purpose && <div className="text-xs text-muted">{g.purpose}</div>}</Td>
                  <Td className="text-muted">{g.projectCode ? `${g.projectCode} — ${g.projectName}` : '—'}{g.subcontractCode && <div className="text-xs">{g.subcontractCode}</div>}</Td>
                  <Td num>{moneyIn(g.amount, g.currencyCode)}</Td>
                  <Td>{g.expiryDate ? formatDateTR(g.expiryDate) : t('guarantees.noExpiry')}</Td>
                  <Td num>{g.daysToExpiry ?? '—'}</Td>
                  <Td num>
                    {g.commissionAmount ? moneyIn(g.commissionAmount, g.currencyCode) : '—'}
                    {g.commissionRate && <div className="text-xs text-muted">%{Number(g.commissionRate)}</div>}
                  </Td>
                  <Td><StateBadge g={g} /></Td>
                  <Td>
                    {manage && g.status === 'active' && (
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2" aria-label={`${t('common.edit')}: ${g.letterNo}`} onClick={() => { setError(null); setEditing(g); }}>
                          <Pencil className="size-4" aria-hidden />
                        </button>
                        <Button size="sm" onClick={() => { setError(null); setResolving(g); }}>{t('guarantees.resolve.action')}</Button>
                        <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')}: ${g.letterNo}`} onClick={() => remove.mutate(g.id, { onError: setError })}>
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>
                    )}
                    {g.status !== 'active' && g.resolvedDate && <span className="text-xs text-muted">{formatDateTR(g.resolvedDate)}</span>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
          <TruncatedNote truncated={data?.truncated} shown={rows.length} onMore={lim.more} atMax={lim.atMax} />
        </>
      )}

      {report.data && (report.data.byBank.length > 0 || report.data.byProject.length > 0) && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t('guarantees.report.byBank')} />
            <div className="px-5 pb-5">
              <ul className="flex flex-col gap-1 text-sm">
                {report.data.byBank.map((x) => (
                  <li key={`${x.direction}:${x.bankName}:${x.currency}`} className="flex justify-between gap-3">
                    <span>{x.bankName} · {t(`guarantees.direction.${x.direction}`)} ({x.count})</span>
                    <span className="num">{moneyIn(x.amount, x.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
          <Card>
            <CardHeader title={t('guarantees.report.byProject')} />
            <div className="px-5 pb-5">
              <ul className="flex flex-col gap-1 text-sm">
                {report.data.byProject.map((x) => (
                  <li key={`${x.direction}:${x.projectId}:${x.currency}`} className="flex justify-between gap-3">
                    <span>{x.projectCode ? `${x.projectCode} — ${x.projectName}` : t('guarantees.report.noProject')} · {t(`guarantees.direction.${x.direction}`)} ({x.count})</span>
                    <span className="num">{moneyIn(x.amount, x.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        </div>
      )}

      <GuaranteeSheet target={editing} onClose={() => setEditing(null)} />
      <ResolveModal target={resolving} onClose={() => setResolving(null)} />
    </>
  );
}

function GuaranteeSheet({ target, onClose }: { target: BankGuaranteeRow | 'new' | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const base = useCompany().baseCurrency;
  const can = useCan();
  const isNew = target === 'new';
  const editing = target && target !== 'new' ? target : null;
  const [direction, setDirection] = useState<GuaranteeDirection>('given');
  const [f, setF] = useState({ letterNo: '', bankName: '', branch: '', partyId: '', counterpartyName: '', projectId: '', subcontractId: '', purpose: '', amount: '', currencyCode: base, issueDate: todayIso(), expiryDate: '', commissionRate: '', commissionAmount: '', commissionNote: '', note: '' });
  const [error, setError] = useState<Error | null>(null);
  const [seen, setSeen] = useState<unknown>(null);
  if (target !== seen) {
    setSeen(target);
    if (target) {
      setError(null);
      if (target === 'new') {
        setDirection('given');
        setF({ letterNo: '', bankName: '', branch: '', partyId: '', counterpartyName: '', projectId: '', subcontractId: '', purpose: '', amount: '', currencyCode: base, issueDate: todayIso(), expiryDate: '', commissionRate: '', commissionAmount: '', commissionNote: '', note: '' });
      } else {
        setDirection(target.direction);
        setF({
          letterNo: target.letterNo, bankName: target.bankName, branch: target.branch ?? '', partyId: target.partyId ?? '', counterpartyName: target.counterpartyName, projectId: target.projectId ?? '', subcontractId: target.subcontractId ?? '', purpose: target.purpose ?? '',
          amount: target.amount, currencyCode: target.currencyCode, issueDate: target.issueDate, expiryDate: target.expiryDate ?? '', commissionRate: target.commissionRate ?? '', commissionAmount: target.commissionAmount ?? '', commissionNote: target.commissionNote ?? '', note: target.note ?? '',
        });
      }
    }
  }
  const { options: supplierOpts } = usePartyOptions('supplier', isNew);
  const { options: customerOpts } = usePartyOptions('customer', isNew);
  const partyOpts = [...customerOpts, ...supplierOpts].filter((o, i, a) => a.findIndex((x) => x.value === o.value) === i);
  const { projects } = useProjectOptions(isNew);
  const subsOn = useModuleEnabled('construction.subcontracts') && can('subcontracts.read');
  const { data: subs } = useCQuery<{ subcontracts: SubcontractRow[] }>(['guarantees', 'subcontracts'], '/api/subcontracts', { enabled: isNew && subsOn });
  const subOptions = (subs?.subcontracts ?? []).filter((s) => !f.projectId || s.projectId === f.projectId);

  const save = useCMutation(
    (_: void, call) =>
      editing
        ? call(`/api/bank-guarantees/${editing.id}`, {
            method: 'PATCH',
            body: {
              branch: f.branch.trim() || null,
              purpose: f.purpose.trim() || null,
              expiryDate: f.expiryDate || null,
              commissionRate: f.commissionRate || null,
              commissionAmount: f.commissionAmount || null,
              commissionNote: f.commissionNote.trim() || null,
              note: f.note.trim() || null,
            },
          })
        : call('/api/bank-guarantees', {
            method: 'POST',
            body: {
              direction,
              letterNo: f.letterNo.trim(),
              bankName: f.bankName.trim(),
              ...(f.branch.trim() ? { branch: f.branch.trim() } : {}),
              ...(f.partyId ? { partyId: f.partyId } : {}),
              ...(f.counterpartyName.trim() ? { counterpartyName: f.counterpartyName.trim() } : {}),
              ...(f.projectId ? { projectId: f.projectId } : {}),
              ...(f.subcontractId ? { subcontractId: f.subcontractId } : {}),
              ...(f.purpose.trim() ? { purpose: f.purpose.trim() } : {}),
              amount: f.amount,
              currencyCode: f.currencyCode,
              issueDate: f.issueDate,
              ...(f.expiryDate ? { expiryDate: f.expiryDate } : {}),
              ...(f.commissionRate ? { commissionRate: f.commissionRate } : {}),
              ...(f.commissionAmount ? { commissionAmount: f.commissionAmount } : {}),
              ...(f.commissionNote.trim() ? { commissionNote: f.commissionNote.trim() } : {}),
              ...(f.note.trim() ? { note: f.note.trim() } : {}),
            },
          }),
    GUARANTEE_INVALIDATE,
  );
  const valid = editing ? true : !!f.letterNo.trim() && !!f.bankName.trim() && Number(f.amount) > 0 && (!!f.partyId || !!f.counterpartyName.trim()) && (!f.expiryDate || f.expiryDate >= f.issueDate);

  return (
    <Sheet
      wide
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={editing ? t('guarantees.form.editTitle', { no: editing.letterNo }) : t('guarantees.new')}
      description={t('guarantees.form.desc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(undefined, { onSuccess: () => { toast.success(t('guarantees.form.saved')); onClose(); }, onError: setError })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('guarantees.form.direction')} required>
            {(id) => (
              <Select id={id} value={direction} disabled={!!editing} onChange={(e) => setDirection(e.target.value as GuaranteeDirection)}>
                <option value="given">{t('guarantees.direction.given')}</option>
                <option value="received">{t('guarantees.direction.received')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('guarantees.form.letterNo')} required>{(id) => <Input id={id} maxLength={60} disabled={!!editing} value={f.letterNo} onChange={(e) => setF({ ...f, letterNo: e.target.value })} />}</Field>
          <Field label={t('guarantees.form.bank')} required>{(id) => <Input id={id} maxLength={80} disabled={!!editing} value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />}</Field>
          <Field label={t('guarantees.form.branch')}>{(id) => <Input id={id} maxLength={80} value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} />}</Field>
          {!editing && (
            <>
              <Field label={direction === 'given' ? t('guarantees.form.beneficiary') : t('guarantees.form.issuedBy')} hint={t('guarantees.form.partyHint')}>
                {(id) => <Combobox id={id} options={partyOpts} value={f.partyId || null} onChange={(v) => setF({ ...f, partyId: v })} placeholder={t('guarantees.form.pickParty')} />}
              </Field>
              <Field label={t('guarantees.form.counterparty')} hint={t('guarantees.form.counterpartyHint')}>{(id) => <Input id={id} maxLength={160} value={f.counterpartyName} onChange={(e) => setF({ ...f, counterpartyName: e.target.value })} />}</Field>
              {projects.length > 0 && (
                <Field label={t('guarantees.form.project')}>
                  {(id) => (
                    <Select id={id} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value, subcontractId: '' })}>
                      <option value="">—</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                    </Select>
                  )}
                </Field>
              )}
              {subsOn && (
                <Field label={t('guarantees.form.contract')}>
                  {(id) => (
                    <Select id={id} value={f.subcontractId} onChange={(e) => setF({ ...f, subcontractId: e.target.value })}>
                      <option value="">—</option>
                      {subOptions.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.title}</option>)}
                    </Select>
                  )}
                </Field>
              )}
            </>
          )}
          <Field label={t('guarantees.form.purpose')}>{(id) => <Input id={id} maxLength={160} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />}</Field>
          <Field label={t('guarantees.form.amount')} required>{(id) => <MoneyInput id={id} disabled={!!editing} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />}</Field>
          <Field label={t('guarantees.form.currency')} required>
            {(id) => (
              <Select id={id} value={f.currencyCode} disabled={!!editing} onChange={(e) => setF({ ...f, currencyCode: e.target.value })}>
                <CurrencyOptions wide />
              </Select>
            )}
          </Field>
          <DateField label={t('guarantees.form.issueDate')} value={f.issueDate} onChange={(v) => setF({ ...f, issueDate: v })} required />
          <Field label={t('guarantees.form.expiryDate')} hint={t('guarantees.form.expiryHint')}>{(id) => <Input id={id} type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />}</Field>
          <Field label={t('guarantees.form.commissionRate')} hint={t('guarantees.form.commissionHint')}>{(id) => <MoneyInput id={id} decimals={2} maxDecimals={4} value={f.commissionRate} onChange={(v) => setF({ ...f, commissionRate: v })} />}</Field>
          <Field label={t('guarantees.form.commissionAmount')}>{(id) => <MoneyInput id={id} value={f.commissionAmount} onChange={(v) => setF({ ...f, commissionAmount: v })} />}</Field>
          <Field label={t('guarantees.form.commissionNote')} className="sm:col-span-2">{(id) => <Input id={id} maxLength={300} value={f.commissionNote} onChange={(e) => setF({ ...f, commissionNote: e.target.value })} />}</Field>
          <Field label={t('guarantees.form.note')} className="sm:col-span-2">{(id) => <Input id={id} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
        </div>
        <UnverifiedNotice>{t('guarantees.form.limit')}</UnverifiedNotice>
      </div>
    </Sheet>
  );
}

function ResolveModal({ target, onClose }: { target: BankGuaranteeRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [status, setStatus] = useState<'returned' | 'liquidated' | 'expired'>('returned');
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  if ((target?.id ?? null) !== seen) {
    setSeen(target?.id ?? null);
    if (target) {
      setStatus('returned');
      setDate(todayIso());
      setNote('');
      setError(null);
    }
  }
  const save = useCMutation(
    (_: void, call) => call(`/api/bank-guarantees/${target!.id}/resolve`, { method: 'POST', body: { status, resolvedDate: date, ...(note.trim() ? { note: note.trim() } : {}) } }),
    GUARANTEE_INVALIDATE,
  );
  return (
    <Modal
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={t('guarantees.resolve.title', { no: target?.letterNo ?? '' })}
      description={t('guarantees.resolve.desc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!date} onClick={() => save.mutate(undefined, { onSuccess: () => { toast.success(t('guarantees.resolve.done')); onClose(); }, onError: setError })}>
            {t('guarantees.resolve.action')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('guarantees.resolve.outcome')} required>
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="returned">{t('guarantees.status.returned')}</option>
              <option value="liquidated">{t('guarantees.status.liquidated')}</option>
              <option value="expired">{t('guarantees.status.expired')}</option>
            </Select>
          )}
        </Field>
        <DateField label={t('guarantees.resolve.date')} value={date} onChange={setDate} required />
        <Field label={t('guarantees.resolve.note')}>{(id) => <Input id={id} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}
