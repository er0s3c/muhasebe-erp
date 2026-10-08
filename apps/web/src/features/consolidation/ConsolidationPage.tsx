import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currencySymbol, MAP_LEVELS, todayIso } from '@erp/shared';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { ConsolidatedReportData, ConsolidationGroup, ExecutiveSummaryData, GroupFxPositionData } from '../../lib/types';
import { ExecutiveView } from '../reports/ExecutiveView';
import { GroupFxPositionView } from '../reports/FxPositionView';
import { ConsolidatedReportView } from './ConsolidatedReportView';
import { EliminationsPanel } from './EliminationsPanel';

type Tab = 'report' | 'fx' | 'executive' | 'eliminations' | 'groups';
const GROUP_KEY = ['consolidation', 'groups'];

function useGroups() {
  return useQuery({ queryKey: GROUP_KEY, queryFn: () => api<{ groups: ConsolidationGroup[] }>('/api/consolidation/groups') });
}

/** Grup oluşturma, üye ekleme/çıkarma, arşiv. Üyeler her istekte sunucuda yeniden doğrulanır; durum rozeti güncel erişimi gösterir. */
function GroupsPanel({ groups }: { groups: ConsolidationGroup[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const eligible = useQuery({ queryKey: ['consolidation', 'eligible'], queryFn: () => api<{ companies: { id: string; name: string; baseCurrency: string; role: string }[] }>('/api/consolidation/eligible-companies') });
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('TRY');
  const [picked, setPicked] = useState<string[]>([]);
  const refresh = () => qc.invalidateQueries({ queryKey: GROUP_KEY });
  const create = useMutation({
    mutationFn: () => api('/api/consolidation/groups', { method: 'POST', body: { name, reportingCurrency: currency, companyIds: picked } }),
    onSuccess: async () => {
      setName('');
      setPicked([]);
      toast.success(t('consolidation.groupCreated'));
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const addMember = useMutation({
    mutationFn: (v: { id: string; companyId: string }) => api(`/api/consolidation/groups/${v.id}/members`, { method: 'POST', body: { companyId: v.companyId } }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const removeMember = useMutation({
    mutationFn: (v: { id: string; companyId: string }) => api(`/api/consolidation/groups/${v.id}/members/${v.companyId}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const archive = useMutation({
    mutationFn: (v: { id: string; isArchived: boolean }) => api(`/api/consolidation/groups/${v.id}`, { method: 'PATCH', body: { isArchived: v.isArchived } }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const companies = eligible.data?.companies ?? [];
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="flex flex-col gap-5" data-testid="groups-panel">
      <Card className="p-5">
        <CardHeader title={t('consolidation.newGroup')} description={t('consolidation.newGroupDesc')} />
        <div className="flex flex-wrap items-end gap-4">
          <Field label={t('consolidation.groupName')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} className="w-64" />}</Field>
          <Field label={t('consolidation.groupCurrency')} hint={t('consolidation.groupCurrencyHint')}>
            {(id) => (
              <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-32">
                <CurrencyOptions />
              </Select>
            )}
          </Field>
        </div>
        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[13px]">{t('consolidation.pickCompanies')}</legend>
          {companies.length === 0 ? (
            <p className="text-sm text-muted">{t('consolidation.noEligible')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {companies.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} />
                    {c.name} <span className="text-muted">({currencySymbol(c.baseCurrency)} · {t(`roles.${c.role as 'owner'}`)})</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <Button className="mt-4" variant="primary" disabled={name.trim().length < 2 || picked.length === 0} loading={create.isPending} onClick={() => create.mutate()}>{t('consolidation.createGroup')}</Button>
      </Card>

      {groups.map((g) => {
        const candidates = companies.filter((c) => !g.members.some((m) => m.companyId === c.id));
        return (
          <Card key={g.id} className="p-5" data-testid="group-card">
            <CardHeader
              title={`${g.name} (${currencySymbol(g.reportingCurrency)})`}
              action={<Button size="sm" onClick={() => archive.mutate({ id: g.id, isArchived: !g.isArchived })}>{g.isArchived ? t('consolidation.unarchive') : t('consolidation.archive')}</Button>}
            />
            <ul className="flex flex-col gap-1.5 text-sm">
              {g.members.map((m) => (
                <li key={m.companyId} className="flex items-center gap-2" data-testid="group-member">
                  <span>{m.name ?? <span className="font-mono text-xs">{m.companyId.slice(0, 8)}</span>}</span>
                  {m.status === 'ok' ? <Badge tone="success">{t('consolidation.statusOk')}</Badge> : <Badge tone="danger">{t(`consolidation.deny.${m.status}`)}</Badge>}
                  <Button size="sm" className="ml-auto" onClick={() => removeMember.mutate({ id: g.id, companyId: m.companyId })}>{t('consolidation.removeMember')}</Button>
                </li>
              ))}
            </ul>
            {!g.isArchived && candidates.length > 0 && (
              <div className="mt-3 flex items-center gap-2">
                <Select aria-label={t('consolidation.addMember')} defaultValue="" onChange={(e) => e.target.value && addMember.mutate({ id: g.id, companyId: e.target.value })} className="w-72">
                  <option value="">{t('consolidation.addMember')}</option>
                  {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

export function ConsolidationPage() {
  const { t } = useTranslation();
  const { data, isPending, error } = useGroups();
  const groups = (data?.groups ?? []).filter((g) => !g.isArchived);
  const [tab, setTab] = useState<Tab>('groups');
  const [groupId, setGroupId] = useState('');
  useEffect(() => {
    if (!groupId && groups[0]) setGroupId(groups[0].id);
  }, [groups, groupId]);
  const group = (data?.groups ?? []).find((g) => g.id === groupId) ?? null;

  // Rapor parametreleri (Çalıştır düğmesiyle uygulanır; yazarken sorgu atılmaz)
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [closingDate, setClosingDate] = useState('');
  const [plMethod, setPlMethod] = useState<'closing' | 'average'>('closing');
  const [mapLevel, setMapLevel] = useState<(typeof MAP_LEVELS)[number]>('3');
  const [closingRates, setClosingRates] = useState('');
  const [plRates, setPlRates] = useState('');
  const [asOf, setAsOf] = useState(todayIso());
  const [rateDate, setRateDate] = useState('');
  const [fxRates, setFxRates] = useState('');
  const [compare, setCompare] = useState<'none' | 'previous' | 'last_year'>('previous');
  const [execRates, setExecRates] = useState('');
  const [applied, setApplied] = useState<{ tab: Tab; qs: string } | null>(null);

  const qsReport = new URLSearchParams({ from, to, plMethod, mapLevel, ...(closingDate ? { closingDate } : {}), ...(closingRates.trim() ? { closingRates: closingRates.trim() } : {}), ...(plRates.trim() ? { plRates: plRates.trim() } : {}) }).toString();
  const qsFx = new URLSearchParams({ asOf, ...(rateDate ? { rateDate } : {}), ...(fxRates.trim() ? { rates: fxRates.trim() } : {}) }).toString();
  const qsExec = new URLSearchParams({ from, to, compare, ...(execRates.trim() ? { rates: execRates.trim() } : {}) }).toString();
  const currentQs = tab === 'report' ? qsReport : tab === 'fx' ? qsFx : qsExec;
  const run = applied && applied.tab === tab && groupId ? applied.qs : null;

  const reportQ = useQuery({ queryKey: ['consolidation', 'report', groupId, run], queryFn: () => api<{ report: ConsolidatedReportData }>(`/api/consolidation/groups/${groupId}/report?${run}`), enabled: tab === 'report' && run !== null, retry: false });
  const fxQ = useQuery({ queryKey: ['consolidation', 'fx', groupId, run], queryFn: () => api<{ report: GroupFxPositionData }>(`/api/consolidation/groups/${groupId}/fx-position?${run}`), enabled: tab === 'fx' && run !== null, retry: false });
  const execQ = useQuery({ queryKey: ['consolidation', 'exec', groupId, run], queryFn: () => api<{ report: ExecutiveSummaryData }>(`/api/consolidation/groups/${groupId}/executive-summary?${run}`), enabled: tab === 'executive' && run !== null, retry: false });
  const active = tab === 'report' ? reportQ : tab === 'fx' ? fxQ : execQ;

  const exportKey = tab === 'report' ? 'consolidated' : tab === 'fx' ? 'fx-position' : 'executive-summary';
  const tabs: { key: Tab; label: string }[] = [
    { key: 'groups', label: t('consolidation.tabs.groups') },
    { key: 'report', label: t('consolidation.tabs.report') },
    { key: 'fx', label: t('consolidation.tabs.fx') },
    { key: 'executive', label: t('consolidation.tabs.executive') },
    { key: 'eliminations', label: t('consolidation.tabs.eliminations') },
  ];

  if (isPending) return <PageLoading />;
  if (error) return <Callout tone="danger">{errorMessage(error)}</Callout>;

  const needsGroup = tab !== 'groups';
  return (
    <div className="print-wide">
      <PageHeader
        title={t('consolidation.title')}
        description={t('consolidation.subtitle')}
        actions={
          group && (tab === 'report' || tab === 'fx' || tab === 'executive') ? (
            <ExportMenu path={`/api/consolidation/groups/${group.id}/export/${exportKey}`} params={Object.fromEntries(new URLSearchParams(run ?? ''))} disabled={!run || !active.data} />
          ) : undefined
        }
      />
      <PrintHeader subtitle={group ? `${group.name} (${currencySymbol(group.reportingCurrency)})` : undefined} note={t('consolidation.unverified')} />
      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <SegmentedTabs items={tabs} value={tab} onChange={setTab} />
        {needsGroup && groups.length > 0 && (
          <Field label={t('consolidation.group')}>
            {(id) => (
              <Select id={id} value={groupId} onChange={(e) => { setGroupId(e.target.value); setApplied(null); }} className="w-64">
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({currencySymbol(g.reportingCurrency)})</option>)}
              </Select>
            )}
          </Field>
        )}
      </div>

      {tab === 'groups' && <GroupsPanel groups={data?.groups ?? []} />}

      {needsGroup && !group && (
        <Card>
          <EmptyState title={t('consolidation.noGroup')} description={t('consolidation.noGroupDesc')} action={<Button variant="primary" onClick={() => setTab('groups')}>{t('consolidation.newGroup')}</Button>} />
        </Card>
      )}

      {group && tab === 'eliminations' && <EliminationsPanel groupId={group.id} currency={group.reportingCurrency} archived={group.isArchived} />}

      {group && (tab === 'report' || tab === 'fx' || tab === 'executive') && (
        <>
          <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden" data-testid="report-params">
            {(tab === 'report' || tab === 'executive') && (
              <>
                <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
                <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
              </>
            )}
            {tab === 'report' && (
              <>
                <Field label={t('consolidation.closingDate')} hint={t('consolidation.closingDateHint')}>{(id) => <Input id={id} type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)} className="w-44" />}</Field>
                <Field label={t('consolidation.plMethod')} hint={t('consolidation.plMethodHint')}>
                  {(id) => (
                    <Select id={id} value={plMethod} onChange={(e) => setPlMethod(e.target.value as typeof plMethod)} className="w-56">
                      <option value="closing">{t('consolidation.plClosing')}</option>
                      <option value="average">{t('consolidation.plAverage')}</option>
                    </Select>
                  )}
                </Field>
                <Field label={t('consolidation.mapLevel')} hint={t('consolidation.mapLevelHint')}>
                  {(id) => (
                    <Select id={id} value={mapLevel} onChange={(e) => setMapLevel(e.target.value as typeof mapLevel)} className="w-48">
                      {MAP_LEVELS.map((m) => <option key={m} value={m}>{t(`consolidation.levels.${m}`)}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label={t('consolidation.closingRates')} hint={t('consolidation.manualRatesHint')}>{(id) => <Input id={id} value={closingRates} onChange={(e) => setClosingRates(e.target.value)} placeholder="GBP:40" className="w-44" />}</Field>
                <Field label={t('consolidation.plRates')}>{(id) => <Input id={id} value={plRates} onChange={(e) => setPlRates(e.target.value)} placeholder="GBP:38" className="w-44" />}</Field>
              </>
            )}
            {tab === 'fx' && (
              <>
                <Field label={t('fxPosition.asOf')}>{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-44" />}</Field>
                <Field label={t('fxPosition.rateDate')} hint={t('fxPosition.rateDateHint')}>{(id) => <Input id={id} type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} className="w-44" />}</Field>
                <Field label={t('fxPosition.manualRatesGroup')} hint={t('fxPosition.manualRatesHint')}>{(id) => <Input id={id} value={fxRates} onChange={(e) => setFxRates(e.target.value)} placeholder="USD:35" className="w-44" />}</Field>
              </>
            )}
            {tab === 'executive' && (
              <>
                <Field label={t('executive.compare')}>
                  {(id) => (
                    <Select id={id} value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} className="w-52">
                      <option value="none">{t('executive.compareNone')}</option>
                      <option value="previous">{t('executive.comparePrevious')}</option>
                      <option value="last_year">{t('executive.compareLastYear')}</option>
                    </Select>
                  )}
                </Field>
                <Field label={t('consolidation.execRates')} hint={t('consolidation.manualRatesHint')}>{(id) => <Input id={id} value={execRates} onChange={(e) => setExecRates(e.target.value)} placeholder="GBP:40" className="w-44" />}</Field>
              </>
            )}
            <Button variant="primary" onClick={() => setApplied({ tab, qs: currentQs })} loading={active.isFetching}>{t('consolidation.run')}</Button>
          </div>

          {run === null ? (
            <Card><EmptyState title={t('consolidation.runHint')} description={t('consolidation.runHintDesc')} /></Card>
          ) : active.error ? (
            <Callout tone="danger">{errorMessage(active.error)}</Callout>
          ) : active.isPending ? (
            <PageLoading />
          ) : tab === 'report' && reportQ.data ? (
            <ConsolidatedReportView data={reportQ.data.report} />
          ) : tab === 'fx' && fxQ.data ? (
            <Card className="p-5"><GroupFxPositionView data={fxQ.data.report} /></Card>
          ) : tab === 'executive' && execQ.data ? (
            <ExecutiveView data={execQ.data.report} />
          ) : null}
        </>
      )}
    </div>
  );
}
