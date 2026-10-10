import { CheckCircle2, FilePlus2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dec, sum } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ProjectBudgetDetail, ProjectBudgetRow, ProjectDetail, ProjectWbsRow } from '../../lib/types';
import { PROJECT_INVALIDATE } from './common';
import { fmtDate } from '../../lib/license';

const STATUS_TONE = { draft: 'warning', approved: 'success', superseded: 'neutral' } as const;

/** Bütçe sekmesi: revizyon listesi, taslak düzenleme, onay ve yürürlükteki revizyona göre fark. */
export function BudgetTab({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const base = useCompany().baseCurrency;
  const canBudget = useCan()('projects.budget') && project.status !== 'cancelled';
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ budgets: ProjectBudgetRow[] }>(['project', project.id, 'budgets'], `/api/projects/${project.id}/budgets`);
  const { data: wbsData } = useCQuery<{ wbs: ProjectWbsRow[] }>(['project', project.id, 'wbs'], `/api/projects/${project.id}/wbs`);
  const [picked, setPicked] = useState<string | null>(null);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const budgets = data?.budgets ?? [];
  const draft = budgets.find((b) => b.status === 'draft');
  const current = budgets.find((b) => b.isCurrent);
  const selectedId = picked && budgets.some((b) => b.id === picked) ? picked : (draft ?? current ?? budgets[0])?.id ?? null;
  const selected = budgets.find((b) => b.id === selectedId) ?? null;

  const { data: detail, error: detailError, isPending: detailPending, refetch: retryDetail, isFetching: retryingDetail } = useCQuery<ProjectBudgetDetail>(['project', project.id, 'budget', selectedId], selectedId ? `/api/project-budgets/${selectedId}` : null);
  const { data: currentDetail } = useCQuery<ProjectBudgetDetail>(
    ['project', project.id, 'budget', current?.id],
    current ? `/api/project-budgets/${current.id}` : null,
    { enabled: !!current && !!selected && selected.id !== current.id },
  );

  const create = useCMutation((copy: boolean, call) => call<ProjectBudgetDetail>(`/api/projects/${project.id}/budgets`, { method: 'POST', body: { copyFromCurrent: copy } }), PROJECT_INVALIDATE);
  const approve = useCMutation((id: string, call) => call(`/api/project-budgets/${id}/approve`, { method: 'POST' }), PROJECT_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/project-budgets/${id}`, { method: 'DELETE' }), PROJECT_INVALIDATE);

  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (isPending) return <PageLoading />;

  const newButton = canBudget && !draft && (
    <Button
      variant="primary"
      loading={create.isPending}
      onClick={() =>
        create.mutate(!!current, {
          onSuccess: (r) => {
            setPicked(r.budget.id);
            toast.success(t('projects.budget.created', { rev: r.budget.revisionNo }));
          },
          onError: (e) => toast.error(errorMessage(e)),
        })
      }
    >
      <FilePlus2 className="size-4" aria-hidden />
      {current ? t('projects.budget.newRevision') : t('projects.budget.create')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title={t('projects.budget.title')} description={t('projects.budget.desc')} action={newButton || undefined} />
        {budgets.length === 0 ? (
          <EmptyState title={t('projects.budget.empty')} description={t('projects.budget.emptyDesc')} action={newButton || undefined} />
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th className="w-24">{t('projects.budget.rev')}</Th>
                  <Th>{t('projects.budget.titleCol')}</Th>
                  <Th className="w-32">{t('common.status')}</Th>
                  <Th className="w-36">{t('projects.budget.approvedAt')}</Th>
                  <Th num>{t('projects.budget.total', { currency: currencySymbol(base) })}</Th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((b) => (
                  <Tr
                    key={b.id}
                    clickable
                    tabIndex={0}
                    className={cn(b.id === selectedId && 'bg-surface-2')}
                    aria-selected={b.id === selectedId}
                    onClick={() => setPicked(b.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setPicked(b.id);
                    }}
                  >
                    <Td>Rev. {b.revisionNo}</Td>
                    <Td>
                      <span className="flex flex-wrap items-center gap-2">
                        {b.title ?? '—'}
                        {b.isCurrent && <Badge tone="brand">{t('projects.budget.current')}</Badge>}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[b.status]}>{t(`projects.budget.status.${b.status}`)}</Badge>
                    </Td>
                    <Td className="text-muted">{b.approvedAt ? fmtDate(b.approvedAt) : '—'}</Td>
                    <Td num>{money(b.total)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {selected && detailError && <ErrorState description={errorMessage(detailError)} onRetry={() => void retryDetail()} retrying={retryingDetail} />}
      {selected && !detailError && detailPending && <PageLoading />}
      {selected && !detailError && detail && (
        <Card>
          <CardHeader
            title={t('projects.budget.detailTitle', { rev: selected.revisionNo })}
            description={selected.status === 'draft' ? t('projects.budget.draftDesc') : selected.isCurrent ? t('projects.budget.currentDesc') : t('projects.budget.pastDesc')}
            action={
              selected.status === 'draft' &&
              canBudget && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="danger" onClick={() => setConfirmDelete(true)} aria-label={t('projects.budget.deleteDraft')}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                  <Button variant="primary" disabled={detail.lines.length === 0} onClick={() => setConfirmApprove(true)}>
                    <CheckCircle2 className="size-4" aria-hidden />
                    {t('projects.budget.approve')}
                  </Button>
                </div>
              )
            }
          />
          {selected.status === 'draft' && canBudget ? (
            <BudgetEditor detail={detail} wbs={wbsData?.wbs ?? []} />
          ) : (
            <BudgetReadOnly detail={detail} against={selected.isCurrent ? null : (currentDetail ?? null)} againstRev={current?.revisionNo} />
          )}
        </Card>
      )}

      <Modal
        open={confirmApprove}
        onOpenChange={setConfirmApprove}
        title={t('projects.budget.approveTitle')}
        description={t('projects.budget.approveBody')}
        footer={
          <>
            <Button onClick={() => setConfirmApprove(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={approve.isPending}
              onClick={() =>
                selectedId &&
                approve.mutate(selectedId, {
                  onSuccess: () => {
                    toast.success(t('projects.budget.approved'));
                    setConfirmApprove(false);
                  },
                  onError: (e) => {
                    toast.error(errorMessage(e));
                    setConfirmApprove(false);
                  },
                })
              }
            >
              {t('projects.budget.approve')}
            </Button>
          </>
        }
      >
        <span />
      </Modal>

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('projects.budget.deleteTitle')}
        description={t('projects.budget.deleteBody')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                selectedId &&
                remove.mutate(selectedId, {
                  onSuccess: () => {
                    setPicked(null);
                    toast.success(t('common.deleted'));
                    setConfirmDelete(false);
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
    </div>
  );
}

/** Taslak düzenleme: yaprak iş kalemi başına tutar; boş/0 satırlar kaydedilmez. */
function BudgetEditor({ detail, wbs }: { detail: ProjectBudgetDetail; wbs: ProjectWbsRow[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setAmounts(Object.fromEntries(detail.lines.map((l) => [l.wbsId, dec(l.amount).toFixed(2).replace(/\.00$/, '')])));
    setError(null);
  }, [detail]);

  const linked = useMemo(() => new Set(detail.lines.map((l) => l.wbsId)), [detail]);
  const leaves = wbs.filter((w) => w.isLeaf && (w.isActive || linked.has(w.id)));
  const total = sum(Object.values(amounts).map((v) => v || '0'));

  const save = useCMutation(
    (lines: { wbsId: string; amount: string }[], call) => call(`/api/project-budgets/${detail.budget.id}/lines`, { method: 'PUT', body: { lines } }),
    PROJECT_INVALIDATE,
  );
  const submit = () => {
    setError(null);
    const lines = leaves.filter((l) => amounts[l.id] && Number(amounts[l.id]) > 0).map((l) => ({ wbsId: l.id, amount: amounts[l.id]! }));
    save.mutate(lines, { onSuccess: () => toast.success(t('projects.budget.saved')), onError: (e) => setError(e) });
  };

  if (leaves.length === 0) return <EmptyState title={t('projects.budget.noLeaves')} description={t('projects.budget.noLeavesDesc')} />;
  return (
    <div className="flex flex-col gap-4 px-5 pb-5">
      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>{t('projects.cols.wbs')}</Th>
              <Th num className="w-56">
                {t('projects.cols.budget')}
              </Th>
            </tr>
          </thead>
          <tbody>
            {leaves.map((l) => (
              <Tr key={l.id} className={l.isActive ? undefined : 'opacity-60'}>
                <Td>
                  <span style={{ paddingLeft: `${(l.depth - 1) * 1.25}rem` }}>
                    <span className="font-mono text-[13px] text-muted">{l.code}</span> {l.name}
                  </span>
                </Td>
                <Td num>
                  <MoneyInput aria-label={`${t('projects.cols.budget')} ${l.code}`} value={amounts[l.id] ?? ''} onChange={(v) => setAmounts((s) => ({ ...s, [l.id]: v }))} />
                </Td>
              </Tr>
            ))}
            <Tr className="border-t border-text bg-surface-2">
              <Td>{t('common.total')}</Td>
              <Td num>{money(total.toFixed(2))}</Td>
            </Tr>
          </tbody>
        </Table>
      </TableWrap>
      <div className="flex justify-end">
        <Button variant="primary" loading={save.isPending} onClick={submit}>
          {t('projects.budget.saveDraft')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('projects.budget.editorHint')}</p>
    </div>
  );
}

/** Onaylı/devre dışı revizyon: satırlar ve (yürürlükteki değilse) yürürlükteki revizyona göre fark. */
function BudgetReadOnly({ detail, against, againstRev }: { detail: ProjectBudgetDetail; against: ProjectBudgetDetail | null; againstRev?: number }) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const cur = new Map((against?.lines ?? []).map((l) => [l.wbsId, l]));
    const mine = new Map(detail.lines.map((l) => [l.wbsId, l]));
    const ids = new Set([...mine.keys(), ...(against ? cur.keys() : [])]);
    return [...ids]
      .map((id) => {
        const a = mine.get(id);
        const b = cur.get(id);
        const line = (a ?? b)!;
        return { id, code: line.wbsCode, name: line.wbsName, amount: a?.amount ?? '0', diff: against ? dec(b?.amount ?? 0).minus(a?.amount ?? 0).toFixed(2) : null };
      })
      .sort((x, y) => x.code.localeCompare(y.code, 'tr', { numeric: true }));
  }, [detail, against]);

  if (rows.length === 0) return <EmptyState title={t('projects.budget.noLines')} />;
  return (
    <TableWrap className="rounded-none border-0">
      <Table>
        <thead>
          <tr>
            <Th>{t('projects.cols.wbs')}</Th>
            <Th num>{t('projects.cols.budget')}</Th>
            {against && (
              <Th num>{t('projects.budget.diffAgainst', { rev: againstRev })}</Th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td>
                <span className="font-mono text-[13px] text-muted">{r.code}</span> {r.name}
              </Td>
              <Td num>{money(r.amount)}</Td>
              {against && (
                <Td num className={cn(r.diff && Number(r.diff) !== 0 ? 'text-text' : 'text-muted')}>
                  {r.diff && Number(r.diff) > 0 ? '+' : ''}
                  {money(r.diff)}
                </Td>
              )}
            </Tr>
          ))}
          <Tr className="border-t border-text bg-surface-2">
            <Td>{t('common.total')}</Td>
            <Td num>{money(detail.budget.total)}</Td>
            {against && <Td num>{money(dec(against.budget.total).minus(detail.budget.total).toFixed(2))}</Td>}
          </Tr>
        </tbody>
      </Table>
    </TableWrap>
  );
}
