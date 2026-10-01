import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { SubcontractDetail } from '../../lib/types';
import { BalancesTab } from './BalancesTab';
import { BoqTab } from './BoqTab';
import { SUBCONTRACT_INVALIDATE, SubcontractStatusBadge } from './common';
import { ProgressList } from './ProgressList';
import { SubcontractFormSheet } from './SubcontractFormSheet';

type Tab = 'boq' | 'progress' | 'balances';

export function SubcontractDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const { data, isPending, error } = useCQuery<SubcontractDetail>(['subcontract', id], id ? `/api/subcontracts/${id}` : null);
  const [tab, setTab] = useState<Tab>('boq');
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'completed' | 'terminated' | 'delete' | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);

  const setStatus = useCMutation((status: 'completed' | 'terminated', call) => call(`/api/subcontracts/${id}/status`, { method: 'POST', body: { status } }), SUBCONTRACT_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/subcontracts/${id}`, { method: 'DELETE' }), SUBCONTRACT_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={t('subcontracts.notFound')}
        action={
          <Button onClick={() => navigate('/subcontracts')}>
            <ArrowLeft className="size-4" aria-hidden />
            {t('subcontracts.back')}
          </Button>
        }
      />
    );
  }
  if (isPending || !data) return <PageLoading />;
  const sc = data.subcontract;
  const canDelete = sc.status === 'draft' && can('subcontracts.manage');
  const done = () => setConfirm(null);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/subcontracts" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ArrowLeft className="size-4" aria-hidden />
          {t('subcontracts.back')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex flex-wrap items-center gap-3 text-2xl">
              <span className="font-mono text-[15px] text-muted">{sc.code}</span>
              {sc.title}
              <SubcontractStatusBadge status={sc.status} />
            </h1>
            <p className="mt-1 text-sm text-muted">
              {sc.partyName} · <Link className="underline" to={`/projects/${sc.projectId}`}>{sc.projectCode} {sc.projectName}</Link>
              {sc.startDate ? ` · ${formatDateTR(sc.startDate)}` : ''}
              {sc.endDate ? ` – ${formatDateTR(sc.endDate)}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {can('subcontracts.manage') && sc.status !== 'completed' && sc.status !== 'terminated' && (
              <Button onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden />
                {t('common.edit')}
              </Button>
            )}
            {can('subcontracts.approve') && sc.status === 'active' && (
              <>
                <Button onClick={() => setConfirm('completed')}>{t('subcontracts.actions.complete')}</Button>
                <Button variant="danger" onClick={() => setConfirm('terminated')}>{t('subcontracts.actions.terminate')}</Button>
              </>
            )}
            {canDelete && (
              <Button variant="danger" onClick={() => setConfirm('delete')}>
                <Trash2 className="size-4" aria-hidden />
                {t('common.delete')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {actionError && <Callout tone="danger">{errorMessage(actionError)}</Callout>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('subcontracts.kpi.amount')} sub={t('subcontracts.kpi.amountSub')}>{moneyIn(sc.contractAmount, sc.currencyCode)}</Stat>
        <Stat label={t('subcontracts.kpi.retention')} sub={t('subcontracts.kpi.retentionSub')}>{`%${Number(sc.retentionPct)}`}</Stat>
        <Stat label={t('subcontracts.kpi.advance')} sub={t('subcontracts.kpi.advanceSub')}>{`%${Number(sc.advanceRecoupPct)}`}</Stat>
        <Stat label={t('subcontracts.kpi.terms')} sub={t('subcontracts.kpi.termsSub', { withholding: Number(sc.withholdingPct) })}>{t('subcontracts.kpi.days', { days: sc.paymentDays })}</Stat>
      </div>

      <SegmentedTabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'boq', label: t('subcontracts.tabs.boq') },
          { key: 'progress', label: t('subcontracts.tabs.progress') },
          { key: 'balances', label: t('subcontracts.tabs.balances') },
        ]}
      />
      {tab === 'boq' && <BoqTab detail={data} />}
      {tab === 'progress' && <ProgressList subcontractId={sc.id} canCreate={sc.status === 'active'} />}
      {tab === 'balances' && <BalancesTab detail={data} />}

      <SubcontractFormSheet open={editing} onOpenChange={setEditing} edit={sc} onSaved={() => undefined} />
      <Modal
        open={confirm !== null}
        onOpenChange={(o) => !o && done()}
        title={confirm ? t(`subcontracts.confirm.${confirm}.title`) : ''}
        description={confirm ? t(`subcontracts.confirm.${confirm}.body`) : undefined}
        footer={
          <>
            <Button onClick={done}>{t('common.cancel')}</Button>
            <Button
              variant={confirm === 'completed' ? 'primary' : 'danger'}
              loading={setStatus.isPending || remove.isPending}
              onClick={() => {
                setActionError(null);
                if (confirm === 'delete') remove.mutate(undefined, { onSuccess: () => { toast.success(t('subcontracts.deleted')); navigate('/subcontracts'); }, onError: (e) => { setActionError(e); done(); } });
                else if (confirm) setStatus.mutate(confirm, { onSuccess: done, onError: (e) => { setActionError(e); done(); } });
              }}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <span />
      </Modal>
    </div>
  );
}
