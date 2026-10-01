import { FileDiff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { useCQuery } from '../../lib/queries';
import type { VariationRow } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { VARIATION_STATUSES } from './common';
import { VariationTable } from './VariationsTab';

/** Değişiklik emirleri kayıt defteri: taşeron ve işveren sözleşmelerinin tümü. DE, sözleşme sayfasından açılır. */
export function VariationsPage() {
  const { t } = useTranslation();
  const { projects } = useProjectOptions();
  const [projectId, setProjectId] = useState('');
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const params = useMemo(() => ({ projectId, direction, status }), [projectId, direction, status]);
  const qs = useMemo(() => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return q.toString();
  }, [params]);
  const { data, isPending } = useCQuery<{ variations: VariationRow[] }>(['variations', 'list', qs], `/api/variation-orders?${qs}`);
  const rows = data?.variations ?? [];
  const filtered = !!(projectId || direction || status);

  return (
    <>
      <PageHeader
        title={t('variations.listTitle')}
        description={t('variations.listSubtitle')}
        actions={<ExportMenu exportKey="variation-orders" params={params} print={false} disabled={rows.length === 0} />}
      />
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !filtered ? (
        <Card>
          <EmptyState icon={<FileDiff className="size-5" />} title={t('variations.empty')} description={t('variations.listEmptyDesc')} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select aria-label={t('subcontracts.filters.project')} value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-64">
              <option value="">{t('subcontracts.filters.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </Select>
            <Select aria-label={t('variations.filters.direction')} value={direction} onChange={(e) => setDirection(e.target.value)} className="w-48">
              <option value="">{t('variations.filters.allDirections')}</option>
              <option value="payable">{t('variations.direction.payable')}</option>
              <option value="receivable">{t('variations.direction.receivable')}</option>
            </Select>
            <Select aria-label={t('subcontracts.filters.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-56">
              <option value="">{t('subcontracts.filters.allStatuses')}</option>
              {VARIATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`variations.status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          {rows.length === 0 ? (
            <Card>
              <EmptyState title={t('common.noResults')} />
            </Card>
          ) : (
            <VariationTable rows={rows} showContract />
          )}
        </div>
      )}
    </>
  );
}
