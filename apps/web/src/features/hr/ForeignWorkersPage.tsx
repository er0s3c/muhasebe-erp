import { todayIso } from '@erp/shared';
import { Eye, EyeOff, History, Plus, RefreshCw, Trash2, Paperclip } from 'lucide-react';
import { useState, useEffect } from 'react';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { EmployeeRow, ForeignDocList, ForeignDocRenewalRow, ForeignDocRow, ForeignDocStatus, ForeignDocTypeRow, GuaranteeReport, GuaranteeRow } from '../../lib/types';
import { FOREIGN_INVALIDATE, ForeignStatusBadge, ForeignUnverifiedBadge, GuaranteeStatusBadge } from './foreign-common';
import { fmtDate } from '../../lib/license';

type Tab = 'documents' | 'guarantees';
const STATUSES: readonly ForeignDocStatus[] = ['valid', 'expiring', 'expired', 'revoked'];

/** Yabancı işçi belge ve teminat takibi (Faz D5). Süre/tutar/makam bilgileri kullanıcı girişidir; doğrulanmadı. */
export function ForeignWorkersPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('documents');
  return (
    <>
      <PageHeader title={t('foreign.title')} description={t('foreign.subtitle')} />
      <div className="mb-4">
        <Callout tone="warning">{t('foreign.notice')}</Callout>
      </div>
      <div className="mb-4">
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          items={[
            { key: 'documents', label: t('foreign.tabs.documents') },
            { key: 'guarantees', label: t('foreign.tabs.guarantees') },
          ]}
        />
      </div>
      {tab === 'documents' ? <DocumentsTab /> : <GuaranteesTab />}
    </>
  );
}

function useEmployees() {
  return useCQuery<{ employees: EmployeeRow[] }>(['employees', 'list', ''], '/api/employees?');
}

function DocumentsTab() {
  const { t } = useTranslation();
  const can = useCan();
  const manage = can('hr.manage');
  const [status, setStatus] = useState('');
  const [within, setWithin] = useState('');
  const [nationality, setNationality] = useState('');
  const [typeId, setTypeId] = useState('');
  const [q, setQ] = useState('');
  const params = { status, withinDays: within, nationality, typeId, q };
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v.trim())).toString();
  const lim = useListLimit(qs);
  const { data, isPending } = useCQuery<ForeignDocList & { truncated?: boolean }>(['foreign', 'docs', qs, lim.limit], `/api/foreign-workers/documents?${qs}${qs ? '&' : ''}limit=${lim.limit}`);
  const { data: types } = useCQuery<{ types: ForeignDocTypeRow[] }>(['foreign', 'types'], '/api/foreign-workers/doc-types');
  const { data: emps } = useEmployees();
  const [error, setError] = useState<Error | null>(null);
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<ForeignDocRow | null>(null);
  const [revoking, setRevoking] = useState<ForeignDocRow | null>(null);
  const [asking, setAsking] = useState<ForeignDocRow | null>(null);
  const [history, setHistory] = useState<ForeignDocRow | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const docs = data?.docs ?? [];
  const activeTypes = (types?.types ?? []).filter((x) => x.active);

  const remove = useCMutation((id: string, call) => call(`/api/foreign-workers/documents/${id}`, { method: 'DELETE' }), FOREIGN_INVALIDATE);

  const addButton = manage && (
    <Button variant="primary" onClick={() => { setError(null); setAdding(true); }}>
      <Plus className="size-4" aria-hidden />
      {t('foreign.newDoc')}
    </Button>
  );

  return (
    <>
      {data && !data.warning.configured && (
        <div className="mb-3">
          <Callout tone="info">
            {t('foreign.noWarning')} <Link className="underline" to="/hr/foreign-workers/settings">{t('nav.foreignSettings')}</Link>
          </Callout>
        </div>
      )}
      {data?.warning.configured && (
        <p className="mb-3 flex items-center gap-2 text-sm text-muted">
          {t('foreign.warningInfo', { days: data.warning.days })}
          {!data.warning.verified && <ForeignUnverifiedBadge />}
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('foreign.filters.status')}>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            className={`rounded-lg border px-3 py-1.5 text-sm ${status === s ? 'border-ink bg-surface-2' : 'border-border bg-surface'}`}
            onClick={() => setStatus(status === s ? '' : s)}
          >
            {t(`foreign.status.${s}`)} <span className="num ml-1 text-muted">{data?.summary[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('foreign.filters.search')} className="w-44">{(id) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
          <Field label={t('foreign.filters.nationality')} className="w-36">{(id) => <Input id={id} value={nationality} onChange={(e) => setNationality(e.target.value)} />}</Field>
          <Field label={t('foreign.filters.type')} className="w-44">
            {(id) => (
              <Select id={id} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                <option value="">{t('foreign.filters.all')}</option>
                {(types?.types ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('foreign.filters.within')} className="w-36">
            {(id) => <Input id={id} inputMode="numeric" value={within} onChange={(e) => setWithin(e.target.value.replace(/\D/g, ''))} />}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu exportKey="foreign-documents" params={params} disabled={!data || docs.length === 0} />
          {addButton}
        </div>
      </div>
      {error && !asking && !renewing && !revoking && <div className="mb-3"><Callout tone="danger">{errorMessage(error)}</Callout></div>}
      {isPending ? (
        <PageLoading />
      ) : docs.length === 0 ? (
        <Card>
          <EmptyState title={qs ? t('foreign.emptyFiltered') : t('foreign.empty')} description={qs ? undefined : t('foreign.emptyDesc')} action={qs ? undefined : addButton || undefined} />
        </Card>
      ) : (
        <>
          <TableWrap>
          <Table aria-label={t('foreign.tabs.documents')}>
            <thead>
              <tr>
                <Th>{t('foreign.cols.employee')}</Th>
                <Th>{t('foreign.cols.type')}</Th>
                <Th className="w-40">{t('foreign.cols.number')}</Th>
                <Th>{t('foreign.cols.authority')}</Th>
                <Th className="w-28">{t('foreign.cols.issue')}</Th>
                <Th className="w-28">{t('foreign.cols.expiry')}</Th>
                <Th num className="w-20">{t('foreign.cols.days')}</Th>
                <Th className="w-32">{t('foreign.cols.status')}</Th>
                <Th>{t('foreign.cols.reference')}</Th>
                <Th className="w-40"><span className="sr-only">{t('common.actions')}</span></Th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const shown = revealed[d.id];
                return (
                  <Tr key={d.id}>
                    <Td>
                      <span className="font-mono text-[12px] text-muted">{d.employeeCode}</span> {d.employeeName}
                      <div className="text-xs text-muted">{d.nationality}</div>
                    </Td>
                    <Td>{d.typeName}</Td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[13px]">{shown ?? d.numberMasked ?? '—'}</span>
                        {d.hasNumber &&
                          can('hr.sensitive') &&
                          (shown ? (
                            <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label={t('foreign.hide')} onClick={() => setRevealed((s) => { const n = { ...s }; delete n[d.id]; return n; })}>
                              <EyeOff className="size-4" aria-hidden />
                            </button>
                          ) : (
                            <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label={`${t('foreign.show')}: ${d.employeeName}`} onClick={() => { setError(null); setAsking(d); }}>
                              <Eye className="size-4" aria-hidden />
                            </button>
                          ))}
                      </span>
                    </Td>
                    <Td className="text-muted">{d.issuingAuthority ?? '—'}</Td>
                    <Td className="text-muted">{d.issueDate ? formatDateTR(d.issueDate) : '—'}</Td>
                    <Td>{d.expiryDate ? formatDateTR(d.expiryDate) : '—'}</Td>
                    <Td num>{d.daysToExpiry ?? '—'}</Td>
                    <Td><ForeignStatusBadge status={d.status} /></Td>
                    <Td className="text-muted">{d.referenceNote ?? '—'}</Td>
                    <Td>
                      <div className="flex gap-1">
                        {can('hr.sensitive') && <Link to={`/workspace/documents?kind=foreign_worker_doc&id=${d.id}`} className="rounded p-1.5 text-muted hover:bg-surface-2" aria-label={`Belge ekleri: ${d.employeeName}`}><Paperclip className="size-4" aria-hidden /></Link>}
                        <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2" aria-label={`${t('foreign.history.action')}: ${d.employeeName}`} onClick={() => setHistory(d)}>
                          <History className="size-4" aria-hidden />
                        </button>
                        {manage && d.status !== 'revoked' && (
                          <>
                            <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2" aria-label={`${t('foreign.renew.action')}: ${d.employeeName}`} onClick={() => { setError(null); setRenewing(d); }}>
                              <RefreshCw className="size-4" aria-hidden />
                            </button>
                            <Button size="sm" onClick={() => { setError(null); setRevoking(d); }}>{t('foreign.revoke.action')}</Button>
                          </>
                        )}
                        {manage && d.renewalCount === 0 && d.status !== 'revoked' && (
                          <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={t('common.delete')} onClick={() => remove.mutate(d.id, { onError: setError })}>
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
          <TruncatedNote truncated={data?.truncated} shown={docs.length} onMore={lim.more} atMax={lim.atMax} />
        </>
      )}

      <AddDocumentModal open={adding} onOpenChange={setAdding} activeTypes={activeTypes} emps={emps} />
      <RenewDocumentModal renewing={renewing} setRenewing={setRenewing} />
      <RevokeDocumentModal revoking={revoking} setRevoking={setRevoking} />
      <RevealDocumentModal asking={asking} setAsking={setAsking} setRevealed={setRevealed} />
      <HistoryModal doc={history} onClose={() => setHistory(null)} />
    </>
  );
}

function HistoryModal({ doc, onClose }: { doc: ForeignDocRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data } = useCQuery<{ renewals: ForeignDocRenewalRow[] }>(['foreign', 'doc', doc?.id ?? ''], doc ? `/api/foreign-workers/documents/${doc.id}` : null, { enabled: !!doc });
  const rows = data?.renewals ?? [];
  const d = (v: string | null) => (v ? formatDateTR(v) : '—');
  return (
    <Modal open={!!doc} onOpenChange={(o) => !o && onClose()} title={t('foreign.history.title')} description={doc ? `${doc.employeeName} — ${doc.typeName}` : undefined} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t('foreign.history.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {rows.map((x) => (
            <li key={x.id} className="rounded-lg border border-border p-3">
              <div className="text-muted">{t('foreign.history.at')}: {fmtDate(x.renewedAt)}</div>
              <div>{t('foreign.history.prev')}: {d(x.prevIssueDate)} → {d(x.prevExpiryDate)} {x.prevNumberMasked ?? ''}</div>
              <div>{t('foreign.history.next')}: {d(x.newIssueDate)} → {d(x.newExpiryDate)} {x.newNumberMasked ?? ''}</div>
              {x.note && <div className="text-muted">{x.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function GuaranteesTab() {
  const { t } = useTranslation();
  const manage = useCan()('hr.manage');
  const { data, isPending } = useCQuery<{ guarantees: GuaranteeRow[] }>(['foreign', 'guarantees'], '/api/foreign-workers/guarantees');
  const { data: rep } = useCQuery<GuaranteeReport>(['foreign', 'guarantee-report'], '/api/foreign-workers/reports/guarantees');
  const { data: params } = useCQuery<{ params: { key: string; enabled: boolean }[] }>(['foreign', 'params'], '/api/foreign-workers/params');
  const { data: emps } = useEmployees();
  const { data: docs } = useCQuery<ForeignDocList>(['foreign', 'docs', ''], '/api/foreign-workers/documents');
  const [adding, setAdding] = useState(false);
  const [resolving, setResolving] = useState<GuaranteeRow | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const rows = data?.guarantees ?? [];
  const hasParam = (params?.params ?? []).some((p) => p.key === 'guarantee_amount' && p.enabled);
  const remove = useCMutation((id: string, call) => call(`/api/foreign-workers/guarantees/${id}`, { method: 'DELETE' }), FOREIGN_INVALIDATE);
  const empDocs = (docs?.docs ?? []).filter((d) => d.status !== 'revoked');

  return (
    <>
      <p className="mb-3 text-sm text-muted">{t('foreign.guarantees.desc')}</p>
      {!hasParam && (
        <div className="mb-3">
          <Callout tone="info">
            {t('foreign.guarantees.noParam')} <Link className="underline" to="/hr/foreign-workers/settings">{t('nav.foreignSettings')}</Link>
          </Callout>
        </div>
      )}
      <div className="mb-3 flex justify-end gap-2">
        <ExportMenu exportKey="foreign-guarantees" disabled={rows.length === 0} />
        {manage && (
          <Button variant="primary" onClick={() => { setError(null); setAdding(true); }}>
            <Plus className="size-4" aria-hidden />
            {t('foreign.guarantees.new')}
          </Button>
        )}
      </div>
      {error && !adding && !resolving && <div className="mb-3"><Callout tone="danger">{errorMessage(error)}</Callout></div>}
      {rep && rep.totals.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">{t('foreign.guarantees.totals')}:</span>
          {rep.totals.map((x) => (
            <span key={x.currency} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm">
              {currencySymbol(x.currency)}: {t('foreign.guarantees.held')} <span className="num">{moneyIn(x.held, x.currency)}</span> · {t('foreign.guarantees.refunded')} <span className="num">{moneyIn(x.refunded, x.currency)}</span> · {t('foreign.guarantees.forfeited')} <span className="num">{moneyIn(x.forfeited, x.currency)}</span>
            </span>
          ))}
          {rep.unverified && <ForeignUnverifiedBadge />}
        </div>
      )}
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card><EmptyState title={t('foreign.guarantees.empty')} /></Card>
      ) : (
        <TableWrap>
          <Table aria-label={t('foreign.guarantees.title')}>
            <thead>
              <tr>
                <Th>{t('foreign.guarantees.cols.employee')}</Th>
                <Th>{t('foreign.guarantees.cols.project')}</Th>
                <Th num className="w-36">{t('foreign.guarantees.cols.amount')}</Th>
                <Th className="w-28">{t('foreign.guarantees.cols.deposited')}</Th>
                <Th>{t('foreign.guarantees.cols.reference')}</Th>
                <Th className="w-36">{t('foreign.guarantees.cols.status')}</Th>
                <Th className="w-28">{t('foreign.guarantees.cols.resolved')}</Th>
                <Th className="w-36">{t('foreign.guarantees.cols.param')}</Th>
                {manage && <Th className="w-36"><span className="sr-only">{t('common.actions')}</span></Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <Tr key={g.id}>
                  <Td><span className="font-mono text-[12px] text-muted">{g.employeeCode}</span> {g.employeeName}</Td>
                  <Td className="text-muted">{g.projectCode ? `${g.projectCode} — ${g.projectName}` : '—'}</Td>
                  <Td num>{moneyIn(g.amount, g.currency)}</Td>
                  <Td className="text-muted">{formatDateTR(g.depositedDate)}</Td>
                  <Td className="text-muted">{g.depositReference ?? '—'}</Td>
                  <Td><GuaranteeStatusBadge status={g.status} /></Td>
                  <Td className="text-muted">{g.resolvedDate ? formatDateTR(g.resolvedDate) : '—'}</Td>
                  <Td>{g.paramVerified ? t('foreign.guarantees.verified') : <ForeignUnverifiedBadge />}</Td>
                  {manage && (
                    <Td>
                      {g.status === 'held' && (
                        <div className="flex gap-1">
                          <Button size="sm" onClick={() => { setError(null); setResolving(g); }}>{t('foreign.guarantees.resolve.action')}</Button>
                          <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={t('foreign.guarantees.delete')} onClick={() => remove.mutate(g.id, { onError: setError })}>
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </div>
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {rep && rep.byProject.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">{t('foreign.guarantees.outstanding')} — {t('foreign.guarantees.byProject')}</h2>
          <TableWrap>
            <Table aria-label={t('foreign.guarantees.byProject')}>
              <thead>
                <tr>
                  <Th>{t('foreign.guarantees.cols.project')}</Th>
                  <Th num className="w-24">{t('foreign.guarantees.count')}</Th>
                  <Th num className="w-40">{t('foreign.guarantees.cols.amount')}</Th>
                </tr>
              </thead>
              <tbody>
                {rep.byProject.map((p, i) => (
                  <Tr key={`${p.projectId}-${p.currency}-${i}`}>
                    <Td>{p.projectCode ? `${p.projectCode} — ${p.projectName}` : t('foreign.guarantees.noProject')}</Td>
                    <Td num>{p.count}</Td>
                    <Td num>{moneyIn(p.amount, p.currency)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </div>
      )}

      <AddGuaranteeModal open={adding} onOpenChange={setAdding} emps={emps} empDocs={empDocs} />
      <ResolveGuaranteeModal resolving={resolving} setResolving={setResolving} />
    </>
  );
}


function AddDocumentModal({ open, onOpenChange, activeTypes, emps }: { open: boolean; onOpenChange: (open: boolean) => void; activeTypes: ForeignDocTypeRow[]; emps: { employees: EmployeeRow[] } | undefined }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ employeeId: '', typeId: activeTypes[0]?.id ?? '', no: '', authority: '', issue: '', expiry: '', reference: '' });
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (open) {
      setF({ employeeId: '', typeId: activeTypes[0]?.id ?? '', no: '', authority: '', issue: '', expiry: '', reference: '' });
      setError(null);
    }
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const add = useCMutation(
    (_: void, call) =>
      call('/api/foreign-workers/documents', {
        method: 'POST',
        body: {
          employeeId: f.employeeId,
          typeId: f.typeId,
          ...(f.no.trim() ? { documentNo: f.no.trim() } : {}),
          ...(f.authority.trim() ? { issuingAuthority: f.authority.trim() } : {}),
          ...(f.issue ? { issueDate: f.issue } : {}),
          ...(f.expiry ? { expiryDate: f.expiry } : {}),
          ...(f.reference.trim() ? { referenceNote: f.reference.trim() } : {}),
        },
      }),
    FOREIGN_INVALIDATE,
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('foreign.docForm.title')}
      description={t('foreign.docForm.desc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={add.isPending} disabled={!f.employeeId || !f.typeId} onClick={() => add.mutate(undefined, { onSuccess: () => { onOpenChange(false); toast.success(t('foreign.docForm.added')); }, onError: setError })}>
            {t('foreign.docForm.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && open && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('foreign.docForm.employee')} required>
          {(id) => (
            <Select id={id} value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
              <option value="">{t('foreign.docForm.pick')}</option>
              {(emps?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.code} — {e.fullName}{e.nationality ? ` (${e.nationality})` : ''}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('foreign.docForm.type')} required>
          {(id) => (
            <Select id={id} value={f.typeId} onChange={(e) => setF({ ...f, typeId: e.target.value })}>
              {activeTypes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('foreign.docForm.number')}>{(id) => <Input id={id} maxLength={60} autoComplete="off" value={f.no} onChange={(e) => setF({ ...f, no: e.target.value })} />}</Field>
        <Field label={t('foreign.docForm.authority')}>{(id) => <Input id={id} maxLength={200} value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('foreign.docForm.issue')}>{(id) => <Input id={id} type="date" value={f.issue} onChange={(e) => setF({ ...f, issue: e.target.value })} />}</Field>
          <Field label={t('foreign.docForm.expiry')}>{(id) => <Input id={id} type="date" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} />}</Field>
        </div>
        <Field label={t('foreign.docForm.reference')}>{(id) => <Input id={id} maxLength={300} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

function RenewDocumentModal({ renewing, setRenewing }: { renewing: ForeignDocRow | null; setRenewing: (d: ForeignDocRow | null) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [r, setR] = useState({ issue: '', expiry: '', no: '', note: '' });
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (renewing) {
      setR({ issue: '', expiry: '', no: '', note: '' });
      setError(null);
    }
  }, [renewing]);

  const renew = useCMutation(
    (_: void, call) =>
      call(`/api/foreign-workers/documents/${renewing!.id}/renew`, {
        method: 'POST',
        body: { expiryDate: r.expiry, ...(r.issue ? { issueDate: r.issue } : {}), ...(r.no.trim() ? { documentNo: r.no.trim() } : {}), ...(r.note.trim() ? { note: r.note.trim() } : {}) },
      }),
    FOREIGN_INVALIDATE,
  );

  return (
    <Modal
      open={!!renewing}
      onOpenChange={(o) => !o && setRenewing(null)}
      title={t('foreign.renew.title')}
      description={t('foreign.renew.desc')}
      footer={
        <>
          <Button onClick={() => setRenewing(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={renew.isPending} disabled={!r.expiry} onClick={() => renew.mutate(undefined, { onSuccess: () => { setRenewing(null); toast.success(t('foreign.renew.done')); }, onError: setError })}>
            {t('foreign.renew.action')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && renewing && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('foreign.renew.issue')}>{(id) => <Input id={id} type="date" value={r.issue} onChange={(e) => setR({ ...r, issue: e.target.value })} />}</Field>
          <Field label={t('foreign.renew.expiry')} required>{(id) => <Input id={id} type="date" value={r.expiry} onChange={(e) => setR({ ...r, expiry: e.target.value })} />}</Field>
        </div>
        <Field label={t('foreign.renew.number')}>{(id) => <Input id={id} maxLength={60} autoComplete="off" value={r.no} onChange={(e) => setR({ ...r, no: e.target.value })} />}</Field>
        <Field label={t('foreign.renew.note')}>{(id) => <Input id={id} maxLength={300} value={r.note} onChange={(e) => setR({ ...r, note: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

function RevokeDocumentModal({ revoking, setRevoking }: { revoking: ForeignDocRow | null; setRevoking: (d: ForeignDocRow | null) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (revoking) {
      setReason('');
      setError(null);
    }
  }, [revoking]);

  const revoke = useCMutation((_: void, call) => call(`/api/foreign-workers/documents/${revoking!.id}/revoke`, { method: 'POST', body: { reason: reason.trim() } }), FOREIGN_INVALIDATE);

  return (
    <Modal
      open={!!revoking}
      onOpenChange={(o) => !o && setRevoking(null)}
      title={t('foreign.revoke.title')}
      description={t('foreign.revoke.desc')}
      footer={
        <>
          <Button onClick={() => setRevoking(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={revoke.isPending} disabled={reason.trim().length < 3} onClick={() => revoke.mutate(undefined, { onSuccess: () => { setRevoking(null); toast.success(t('foreign.revoke.done')); }, onError: setError })}>
            {t('foreign.revoke.action')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && revoking && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('foreign.revoke.reason')} required>{(id) => <Input id={id} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

function RevealDocumentModal({ asking, setAsking, setRevealed }: { asking: ForeignDocRow | null; setAsking: (d: ForeignDocRow | null) => void; setRevealed: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (asking) {
      setReason('');
      setError(null);
    }
  }, [asking]);

  const reveal = useCMutation((v: { id: string; reason: string }, call) => call<{ value: string }>(`/api/foreign-workers/documents/${v.id}/reveal`, { method: 'POST', body: { reason: v.reason } }), [['privacy']]);

  return (
    <Modal
      open={!!asking}
      onOpenChange={(o) => !o && setAsking(null)}
      title={t('foreign.reveal.title')}
      description={t('foreign.reveal.desc')}
      footer={
        <>
          <Button onClick={() => setAsking(null)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={reveal.isPending}
            disabled={reason.trim().length < 3}
            onClick={() => asking && reveal.mutate({ id: asking.id, reason: reason.trim() }, { onSuccess: (x) => { setRevealed((s) => ({ ...s, [asking.id]: x.value })); setAsking(null); }, onError: setError })}
          >
            {t('foreign.show')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && asking && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('foreign.reveal.reason')} required hint={t('foreign.reveal.reasonHint')}>{(id) => <Input id={id} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

function AddGuaranteeModal({ open, onOpenChange, emps, empDocs }: { open: boolean; onOpenChange: (open: boolean) => void; emps: { employees: EmployeeRow[] } | undefined; empDocs: ForeignDocRow[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ employeeId: '', docId: '', date: todayIso(), reference: '' });
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (open) {
      setF({ employeeId: '', docId: '', date: todayIso(), reference: '' });
      setError(null);
    }

  }, [open]);

  const add = useCMutation(
    (_: void, call) => call('/api/foreign-workers/guarantees', { method: 'POST', body: { employeeId: f.employeeId, depositedDate: f.date, ...(f.docId ? { docId: f.docId } : {}), ...(f.reference.trim() ? { depositReference: f.reference.trim() } : {}) } }),
    FOREIGN_INVALIDATE,
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('foreign.guarantees.form.title')}
      description={t('foreign.guarantees.desc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={add.isPending} disabled={!f.employeeId || !f.date} onClick={() => add.mutate(undefined, { onSuccess: () => { onOpenChange(false); toast.success(t('foreign.guarantees.form.added')); }, onError: setError })}>
            {t('foreign.guarantees.form.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && open && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('foreign.guarantees.form.employee')} required>
          {(id) => (
            <Select id={id} value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value, docId: '' })}>
              <option value="">{t('foreign.guarantees.form.pick')}</option>
              {(emps?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.code} — {e.fullName}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('foreign.guarantees.form.doc')}>
          {(id) => (
            <Select id={id} value={f.docId} onChange={(e) => setF({ ...f, docId: e.target.value })}>
              <option value="">{t('foreign.guarantees.form.noDoc')}</option>
              {empDocs.filter(d => d.employeeId === f.employeeId).map((d) => <option key={d.id} value={d.id}>{d.typeName}{d.numberMasked ? ` ${d.numberMasked}` : ''}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('foreign.guarantees.form.date')} required>{(id) => <Input id={id} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
        <Field label={t('foreign.guarantees.form.reference')}>{(id) => <Input id={id} maxLength={120} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}

function ResolveGuaranteeModal({ resolving, setResolving }: { resolving: GuaranteeRow | null; setResolving: (g: GuaranteeRow | null) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [res, setRes] = useState({ status: 'refunded', date: todayIso(), note: '' });
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (resolving) {
      setRes({ status: 'refunded', date: todayIso(), note: '' });
      setError(null);
    }
  }, [resolving]);

  const resolve = useCMutation((_: void, call) => call(`/api/foreign-workers/guarantees/${resolving!.id}/resolve`, { method: 'POST', body: { status: res.status, resolvedDate: res.date, ...(res.note.trim() ? { note: res.note.trim() } : {}) } }), FOREIGN_INVALIDATE);

  return (
    <Modal
      open={!!resolving}
      onOpenChange={(o) => !o && setResolving(null)}
      title={t('foreign.guarantees.resolve.title')}
      description={t('foreign.guarantees.resolve.desc')}
      footer={
        <>
          <Button onClick={() => setResolving(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={resolve.isPending} disabled={!res.date} onClick={() => resolve.mutate(undefined, { onSuccess: () => { setResolving(null); toast.success(t('foreign.guarantees.resolve.done')); }, onError: setError })}>
            {t('foreign.guarantees.resolve.action')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && resolving && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('foreign.guarantees.resolve.kind')}>
          {(id) => (
            <Select id={id} value={res.status} onChange={(e) => setRes({ ...res, status: e.target.value })}>
              <option value="refunded">{t('foreign.guarantees.resolve.refunded')}</option>
              <option value="forfeited">{t('foreign.guarantees.resolve.forfeited')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('foreign.guarantees.resolve.date')} required>{(id) => <Input id={id} type="date" value={res.date} onChange={(e) => setRes({ ...res, date: e.target.value })} />}</Field>
        <Field label={t('foreign.guarantees.resolve.note')}>{(id) => <Input id={id} maxLength={300} value={res.note} onChange={(e) => setRes({ ...res, note: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}
