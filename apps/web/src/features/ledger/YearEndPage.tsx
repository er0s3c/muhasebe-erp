import { CalendarCheck, CheckCircle2, CircleAlert, Info, Lock, LockOpen, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Switch } from '../../components/ui/Switch';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, isZero, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { ClosingPreviewData, ClosingPreviewLine, FiscalYear, FiscalYearsData, PreflightCheck, PreflightData } from '../../lib/types';
import { fmtDate } from '../../lib/license';

const SEVERITY_ICON: Record<PreflightCheck['severity'], ReactNode> = {
  ok: <CheckCircle2 className="size-4 text-success" aria-hidden />,
  info: <Info className="size-4 text-muted" aria-hidden />,
  warning: <TriangleAlert className="size-4 text-warning" aria-hidden />,
  blocker: <CircleAlert className="size-4 text-danger" aria-hidden />,
};

/** Yıl sonu kapanışı ve devir. Hesap seçimleri ve yöntem doğrulanmamıştır (LEGAL-NOTES §23). */
export function YearEndPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const canYearEnd = can('ledger.yearend');
  const { data, isPending, error } = useCQuery<FiscalYearsData>(['fiscal-years'], '/api/fiscal-years');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reopenFor, setReopenFor] = useState<FiscalYear | null>(null);
  const [reason, setReason] = useState('');

  const years = useMemo(() => data?.years ?? [], [data]);
  useEffect(() => {
    if (!selectedId && years.length > 0) setSelectedId((years.find((y) => y.status === 'open') ?? years[0])!.id);
  }, [years, selectedId]);
  const selected = years.find((y) => y.id === selectedId) ?? null;

  const refresh = [['fiscal-years'], ['year-end'], ['trial-balance'], ['periods'], ['period-years'], ['journal']];
  const remove = useCMutation((id: string, call) => call(`/api/fiscal-years/${id}`, { method: 'DELETE' }), refresh);
  const reopen = useCMutation((v: { id: string; reason: string }, call) => call(`/api/fiscal-years/${v.id}/reopen`, { method: 'POST', body: { reason: v.reason } }), refresh);

  if (isPending) return <PageLoading />;
  if (error || !data) return <Callout tone="danger">{errorMessage(error)}</Callout>;

  const lastClose = (y: FiscalYear) => [...y.events].reverse().find((e) => e.action === 'close') ?? null;

  return (
    <div className="flex flex-col gap-5" data-testid="yearend-page">
      <PageHeader title={t('yearend.title')} description={t('yearend.subtitle')} />
      <Callout tone="warning">{t('yearend.unverified')}</Callout>
      {!canYearEnd && <Callout tone="info">{t('yearend.readOnly')}</Callout>}

      <Card>
        <CardHeader title={t('yearend.years.title')} description={t('yearend.years.subtitle')} />
        {years.length === 0 ? (
          <EmptyState icon={<CalendarCheck className="size-5" />} title={t('yearend.years.empty')} />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('yearend.years.name')}</Th>
                  <Th>{t('yearend.years.range')}</Th>
                  <Th>{t('yearend.years.status')}</Th>
                  <Th num>{t('yearend.years.result')}</Th>
                  <Th>{t('yearend.years.actions')}</Th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => {
                  const ev = lastClose(y);
                  return (
                    <Tr key={y.id} data-testid="fiscal-year-row" className={y.id === selectedId ? 'bg-surface-2/60' : undefined}>
                      <Td>{y.name}</Td>
                      <Td>
                        {formatDateTR(y.startDate)} – {formatDateTR(y.endDate)}
                      </Td>
                      <Td>
                        <Badge tone={y.status === 'closed' ? 'neutral' : 'success'}>{y.status === 'closed' ? t('yearend.years.closed') : t('yearend.years.open')}</Badge>
                        {y.status === 'closed' && y.closedAt && <p className="mt-1 text-xs text-muted">{t('yearend.years.closedAt', { date: fmtDate(y.closedAt) })}</p>}
                        {y.status === 'open' && y.reopenReason && <p className="mt-1 max-w-xs text-xs text-muted">{t('yearend.years.reopenedNote', { reason: y.reopenReason })}</p>}
                      </Td>
                      <Td num>
                        {y.status === 'closed' && ev?.resultBase != null ? (
                          <span data-testid="fiscal-year-result">
                            {money(String(Math.abs(Number(ev.resultBase))))} <span className="text-xs text-muted">{Number(ev.resultBase) >= 0 ? t('yearend.years.profit') : t('yearend.years.loss')}</span>
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => setSelectedId(y.id)}>
                            {y.status === 'open' && canYearEnd ? t('yearend.years.work') : t('yearend.years.view')}
                          </Button>
                          {canYearEnd && y.status === 'closed' && (
                            <Button size="sm" onClick={() => { setReopenFor(y); setReason(''); }}>
                              <LockOpen className="size-3.5" aria-hidden />
                              {t('yearend.years.reopen')}
                            </Button>
                          )}
                          {canYearEnd && y.status === 'open' && y.events.length === 0 && (
                            <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(y.id, { onSuccess: () => { toast.success(t('yearend.define.deleted')); setSelectedId(null); }, onError: (e) => toast.error(errorMessage(e)) })}>
                              {t('yearend.years.delete')}
                            </Button>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {canYearEnd && <DefineYear suggestions={data.suggestions} onCreated={(id) => setSelectedId(id)} />}

      {selected && selected.status === 'open' && canYearEnd && <Wizard key={selected.id} year={selected} onClosed={() => undefined} />}
      {selected && selected.status === 'closed' && <ClosedPanel year={selected} canExport={canYearEnd} />}

      <Modal
        open={reopenFor !== null}
        onOpenChange={(o) => !o && setReopenFor(null)}
        title={reopenFor ? t('yearend.reopen.title', { name: reopenFor.name }) : ''}
        description={t('yearend.reopen.body')}
        footer={
          <>
            <Button onClick={() => setReopenFor(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={reopen.isPending}
              disabled={reason.trim().length < 5}
              onClick={() =>
                reopenFor &&
                reopen.mutate(
                  { id: reopenFor.id, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      toast.success(t('yearend.reopen.done'));
                      setSelectedId(reopenFor.id);
                      setReopenFor(null);
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            >
              {t('yearend.reopen.submit')}
            </Button>
          </>
        }
      >
        <Field label={t('yearend.reopen.reason')}>{(id) => <Textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Modal>
    </div>
  );
}

function DefineYear({ suggestions, onCreated }: { suggestions: FiscalYearsData['suggestions']; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const thisYear = new Date().getFullYear();
  const [start, setStart] = useState(`${thisYear}-01-01`);
  const [end, setEnd] = useState(`${thisYear}-12-31`);
  const [name, setName] = useState('');
  const create = useCMutation(
    (v: { startDate: string; endDate: string; name?: string }, call) => call<{ year: { id: string } }>('/api/fiscal-years', { method: 'POST', body: v }),
    [['fiscal-years']],
  );
  return (
    <Card>
      <CardHeader title={t('yearend.define.title')} />
      <div className="flex flex-wrap items-end gap-4 px-5 py-4">
        <Field label={t('yearend.define.start')}>{(id) => <Input id={id} type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-44" />}</Field>
        <Field label={t('yearend.define.end')}>{(id) => <Input id={id} type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-44" />}</Field>
        <Field label={t('yearend.define.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} className="w-40" />}</Field>
        <Button
          variant="primary"
          loading={create.isPending}
          onClick={() =>
            create.mutate(
              { startDate: start, endDate: end, ...(name.trim() ? { name: name.trim() } : {}) },
              { onSuccess: (r) => { toast.success(t('yearend.define.created')); onCreated(r.year.id); setName(''); }, onError: (e) => toast.error(errorMessage(e)) },
            )
          }
        >
          <Plus className="size-4" aria-hidden />
          {t('yearend.define.submit')}
        </Button>
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3 text-sm text-muted">
          {t('yearend.define.suggest')}:
          {suggestions.map((s) => (
            <Button key={s.name} size="sm" onClick={() => { setStart(s.startDate); setEnd(s.endDate); setName(''); }}>
              {s.name}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

function Wizard({ year, onClosed }: { year: FiscalYear; onClosed: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [carry, setCarry] = useState(true);
  const [cost, setCost] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const qs = useMemo(() => new URLSearchParams({ carryForward: String(carry), includeCostAccounts: String(cost) }).toString(), [carry, cost]);
  const pre = useCQuery<PreflightData>(['year-end', 'preflight', year.id, qs], `/api/fiscal-years/${year.id}/preflight?${qs}`);
  const prev = useCQuery<ClosingPreviewData>(['year-end', 'preview', year.id, qs], `/api/fiscal-years/${year.id}/preview?${qs}`);
  const close = useCMutation(
    (v: { confirm: string }, call) => call(`/api/fiscal-years/${year.id}/close`, { method: 'POST', body: { confirm: v.confirm, carryForward: carry, includeCostAccounts: cost } }),
    [['fiscal-years'], ['year-end'], ['trial-balance'], ['periods'], ['period-years'], ['journal']],
  );

  return (
    <>
      <Card>
        <CardHeader title={t('yearend.options.title')} />
        <div className="flex flex-col gap-3 px-5 py-4 text-sm">
          <label className="flex items-center gap-3">
            <Switch checked={carry} onChange={setCarry} label={t('yearend.options.carry')} />
            {t('yearend.options.carry')}
          </label>
          <label className="flex items-center gap-3">
            <Switch checked={cost} onChange={setCost} label={t('yearend.options.cost')} />
            {t('yearend.options.cost')}
          </label>
        </div>
      </Card>

      <Card data-testid="preflight">
        <CardHeader title={t('yearend.checks.title')} description={t('yearend.checks.subtitle')} />
        {pre.isPending ? (
          <PageLoading />
        ) : pre.error || !pre.data ? (
          <div className="p-5">
            <Callout tone="danger">{errorMessage(pre.error)}</Callout>
          </div>
        ) : (
          <ul>
            {pre.data.checks.map((c) => (
              <li key={c.key} data-testid={`check-${c.key}`} data-severity={c.severity} className="flex items-start gap-3 border-b border-border px-5 py-3 last:border-b-0">
                <span className="mt-0.5">{SEVERITY_ICON[c.severity]}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {t(`yearend.checks.${c.key}.title` as never)}
                    {c.count != null && c.count > 0 && <span className="ml-2 text-muted">({t('yearend.checks.count', { count: c.count })})</span>}
                  </p>
                  {c.severity !== 'ok' && <p className="text-[13px] text-muted">{t(`yearend.checks.${c.key}.hint` as never)}</p>}
                  {c.details && c.details.length > 0 && <p className="text-[13px] text-muted">{c.details.join(' · ')}</p>}
                </div>
                <Badge tone={c.severity === 'blocker' ? 'danger' : c.severity === 'warning' ? 'warning' : c.severity === 'ok' ? 'success' : 'neutral'}>{t(`yearend.checks.${c.severity}` as never)}</Badge>
                {c.link && c.severity !== 'ok' && (
                  <Link to={c.link} className="text-sm link">
                    {t('yearend.checks.open')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card data-testid="preview">
        <CardHeader
          title={t('yearend.preview.title')}
          description={t('yearend.preview.subtitle')}
          action={<ExportMenu exportKey="year-end-closing" params={{ fiscalYearId: year.id, carryForward: String(carry), includeCostAccounts: String(cost) }} formats={['xlsx', 'csv']} />}
        />
        {prev.isPending ? (
          <PageLoading />
        ) : prev.error || !prev.data ? (
          <div className="p-5">
            <Callout tone="danger">{errorMessage(prev.error)}</Callout>
          </div>
        ) : (
          <div className="flex flex-col gap-5 p-5">
            <p className="text-sm" data-testid="preview-result">
              {t(`yearend.preview.kind.${prev.data.kind}` as never)}:{' '}
              <strong className="num">{money(String(Math.abs(Number(prev.data.net))))}</strong> · {t('yearend.preview.accounts', { count: prev.data.accountCount })}
            </p>
            {prev.data.closingEntry ? <EntryTable title={t('yearend.preview.closing')} date={prev.data.closingEntry.date} lines={prev.data.closingEntry.lines} testId="preview-closing" /> : <p className="text-sm text-muted">{t('yearend.preview.nothing')}</p>}
            {prev.data.carryEntry ? <EntryTable title={t('yearend.preview.carry')} date={prev.data.carryEntry.date} lines={prev.data.carryEntry.lines} testId="preview-carry" /> : <p className="text-sm text-muted">{t('yearend.preview.noCarry')}</p>}
          </div>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
          {pre.data && !pre.data.canClose && <span className="text-sm text-danger">{t('yearend.close.blocked')}</span>}
          <Button variant="primary" data-testid="close-year" disabled={!pre.data?.canClose} onClick={() => { setTyped(''); setConfirmOpen(true); }}>
            <Lock className="size-4" aria-hidden />
            {t('yearend.close.button')}
          </Button>
        </div>
      </Card>

      <Modal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('yearend.close.title', { name: year.name })}
        description={t('yearend.close.body')}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={close.isPending}
              disabled={typed.trim() !== year.name}
              data-testid="confirm-close"
              onClick={() =>
                close.mutate(
                  { confirm: typed.trim() },
                  {
                    onSuccess: () => {
                      toast.success(t('yearend.close.done'));
                      setConfirmOpen(false);
                      onClosed();
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            >
              {t('yearend.close.button')}
            </Button>
          </>
        }
      >
        <Field label={t('yearend.close.type', { name: year.name })}>{(id) => <Input id={id} aria-label={t('yearend.close.confirm')} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
      </Modal>
    </>
  );
}

function EntryTable({ title, date, lines, testId }: { title: string; date: string; lines: ClosingPreviewLine[]; testId: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid={testId}>
      <p className="mb-2 text-sm">
        {title} · {t('yearend.preview.date')}: {formatDateTR(date)}
      </p>
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>{t('yearend.preview.account')}</Th>
              <Th>{t('yearend.preview.description')}</Th>
              <Th>{t('yearend.preview.project')}</Th>
              <Th num>{t('yearend.preview.debit')}</Th>
              <Th num>{t('yearend.preview.credit')}</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <Tr key={i}>
                <Td className="font-mono text-[13px]">{l.accountCode}</Td>
                <Td>{l.description}</Td>
                <Td className="text-muted">{[l.projectCode, l.wbsCode].filter(Boolean).join(' / ')}</Td>
                <Td num>{isZero(l.debitBase) ? '' : money(l.debitBase)}</Td>
                <Td num>{isZero(l.creditBase) ? '' : money(l.creditBase)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    </div>
  );
}

function ClosedPanel({ year, canExport }: { year: FiscalYear; canExport: boolean }) {
  const { t } = useTranslation();
  return (
    <Card data-testid="closed-panel">
      <CardHeader title={`${year.name} · ${t('yearend.years.history')}`} action={canExport ? <ExportMenu exportKey="year-end-closing" params={{ fiscalYearId: year.id }} /> : undefined} />
      <ul>
        {[...year.events].reverse().map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-3 border-b border-border px-5 py-3 text-sm last:border-b-0">
            <Badge tone={e.action === 'close' ? 'neutral' : 'warning'}>{t(`yearend.history.${e.action}` as never)}</Badge>
            <span className="text-muted">{fmtDate(e.at)}</span>
            {e.action === 'close' && e.resultBase != null && <span>{t('yearend.history.result', { amount: money(e.resultBase) })}</span>}
            {e.reason && <span className="text-muted">{t('yearend.history.reason', { reason: e.reason })}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
