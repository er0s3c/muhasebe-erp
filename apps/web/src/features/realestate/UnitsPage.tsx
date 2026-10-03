import { Building2, Layers, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { generateUnitNumbers } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { UnitRow } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { REAL_ESTATE_INVALIDATE, UNIT_STATUSES, UNIT_TYPES, UnitStatusBadge, unitLabel } from './common';

const CHIP = {
  available: 'border-border-strong bg-surface',
  reserved: 'border-transparent bg-warning-soft text-warning',
  sold: 'border-transparent bg-success-soft text-success',
  handed_over: 'border-text bg-surface',
} as const;

export function UnitsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useCan()('realestate.manage');
  const { projects } = useProjectOptions();
  const ownProjects = projects.filter((p) => p.kind === 'own' && p.status !== 'completed' && p.status !== 'cancelled');
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const [view, setView] = useState<'table' | 'grid'>('table');
  const [editing, setEditing] = useState<UnitRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState(false);

  const qs = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (status) q.set('status', status);
    return q.toString();
  }, [projectId, status]);
  const lim = useListLimit(qs, 2000, 5000);
  const { data, isPending } = useCQuery<{ units: UnitRow[] } & { truncated?: boolean }>(['units', 'list', qs, lim.limit], `/api/real-estate/units?${qs}${qs ? '&' : ''}limit=${lim.limit}`);
  const rows = useMemo(() => data?.units ?? [], [data]);
  const filtered = !!(projectId || status);

  const open = (u: UnitRow) => (u.contractId ? navigate(`/real-estate/contracts/${u.contractId}`) : setEditing(u));

  const actions = canManage && (
    <>
      <Button onClick={() => setBulk(true)}>
        <Layers className="size-4" aria-hidden />
        {t('realEstate.units.bulk')}
      </Button>
      <Button variant="primary" onClick={() => setAdding(true)}>
        <Plus className="size-4" aria-hidden />
        {t('realEstate.units.add')}
      </Button>
    </>
  );

  const groups = useMemo(() => {
    const m = new Map<string, Map<number | null, UnitRow[]>>();
    for (const u of rows) {
      const key = `${u.projectCode} · ${u.block || '—'}`;
      const floors = m.get(key) ?? new Map<number | null, UnitRow[]>();
      floors.set(u.floor, [...(floors.get(u.floor) ?? []), u]);
      m.set(key, floors);
    }
    return [...m.entries()];
  }, [rows]);

  return (
    <>
      <PageHeader title={t('realEstate.units.title')} description={t('realEstate.units.subtitle')} actions={actions || undefined} />
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !filtered ? (
        <Card>
          <EmptyState icon={<Building2 className="size-5" />} title={t('realEstate.units.empty')} description={t('realEstate.units.emptyDesc')} action={actions || undefined} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select aria-label={t('realEstate.filters.project')} value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-64">
              <option value="">{t('realEstate.filters.allProjects')}</option>
              {ownProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </Select>
            <Select aria-label={t('realEstate.filters.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
              <option value="">{t('realEstate.filters.allStatuses')}</option>
              {UNIT_STATUSES.map((s) => (
                <option key={s} value={s}>{t(`realEstate.unitStatus.${s}`)}</option>
              ))}
            </Select>
            <SegmentedTabs
              items={[{ key: 'table', label: t('realEstate.units.viewTable') }, { key: 'grid', label: t('realEstate.units.viewGrid') }]}
              value={view}
              onChange={setView}
              className="ml-auto"
            />
          </div>
          {rows.length === 0 ? (
            <Card><EmptyState title={t('common.noResults')} /></Card>
          ) : view === 'table' ? (
            <>
              <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('realEstate.cols.unit')}</Th>
                    <Th>{t('realEstate.cols.project')}</Th>
                    <Th>{t('realEstate.cols.type')}</Th>
                    <Th num>{t('realEstate.cols.floor')}</Th>
                    <Th num>{t('realEstate.cols.m2')}</Th>
                    <Th num>{t('realEstate.cols.listPrice')}</Th>
                    <Th className="w-32">{t('realEstate.cols.status')}</Th>
                    <Th>{t('realEstate.cols.buyer')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <Tr key={u.id} clickable tabIndex={0} onClick={() => open(u)} onKeyDown={(e) => e.key === 'Enter' && open(u)}>
                      <Td className="font-mono text-[13px]">{unitLabel(u)}</Td>
                      <Td className="text-muted">{u.projectCode}</Td>
                      <Td>{t(`realEstate.unitTypes.${u.unitType}`)}{u.rooms ? ` · ${u.rooms}` : ''}</Td>
                      <Td num>{u.floor ?? '—'}</Td>
                      <Td num>{u.grossM2 ? Number(u.grossM2).toLocaleString('tr-TR') : '—'}</Td>
                      <Td num>{u.listPrice && u.listCurrency ? moneyIn(u.listPrice, u.listCurrency, 0) : '—'}</Td>
                      <Td><UnitStatusBadge status={u.status} /></Td>
                      <Td className="text-muted">{u.buyerName ?? ''}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
              <TruncatedNote truncated={data?.truncated} shown={rows.length} onMore={lim.more} atMax={lim.atMax} />
            </>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map(([title, floors]) => (
                <Card key={title} className="p-4">
                  <h2 className="mb-3 text-base">{title}</h2>
                  <div className="flex flex-col gap-2">
                    {[...floors.entries()].sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1)).map(([floor, units]) => (
                      <div key={String(floor)} className="flex flex-wrap items-center gap-2">
                        <span className="w-16 text-xs text-muted">{floor === null ? '—' : t('realEstate.units.floorN', { n: floor })}</span>
                        {units.map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            title={`${t(`realEstate.unitStatus.${u.status}`)}${u.buyerName ? ` · ${u.buyerName}` : ''}`}
                            aria-label={`${unitLabel(u)} ${t(`realEstate.unitStatus.${u.status}`)}`}
                            onClick={() => open(u)}
                            className={cn('min-w-14 rounded-md border px-2.5 py-1.5 text-sm', CHIP[u.status])}
                          >
                            {u.unitNo}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
              <div className="flex flex-wrap gap-3 text-xs text-muted">
                {UNIT_STATUSES.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span className={cn('inline-block size-3 rounded border', CHIP[s])} />
                    {t(`realEstate.unitStatus.${s}`)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <UnitSheet open={adding || !!editing} unit={editing} projects={ownProjects} defaultProjectId={projectId} onOpenChange={(o) => { if (!o) { setAdding(false); setEditing(null); } }} />
      <BulkSheet open={bulk} onOpenChange={setBulk} projects={ownProjects} defaultProjectId={projectId} />
    </>
  );
}

interface ProjectLite { id: string; code: string; name: string }

function UnitSheet({ open, unit, projects, defaultProjectId, onOpenChange }: { open: boolean; unit: UnitRow | null; projects: ProjectLite[]; defaultProjectId: string; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ projectId: '', block: '', floor: '', unitNo: '', unitType: 'apartment', grossM2: '', netM2: '', rooms: '', listPrice: '', listCurrency: 'GBP', note: '' });
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!open) return;
    setF({
      projectId: unit?.projectId ?? defaultProjectId,
      block: unit?.block ?? '',
      floor: unit?.floor != null ? String(unit.floor) : '',
      unitNo: unit?.unitNo ?? '',
      unitType: unit?.unitType ?? 'apartment',
      grossM2: unit?.grossM2 ? String(Number(unit.grossM2)) : '',
      netM2: unit?.netM2 ? String(Number(unit.netM2)) : '',
      rooms: unit?.rooms ?? '',
      listPrice: unit?.listPrice ? String(Number(unit.listPrice)) : '',
      listCurrency: unit?.listCurrency ?? 'GBP',
      note: unit?.note ?? '',
    });
    setError(null);
  }, [open, unit, defaultProjectId]);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const body = () => ({
    ...(unit ? {} : { projectId: f.projectId }),
    block: f.block.trim(),
    floor: f.floor.trim() === '' ? null : Number(f.floor),
    unitNo: f.unitNo.trim(),
    unitType: f.unitType,
    grossM2: f.grossM2.trim() ? f.grossM2.replace(',', '.') : null,
    netM2: f.netM2.trim() ? f.netM2.replace(',', '.') : null,
    rooms: f.rooms.trim() || null,
    listPrice: f.listPrice.trim() ? f.listPrice.replace(',', '.') : null,
    listCurrency: f.listPrice.trim() ? f.listCurrency : null,
    note: f.note.trim() || null,
  });
  const save = useCMutation((_: void, call) => (unit ? call(`/api/real-estate/units/${unit.id}`, { method: 'PUT', body: body() }) : call('/api/real-estate/units', { method: 'POST', body: body() })), REAL_ESTATE_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/real-estate/units/${unit!.id}`, { method: 'DELETE' }), REAL_ESTATE_INVALIDATE);
  const canSave = f.unitNo.trim().length > 0 && (!!unit || !!f.projectId);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={unit ? t('realEstate.units.editTitle') : t('realEstate.units.addTitle')}
      footer={
        <>
          {unit && unit.status === 'available' && (
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => { toast.success(t('common.deleted')); onOpenChange(false); }, onError: setError })}>{t('common.delete')}</Button>
          )}
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={() => { setError(null); save.mutate(undefined, { onSuccess: () => { toast.success(t('common.saved')); onOpenChange(false); }, onError: setError }); }}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {unit?.contractCode && <Callout tone="info">{t('realEstate.units.hasContract', { code: unit.contractCode })}</Callout>}
        {!unit && (
          <Field label={t('realEstate.cols.project')} required>
            {(id) => <Combobox id={id} value={f.projectId || null} onChange={(v) => set('projectId', v)} placeholder={t('realEstate.units.projectPlaceholder')} options={projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}`, keywords: `${p.code} ${p.name}` }))} />}
          </Field>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('realEstate.cols.block')}>{(id) => <Input id={id} value={f.block} onChange={(e) => set('block', e.target.value)} maxLength={40} />}</Field>
          <Field label={t('realEstate.cols.floor')}>{(id) => <Input id={id} inputMode="numeric" value={f.floor} onChange={(e) => set('floor', e.target.value.replace(/[^\d-]/g, ''))} />}</Field>
          <Field label={t('realEstate.units.unitNo')} required>{(id) => <Input id={id} value={f.unitNo} onChange={(e) => set('unitNo', e.target.value)} maxLength={40} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('realEstate.cols.type')}>
            {(id) => (
              <Select id={id} value={f.unitType} onChange={(e) => set('unitType', e.target.value)}>
                {UNIT_TYPES.map((u) => <option key={u} value={u}>{t(`realEstate.unitTypes.${u}`)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('realEstate.units.rooms')}>{(id) => <Input id={id} value={f.rooms} onChange={(e) => set('rooms', e.target.value)} placeholder="2+1" maxLength={20} />}</Field>
          <Field label={t('realEstate.units.grossM2')}>{(id) => <Input id={id} inputMode="decimal" value={f.grossM2} onChange={(e) => set('grossM2', e.target.value)} />}</Field>
          <Field label={t('realEstate.units.netM2')}>{(id) => <Input id={id} inputMode="decimal" value={f.netM2} onChange={(e) => set('netM2', e.target.value)} />}</Field>
          <Field label={t('realEstate.cols.listPrice')}>{(id) => <Input id={id} inputMode="decimal" value={f.listPrice} onChange={(e) => set('listPrice', e.target.value)} />}</Field>
          <Field label={t('realEstate.units.currency')}>
            {(id) => <Select id={id} value={f.listCurrency} onChange={(e) => set('listCurrency', e.target.value)}><CurrencyOptions wide /></Select>}
          </Field>
        </div>
        <Field label={t('realEstate.units.note')}>{(id) => <Textarea id={id} rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={500} />}</Field>
      </div>
    </Sheet>
  );
}

function BulkSheet({ open, onOpenChange, projects, defaultProjectId }: { open: boolean; onOpenChange: (o: boolean) => void; projects: ProjectLite[]; defaultProjectId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ projectId: '', block: 'A', unitType: 'apartment', floorFrom: '1', floorTo: '4', perFloor: '4', grossM2: '', rooms: '', listPrice: '', listCurrency: 'GBP' });
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (open) { setF((x) => ({ ...x, projectId: defaultProjectId })); setError(null); }
  }, [open, defaultProjectId]);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const from = Number(f.floorFrom);
  const to = Number(f.floorTo);
  const per = Number(f.perFloor);
  const valid = Number.isInteger(from) && Number.isInteger(to) && Number.isInteger(per) && to >= from && per >= 1 && (to - from + 1) * per <= 500;
  const preview = valid ? generateUnitNumbers(from, to, per) : [];
  const save = useCMutation(
    (_: void, call) =>
      call<{ created: number; skipped: number }>('/api/real-estate/units/bulk', {
        method: 'POST',
        body: {
          projectId: f.projectId,
          block: f.block.trim(),
          unitType: f.unitType,
          floorFrom: from,
          floorTo: to,
          perFloor: per,
          grossM2: f.grossM2.trim() ? f.grossM2.replace(',', '.') : null,
          rooms: f.rooms.trim() || null,
          listPrice: f.listPrice.trim() ? f.listPrice.replace(',', '.') : null,
          listCurrency: f.listPrice.trim() ? f.listCurrency : null,
        },
      }),
    REAL_ESTATE_INVALIDATE,
  );
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('realEstate.units.bulkTitle')}
      description={t('realEstate.units.bulkDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid || !f.projectId} onClick={() => { setError(null); save.mutate(undefined, { onSuccess: (r) => { toast.success(t('realEstate.units.bulkDone', { created: r.created, skipped: r.skipped })); onOpenChange(false); }, onError: setError }); }}>
            {t('realEstate.units.bulkCreate', { n: preview.length })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('realEstate.cols.project')} required>
          {(id) => <Combobox id={id} value={f.projectId || null} onChange={(v) => set('projectId', v)} placeholder={t('realEstate.units.projectPlaceholder')} options={projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}`, keywords: `${p.code} ${p.name}` }))} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('realEstate.cols.block')}>{(id) => <Input id={id} value={f.block} onChange={(e) => set('block', e.target.value)} maxLength={40} />}</Field>
          <Field label={t('realEstate.cols.type')}>
            {(id) => (
              <Select id={id} value={f.unitType} onChange={(e) => set('unitType', e.target.value)}>
                {UNIT_TYPES.map((u) => <option key={u} value={u}>{t(`realEstate.unitTypes.${u}`)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('realEstate.units.floorFrom')}>{(id) => <Input id={id} inputMode="numeric" value={f.floorFrom} onChange={(e) => set('floorFrom', e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label={t('realEstate.units.floorTo')}>{(id) => <Input id={id} inputMode="numeric" value={f.floorTo} onChange={(e) => set('floorTo', e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label={t('realEstate.units.perFloor')}>{(id) => <Input id={id} inputMode="numeric" value={f.perFloor} onChange={(e) => set('perFloor', e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label={t('realEstate.units.rooms')}>{(id) => <Input id={id} value={f.rooms} onChange={(e) => set('rooms', e.target.value)} placeholder="2+1" />}</Field>
          <Field label={t('realEstate.units.grossM2')}>{(id) => <Input id={id} inputMode="decimal" value={f.grossM2} onChange={(e) => set('grossM2', e.target.value)} />}</Field>
          <Field label={t('realEstate.cols.listPrice')}>{(id) => <Input id={id} inputMode="decimal" value={f.listPrice} onChange={(e) => set('listPrice', e.target.value)} />}</Field>
          <Field label={t('realEstate.units.currency')}>
            {(id) => <Select id={id} value={f.listCurrency} onChange={(e) => set('listCurrency', e.target.value)}><CurrencyOptions wide /></Select>}
          </Field>
        </div>
        {preview.length > 0 && (
          <p className="text-xs text-muted">
            {t('realEstate.units.preview', { n: preview.length })}: {preview.slice(0, 8).map((p) => `${f.block ? `${f.block}-` : ''}${p.unitNo}`).join(', ')}{preview.length > 8 ? ' …' : ''}
          </p>
        )}
      </div>
    </Sheet>
  );
}
