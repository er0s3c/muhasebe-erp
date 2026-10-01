import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PROJECT_TRANSITIONS } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Modal } from '../../components/ui/Sheet';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import type { ProjectDetail, ProjectStatus } from '../../lib/types';
import { BudgetTab } from './BudgetTab';
import { PROJECT_INVALIDATE, ProjectKindBadge, ProjectStatusBadge } from './common';
import { OverviewTab } from './OverviewTab';
import { ProjectFormSheet } from './ProjectFormSheet';
import { EmployerTab } from './EmployerTab';
import { TransactionsTab } from './TransactionsTab';
import { WbsTab } from './WbsTab';

type Tab = 'overview' | 'wbs' | 'budget' | 'transactions' | 'employer';

/** Durum geçişi düğmesinin biçimi: hedef duruma göre etiket (yeniden açma ve iptal ayrı anlatılır). */
type TransitionLabel = 'start' | 'reopen' | 'restore' | 'hold' | 'complete' | 'cancel';
const transitionLabel = (from: ProjectStatus, to: ProjectStatus): TransitionLabel =>
  to === 'active' ? (from === 'planned' ? 'start' : 'reopen') : to === 'planned' ? 'restore' : to === 'on_hold' ? 'hold' : to === 'completed' ? 'complete' : 'cancel';

export function ProjectDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const canManage = useCan()('projects.manage');
  const canReadContracts = useCan()('subcontracts.read');
  const subcontractsOn = useModuleEnabled('construction.subcontracts');
  const { data, isPending, error } = useCQuery<{ project: ProjectDetail }>(['project', id], id ? `/api/projects/${id}` : null);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState<ProjectStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const setStatus = useCMutation((status: ProjectStatus, call) => call(`/api/projects/${id}/status`, { method: 'POST', body: { status } }), PROJECT_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/projects/${id}`, { method: 'DELETE' }), PROJECT_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={t('projects.notFound')}
        action={
          <Button onClick={() => navigate('/projects')}>
            <ArrowLeft className="size-4" aria-hidden />
            {t('projects.back')}
          </Button>
        }
      />
    );
  }
  if (isPending || !data) return <PageLoading />;
  if (!id) return null;

  const p = data.project;
  const transitions = PROJECT_TRANSITIONS[p.status as ProjectStatus] ?? [];
  const canDelete = canManage && !p.hasPostings && p.wbsCount === 0 && p.budgetCount === 0;
  const doStatus = (s: ProjectStatus) =>
    setStatus.mutate(s, {
      onSuccess: () => {
        toast.success(t('projects.statusChanged', { status: t(`projects.status.${s}`) }));
        setConfirmStatus(null);
      },
      onError: (e) => {
        toast.error(errorMessage(e));
        setConfirmStatus(null);
      },
    });

  return (
    <>
      <Link to="/projects" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden />
        {t('projects.back')}
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-heading">{p.name}</h1>
            <ProjectKindBadge kind={p.kind} />
            <ProjectStatusBadge status={p.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono">{p.code}</span>
            {p.clientName ? (
              <>
                {' · '}
                {t('projects.client')}:{' '}
                {p.clientPartyId ? (
                  <Link className="link" to={`/parties/${p.clientPartyId}`}>
                    {p.clientName}
                  </Link>
                ) : (
                  p.clientName
                )}
              </>
            ) : null}
            {p.location ? ` · ${p.location}` : ''}
            {p.startDate || p.endDate ? ` · ${p.startDate ? formatDateTR(p.startDate) : '…'} – ${p.endDate ? formatDateTR(p.endDate) : '…'}` : ''}
          </p>
          {p.description && <p className="mt-2 max-w-3xl text-sm text-muted">{p.description}</p>}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {transitions.map((s) => {
              const label = transitionLabel(p.status as ProjectStatus, s);
              return (
                <Button
                  key={s}
                  variant={s === 'cancelled' ? 'danger' : s === 'active' || s === 'completed' ? 'primary' : 'secondary'}
                  loading={setStatus.isPending && setStatus.variables === s}
                  onClick={() => (s === 'cancelled' || s === 'completed' ? setConfirmStatus(s) : doStatus(s))}
                >
                  {t(`projects.transitions.${label}`)}
                </Button>
              );
            })}
            <Button onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
              {t('common.edit')}
            </Button>
            {canDelete && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)} aria-label={t('projects.delete')}>
                <Trash2 className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        )}
      </div>

      {p.status === 'completed' && <div className="mb-5"><Callout tone="info">{t('projects.completedNote')}</Callout></div>}
      {p.status === 'cancelled' && <div className="mb-5"><Callout tone="warning">{t('projects.cancelledNote')}</Callout></div>}

      <SegmentedTabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'overview', label: t('projects.tabs.overview') },
          { key: 'wbs', label: t('projects.tabs.wbs') },
          { key: 'budget', label: t('projects.tabs.budget') },
          { key: 'transactions', label: t('projects.tabs.transactions') },
          ...(p.kind === 'contract' && subcontractsOn && canReadContracts ? [{ key: 'employer' as const, label: t('projects.tabs.employer') }] : []),
        ]}
      />

      {tab === 'overview' && <OverviewTab project={p} onOpenBudget={() => setTab('budget')} onOpenWbs={() => setTab('wbs')} />}
      {tab === 'wbs' && <WbsTab project={p} />}
      {tab === 'budget' && <BudgetTab project={p} />}
      {tab === 'transactions' && <TransactionsTab project={p} />}
      {tab === 'employer' && <EmployerTab project={p} />}

      <ProjectFormSheet open={editing} onOpenChange={setEditing} project={p} onSaved={() => undefined} />

      <Modal
        open={confirmStatus !== null}
        onOpenChange={(o) => !o && setConfirmStatus(null)}
        title={confirmStatus === 'cancelled' ? t('projects.confirm.cancelTitle') : t('projects.confirm.completeTitle')}
        description={confirmStatus === 'cancelled' ? t('projects.confirm.cancelBody') : t('projects.confirm.completeBody')}
        footer={
          <>
            <Button onClick={() => setConfirmStatus(null)}>{t('common.cancel')}</Button>
            <Button variant={confirmStatus === 'cancelled' ? 'danger' : 'primary'} loading={setStatus.isPending} onClick={() => confirmStatus && doStatus(confirmStatus)}>
              {confirmStatus === 'cancelled' ? t('projects.transitions.cancel') : t('projects.transitions.complete')}
            </Button>
          </>
        }
      >
        <span />
      </Modal>

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('projects.confirm.deleteTitle')}
        description={t('projects.confirm.deleteBody')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('common.deleted'));
                    navigate('/projects');
                  },
                  onError: (e) => {
                    toast.error(errorMessage(e));
                    setConfirmDelete(false);
                  },
                })
              }
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <span />
      </Modal>
    </>
  );
}
