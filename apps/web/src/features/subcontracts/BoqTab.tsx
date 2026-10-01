import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { SubcontractDetail, SubcontractRevisionDetail } from '../../lib/types';
import { BoqEditor, type BoqBody } from './BoqEditor';
import { SUBCONTRACT_INVALIDATE } from './common';

/**
 * Revizyonlu BOQ: onaylı revizyon salt okunur. Taslak sözleşmenin ilk BOQ'su burada düzenlenip onaylanır;
 * yürürlükteki sözleşmede değişiklik yalnızca değişiklik emriyle yapılır (DE revizyonu DE sayfasında düzenlenir).
 */
export function BoqTab({ detail }: { detail: SubcontractDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const sc = detail.subcontract;

  const draftRev = detail.revisions.find((r) => r.status === 'draft');
  const currentRev = detail.revisions.find((r) => r.isCurrent);
  const [selected, setSelected] = useState<string>('');
  useEffect(() => {
    setSelected((cur) => (detail.revisions.some((r) => r.id === cur) ? cur : (sc.status === 'draft' ? draftRev : currentRev ?? draftRev ?? detail.revisions[0])?.id ?? ''));
  }, [detail.revisions, draftRev, currentRev, sc.status]);

  const { data, isPending } = useCQuery<SubcontractRevisionDetail>(['subcontract', sc.id, 'revision', selected], selected ? `/api/subcontract-revisions/${selected}` : null);
  const revision = data?.revision;
  const selectedRow = detail.revisions.find((r) => r.id === selected);
  const editable = revision?.status === 'draft' && !selectedRow?.variationId && can('subcontracts.manage');

  const [error, setError] = useState<Error | null>(null);
  const save = useCMutation((body: BoqBody, call) => call(`/api/subcontract-revisions/${selected}/lines`, { method: 'PUT', body: { lines: body } }), SUBCONTRACT_INVALIDATE);
  // Onay, ekrandaki son hâli de kaydeder (kaydedilmemiş değişiklik sessizce atlanmasın)
  const approve = useCMutation(async (body: BoqBody, call) => {
    await call(`/api/subcontract-revisions/${selected}/lines`, { method: 'PUT', body: { lines: body } });
    return call(`/api/subcontract-revisions/${selected}/approve`, { method: 'POST', body: {} });
  }, SUBCONTRACT_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/subcontract-revisions/${selected}`, { method: 'DELETE' }), SUBCONTRACT_INVALIDATE);

  const run = <V,>(m: { mutate: (v: V, o: { onSuccess: () => void; onError: (e: Error) => void }) => void }, v: V, done: string) => {
    setError(null);
    m.mutate(v, { onSuccess: () => toast.success(done), onError: setError });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label={t('subcontracts.boq.revision')} value={selected} onChange={(e) => setSelected(e.target.value)} className="w-80">
          {detail.revisions.map((r) => (
            <option key={r.id} value={r.id}>
              {t('subcontracts.boq.revLabel', { rev: r.revisionNo, status: t(`subcontracts.boq.revStatus.${r.status}`), total: money(r.total) })}
              {r.variationCode ? ` (${r.variationCode})` : ''}
            </option>
          ))}
        </Select>
        {revision?.status === 'approved' && <Badge tone="brand">{t('subcontracts.boq.current')}</Badge>}
        {revision?.approvedAt && <span className="text-xs text-muted">{t('subcontracts.boq.approvedAt', { date: formatDateTR(revision.approvedAt.slice(0, 10)) })}</span>}
        {selectedRow?.variationId && (
          <Link className="text-sm underline" to={`/variation-orders/${selectedRow.variationId}`}>
            {t('variations.openLinked', { code: selectedRow.variationCode })}
          </Link>
        )}
      </div>

      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {revision?.status === 'draft' && sc.status === 'draft' && <Callout tone="info">{t('subcontracts.boq.firstDraftHint')}</Callout>}
      {revision?.status === 'draft' && selectedRow?.variationId && <Callout tone="info">{t('variations.draftInVariation', { code: selectedRow.variationCode })}</Callout>}
      {sc.status === 'active' && revision?.status !== 'draft' && <p className="text-sm text-muted">{t('variations.boqHint')}</p>}

      {isPending || !data ? (
        <PageLoading />
      ) : (
        <BoqEditor
          data={data}
          projectId={sc.projectId}
          currencyCode={sc.currencyCode}
          editable={editable}
          title={t('subcontracts.boq.title')}
          description={t('subcontracts.boq.desc')}
          footer={({ body, valid }) =>
            editable && (
              <div className="flex flex-wrap justify-end gap-2 border-t border-border p-4">
                <Button variant="danger" loading={remove.isPending} onClick={() => run(remove, undefined, t('subcontracts.boq.deleted'))}>
                  {t('subcontracts.boq.deleteDraft')}
                </Button>
                <Button loading={save.isPending} disabled={!valid} onClick={() => run(save, body, t('subcontracts.boq.saved'))}>
                  {t('subcontracts.boq.save')}
                </Button>
                {can('subcontracts.approve') && (
                  <Button variant="primary" loading={approve.isPending} disabled={!valid} onClick={() => run(approve, body, t('subcontracts.boq.approved'))}>
                    {sc.status === 'draft' ? t('subcontracts.boq.approveActivate') : t('subcontracts.boq.approve')}
                  </Button>
                )}
              </div>
            )
          }
        />
      )}
    </div>
  );
}
