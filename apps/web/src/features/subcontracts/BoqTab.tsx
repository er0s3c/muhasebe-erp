import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dec, roundMoney } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { SubcontractDetail, SubcontractRevisionDetail } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { SUBCONTRACT_INVALIDATE, useCostCodes } from './common';

interface Draft {
  key: string;
  lineKey?: string;
  itemNo: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  wbsId: string;
  costCodeId: string;
}

const blank = (): Draft => ({ key: crypto.randomUUID(), itemNo: '', description: '', unit: 'adet', quantity: '', unitPrice: '', wbsId: '', costCodeId: '' });
const toBody = (lines: Draft[]) =>
  lines.map((l) => ({
    ...(l.lineKey ? { lineKey: l.lineKey } : {}),
    ...(l.itemNo.trim() ? { itemNo: l.itemNo.trim() } : {}),
    description: l.description.trim(),
    unit: l.unit.trim(),
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    wbsId: l.wbsId,
    costCodeId: l.costCodeId || null,
  }));
const lineTotal = (l: Draft) => (l.quantity && l.unitPrice ? roundMoney(dec(l.quantity).times(l.unitPrice)) : dec(0));

/** Revizyonlu BOQ: onaylı revizyon salt okunur, değişiklik yeni revizyonla yapılır. */
export function BoqTab({ detail }: { detail: SubcontractDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const sc = detail.subcontract;
  const { byId } = useProjectOptions();
  const wbsOptions = useMemo(() => (byId.get(sc.projectId)?.wbs ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}`, keywords: `${w.code} ${w.name}` })), [byId, sc.projectId]);
  const costCodes = useCostCodes();

  const draftRev = detail.revisions.find((r) => r.status === 'draft');
  const currentRev = detail.revisions.find((r) => r.isCurrent);
  const [selected, setSelected] = useState<string>('');
  useEffect(() => {
    setSelected((cur) => (detail.revisions.some((r) => r.id === cur) ? cur : (draftRev ?? currentRev ?? detail.revisions[0])?.id ?? ''));
  }, [detail.revisions, draftRev, currentRev]);

  const { data, isPending } = useCQuery<SubcontractRevisionDetail>(['subcontract', sc.id, 'revision', selected], selected ? `/api/subcontract-revisions/${selected}` : null);
  const revision = data?.revision;
  const editable = revision?.status === 'draft' && can('subcontracts.manage');

  const [lines, setLines] = useState<Draft[]>([]);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!data) return;
    setLines(
      data.lines.map((l) => ({ key: l.id, lineKey: l.lineKey, itemNo: l.itemNo ?? '', description: l.description, unit: l.unit, quantity: String(Number(l.quantity)), unitPrice: String(Number(l.unitPrice)), wbsId: l.wbsId, costCodeId: l.costCodeId ?? '' })),
    );
    setError(null);
  }, [data]);

  const patch = (key: string, p: Partial<Draft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const valid = lines.length > 0 && lines.every((l) => l.description.trim() && l.unit.trim() && dec(l.quantity || 0).gt(0) && l.unitPrice !== '' && l.wbsId);
  const total = lines.reduce((s, l) => s.plus(lineTotal(l)), dec(0));

  const newRevision = useCMutation((_: void, call) => call(`/api/subcontracts/${sc.id}/revisions`, { method: 'POST', body: { copyFromCurrent: true } }), SUBCONTRACT_INVALIDATE);
  const save = useCMutation(
    (_: void, call) =>
      call(`/api/subcontract-revisions/${selected}/lines`, {
        method: 'PUT',
        body: { lines: toBody(lines) },
      }),
    SUBCONTRACT_INVALIDATE,
  );
  // Onay, ekrandaki son hâli de kaydeder (kaydedilmemiş değişiklik sessizce atlanmasın)
  const approve = useCMutation(async (_: void, call) => {
    await call(`/api/subcontract-revisions/${selected}/lines`, { method: 'PUT', body: { lines: toBody(lines) } });
    return call(`/api/subcontract-revisions/${selected}/approve`, { method: 'POST', body: {} });
  }, SUBCONTRACT_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/subcontract-revisions/${selected}`, { method: 'DELETE' }), SUBCONTRACT_INVALIDATE);

  const run = (m: { mutate: (v: undefined, o: { onSuccess: () => void; onError: (e: Error) => void }) => void }, done?: string) => {
    setError(null);
    m.mutate(undefined, { onSuccess: () => done && toast.success(done), onError: setError });
  };

  const closed = sc.status === 'completed' || sc.status === 'terminated';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label={t('subcontracts.boq.revision')} value={selected} onChange={(e) => setSelected(e.target.value)} className="w-72">
          {detail.revisions.map((r) => (
            <option key={r.id} value={r.id}>
              {t('subcontracts.boq.revLabel', { rev: r.revisionNo, status: t(`subcontracts.boq.revStatus.${r.status}`), total: money(r.total) })}
            </option>
          ))}
        </Select>
        {revision?.status === 'approved' && <Badge tone="brand">{t('subcontracts.boq.current')}</Badge>}
        {revision?.approvedAt && <span className="text-xs text-muted">{t('subcontracts.boq.approvedAt', { date: formatDateTR(revision.approvedAt.slice(0, 10)) })}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {!draftRev && !closed && can('subcontracts.manage') && sc.status === 'active' && (
            <Button loading={newRevision.isPending} onClick={() => run(newRevision, t('subcontracts.boq.revCreated'))}>
              <Plus className="size-4" aria-hidden />
              {t('subcontracts.boq.newRevision')}
            </Button>
          )}
        </div>
      </div>

      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {revision?.status === 'draft' && sc.status === 'draft' && <Callout tone="info">{t('subcontracts.boq.firstDraftHint')}</Callout>}
      {wbsOptions.length === 0 && editable && <Callout tone="warning">{t('subcontracts.boq.noWbs')}</Callout>}

      {isPending || !data ? (
        <PageLoading />
      ) : (
        <Card>
          <CardHeader
            title={t('subcontracts.boq.title')}
            description={t('subcontracts.boq.desc')}
            action={editable ? (
              <Button onClick={() => setLines((ls) => [...ls, blank()])}>
                <Plus className="size-4" aria-hidden />
                {t('subcontracts.boq.addLine')}
              </Button>
            ) : undefined}
          />
          {lines.length === 0 ? (
            <EmptyState title={t('subcontracts.boq.empty')} description={editable ? t('subcontracts.boq.emptyDesc') : undefined} />
          ) : (
            <TableWrap className="rounded-none border-0">
              <Table>
                <thead>
                  <tr>
                    <Th className="w-20">{t('subcontracts.boq.cols.itemNo')}</Th>
                    <Th>{t('subcontracts.boq.cols.description')}</Th>
                    <Th className="w-24">{t('subcontracts.boq.cols.unit')}</Th>
                    <Th num className="w-32">{t('subcontracts.boq.cols.quantity')}</Th>
                    <Th num className="w-32">{t('subcontracts.boq.cols.unitPrice')}</Th>
                    <Th num className="w-36">{t('subcontracts.boq.cols.amount')}</Th>
                    <Th className="w-56">{t('subcontracts.boq.cols.wbs')}</Th>
                    <Th className="w-36">{t('subcontracts.boq.cols.costCode')}</Th>
                    {editable && <Th className="w-10"><span className="sr-only">{t('common.delete')}</span></Th>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const wbs = byId.get(sc.projectId)?.wbs.find((w) => w.id === l.wbsId);
                    const code = costCodes.find((c) => c.id === l.costCodeId);
                    return (
                      <Tr key={l.key}>
                        {editable ? (
                          <>
                            <Td><Input aria-label={`${t('subcontracts.boq.cols.itemNo')} ${i + 1}`} value={l.itemNo} onChange={(e) => patch(l.key, { itemNo: e.target.value })} maxLength={40} /></Td>
                            <Td><Input aria-label={`${t('subcontracts.boq.cols.description')} ${i + 1}`} value={l.description} onChange={(e) => patch(l.key, { description: e.target.value })} maxLength={300} /></Td>
                            <Td><Input aria-label={`${t('subcontracts.boq.cols.unit')} ${i + 1}`} value={l.unit} onChange={(e) => patch(l.key, { unit: e.target.value })} maxLength={20} /></Td>
                            <Td num><Input aria-label={`${t('subcontracts.boq.cols.quantity')} ${i + 1}`} inputMode="decimal" className="num text-right" value={l.quantity} onChange={(e) => patch(l.key, { quantity: e.target.value.replace(',', '.') })} /></Td>
                            <Td num><Input aria-label={`${t('subcontracts.boq.cols.unitPrice')} ${i + 1}`} inputMode="decimal" className="num text-right" value={l.unitPrice} onChange={(e) => patch(l.key, { unitPrice: e.target.value.replace(',', '.') })} /></Td>
                            <Td num>{money(lineTotal(l).toFixed(2))}</Td>
                            <Td><Combobox aria-label={`${t('subcontracts.boq.cols.wbs')} ${i + 1}`} options={wbsOptions} value={l.wbsId || null} onChange={(v) => patch(l.key, { wbsId: v })} placeholder={t('subcontracts.boq.pickWbs')} /></Td>
                            <Td>
                              <Select aria-label={`${t('subcontracts.boq.cols.costCode')} ${i + 1}`} value={l.costCodeId} onChange={(e) => patch(l.key, { costCodeId: e.target.value })}>
                                <option value="">{t('subcontracts.boq.defaultCode')}</option>
                                {costCodes.filter((c) => c.isActive).map((c) => (
                                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                                ))}
                              </Select>
                            </Td>
                            <Td>
                              <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                                <Trash2 className="size-4" aria-hidden />
                              </button>
                            </Td>
                          </>
                        ) : (
                          <>
                            <Td className="font-mono text-[13px] text-muted">{l.itemNo}</Td>
                            <Td>{l.description}</Td>
                            <Td className="text-muted">{l.unit}</Td>
                            <Td num>{money(l.quantity, 4).replace(/,?0+$/, '')}</Td>
                            <Td num>{money(l.unitPrice)}</Td>
                            <Td num>{money(lineTotal(l).toFixed(2))}</Td>
                            <Td className="text-muted">{wbs ? `${wbs.code} — ${wbs.name}` : '—'}</Td>
                            <Td className="text-muted">{code?.code ?? t('subcontracts.boq.defaultCode')}</Td>
                          </>
                        )}
                      </Tr>
                    );
                  })}
                  <Tr className="border-t border-text bg-surface-2">
                    <Td colSpan={5}>{t('common.total')}</Td>
                    <Td num>{moneyIn(total.toFixed(2), sc.currencyCode)}</Td>
                    <Td colSpan={editable ? 3 : 2} />
                  </Tr>
                </tbody>
              </Table>
            </TableWrap>
          )}
          {editable && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border p-4">
              <Button variant="danger" loading={remove.isPending} onClick={() => run(remove, t('subcontracts.boq.deleted'))}>
                {t('subcontracts.boq.deleteDraft')}
              </Button>
              <Button loading={save.isPending} disabled={!valid} onClick={() => run(save, t('subcontracts.boq.saved'))}>
                {t('subcontracts.boq.save')}
              </Button>
              {can('subcontracts.approve') && (
                <Button variant="primary" loading={approve.isPending} disabled={!valid} onClick={() => run(approve, t('subcontracts.boq.approved'))}>
                  {sc.status === 'draft' ? t('subcontracts.boq.approveActivate') : t('subcontracts.boq.approve')}
                </Button>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
