import { errorMessage } from '../../lib/errors';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Stat } from '../../components/ui/Stat';
import { moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { EmployerSummary, ProjectDetail } from '../../lib/types';
import { SubcontractFormSheet } from '../subcontracts/SubcontractFormSheet';
import { ProgressList } from '../subcontracts/ProgressList';

/** İşverene yapılan iş projesinde işveren sözleşmesi özeti: sözleşme, kümülatif hakediş, tahsilat ve kalan alacak. */
export function EmployerTab({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useCan()('subcontracts.manage');
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ summary: EmployerSummary | null }>(['project', project.id, 'employer'], `/api/projects/${project.id}/employer-contract`);
  const [creating, setCreating] = useState(false);
  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (isPending) return <PageLoading />;
  const s = data?.summary;
  if (!s) {
    return (
      <>
        <Card>
          <EmptyState
            title={t('subcontracts.employer.noContract')}
            description={t('subcontracts.employer.noContractDesc')}
            action={canManage ? <Button variant="primary" onClick={() => setCreating(true)}>{t('subcontracts.employer.add')}</Button> : undefined}
          />
        </Card>
        <SubcontractFormSheet direction="receivable" open={creating} onOpenChange={setCreating} defaultProjectId={project.id} onSaved={(id) => navigate(`/subcontracts/${id}`)} />
      </>
    );
  }
  const cur = s.currencyCode;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          <Link className="underline" to={`/subcontracts/${s.subcontractId}`}>{s.code}</Link> — {s.title}
        </p>
        {canManage && s.status === 'active' && (
          <Button variant="primary" onClick={() => navigate(`/progress-payments/new?subcontractId=${s.subcontractId}`)}>{t('subcontracts.employer.newClaim')}</Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('subcontracts.employer.kpi.contract')} sub={t('subcontracts.employer.kpi.contractSub', { n: s.claimCount })}>{moneyIn(s.contractAmount, cur)}</Stat>
        <Stat label={t('subcontracts.employer.kpi.cumulative')} sub={t('subcontracts.employer.kpi.cumulativeSub', { prev: moneyIn(s.previousGross, cur), cur: moneyIn(s.thisPeriodGross, cur) })}>{moneyIn(s.cumulativeGross, cur)}</Stat>
        <Stat label={t('subcontracts.employer.kpi.outstanding')} sub={t('subcontracts.employer.kpi.outstandingSub', { billed: moneyIn(s.billedNet, cur), collected: moneyIn(s.collected, cur) })}>{moneyIn(s.outstanding, cur)}</Stat>
        <Stat label={t('subcontracts.employer.kpi.remaining')} sub={t('subcontracts.employer.kpi.remainingSub', { retention: moneyIn(s.retentionBalance, cur) })}>{moneyIn(s.remainingContract, cur)}</Stat>
      </div>
      <Card>
        <CardHeader title={t('subcontracts.employer.claimsTitle')} />
        <div className="p-4">
          <ProgressList subcontractId={s.subcontractId} />
        </div>
      </Card>
    </div>
  );
}
