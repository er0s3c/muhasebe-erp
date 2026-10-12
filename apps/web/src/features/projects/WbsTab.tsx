import { FolderPlus, Gauge, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { ProjectDetail, ProjectProgressOverview, ProjectWbsRow } from '../../lib/types';
import { PROJECT_INVALIDATE } from './common';

type SheetState = { mode: 'add'; parent: ProjectWbsRow | null } | { mode: 'edit'; row: ProjectWbsRow } | null;

/** İş kırılımı sekmesi: ağaç düzenleme (alt iş ekle, düzenle/taşı, pasifleştir, sil) ve ilerleme girişi. */
export function WbsTab({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('projects.manage') && project.status !== 'cancelled';
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ wbs: ProjectWbsRow[] }>(['project', project.id, 'wbs'], `/api/projects/${project.id}/wbs`);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [deleting, setDeleting] = useState<ProjectWbsRow | null>(null);

  const toggle = useCMutation((v: { id: string; isActive: boolean }, call) => call(`/api/project-wbs/${v.id}`, { method: 'PATCH', body: { isActive: v.isActive } }), PROJECT_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/project-wbs/${id}`, { method: 'DELETE' }), PROJECT_INVALIDATE);

  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (isPending || !data) return <PageLoading />;
  const rows = data.wbs;
  const leaves = rows.filter((r) => r.isLeaf && r.isActive);

  const addRoot = canManage && (
    <Button variant="primary" onClick={() => setSheet({ mode: 'add', parent: null })}>
      <FolderPlus className="size-4" aria-hidden />
      {t('projects.wbs.addRoot')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title={t('projects.wbs.title')}
          description={t('projects.wbs.desc')}
          action={
            canManage && (
              <div className="flex flex-wrap items-center gap-2">
                {leaves.length > 0 && (
                  <Button onClick={() => setProgressOpen(true)}>
                    <Gauge className="size-4" aria-hidden />
                    {t('projects.wbs.enterProgress')}
                  </Button>
                )}
                {addRoot}
              </div>
            )
          }
        />
        {rows.length === 0 ? (
          <EmptyState title={t('projects.wbs.empty')} description={t('projects.wbs.emptyDesc')} action={addRoot || undefined} />
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>{t('projects.cols.wbs')}</Th>
                  <Th className="w-56">{canManage ? t('common.actions') : ''}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id} className={r.isActive ? undefined : 'opacity-60'}>
                    <Td>
                      <span className="flex flex-wrap items-baseline gap-2" style={{ paddingLeft: `${(r.depth - 1) * 1.25}rem` }}>
                        <span className="font-mono text-[13px] text-muted">{r.code}</span>
                        <span>{r.name}</span>
                        {!r.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
                        {r.hasPostings && <Badge>{t('projects.wbs.hasRecords')}</Badge>}
                      </span>
                    </Td>
                    <Td>
                      {canManage && (
                        <div className="flex items-center gap-1">
                          {r.isActive && !r.hasPostings && r.depth < 6 && (
                            <Button size="sm" variant="ghost" aria-label={`${t('projects.wbs.addChild')}: ${r.code}`} onClick={() => setSheet({ mode: 'add', parent: r })}>
                              <Plus className="size-4" aria-hidden />
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" aria-label={`${t('common.edit')}: ${r.code}`} onClick={() => setSheet({ mode: 'edit', row: r })}>
                            <Pencil className="size-4" aria-hidden />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`${r.isActive ? t('projects.wbs.deactivate') : t('projects.wbs.activate')}: ${r.code}`}
                            onClick={() =>
                              toggle.mutate(
                                { id: r.id, isActive: !r.isActive },
                                { onError: (e) => toast.error(errorMessage(e)) },
                              )
                            }
                          >
                            <Power className="size-4" aria-hidden />
                          </Button>
                          {r.isLeaf && !r.hasPostings && (
                            <Button size="sm" variant="ghost" aria-label={`${t('common.delete')}: ${r.code}`} onClick={() => setDeleting(r)}>
                              <Trash2 className="size-4" aria-hidden />
                            </Button>
                          )}
                        </div>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {rows.some((r) => r.hasPostings) && <Callout tone="info">{t('projects.wbs.leafNote')}</Callout>}

      <WbsSheet projectId={project.id} state={sheet} rows={rows} onClose={() => setSheet(null)} />
      <ProgressSheet open={progressOpen} onOpenChange={setProgressOpen} projectId={project.id} leaves={leaves} />

      <Modal
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('projects.wbs.deleteTitle')}
        description={deleting ? t('projects.wbs.deleteBody', { code: deleting.code, name: deleting.name }) : undefined}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onSuccess: () => {
                    toast.success(t('common.deleted'));
                    setDeleting(null);
                  },
                  onError: (e) => {
                    toast.error(errorMessage(e));
                    setDeleting(null);
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

function descendantsOf(rows: readonly ProjectWbsRow[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId && out.has(r.parentId) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}

const ROOT = '';

function WbsSheet({ projectId, state, rows, onClose }: { projectId: string; state: SheetState; rows: ProjectWbsRow[]; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const open = state !== null;
  const editing = state?.mode === 'edit' ? state.row : null;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState(ROOT);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!state) return;
    if (state.mode === 'edit') {
      setCode(state.row.code);
      setName(state.row.name);
      setParentId(state.row.parentId ?? ROOT);
    } else {
      setCode('');
      setName('');
      setParentId(state.parent?.id ?? ROOT);
    }
    setError(null);
  }, [state]);

  // Taşıma hedefi: kendisi ve altındakiler hariç, kaydı olmayan ve aktif düğümler
  const parentOptions = useMemo<ComboOption[]>(() => {
    if (!editing) return [];
    const banned = descendantsOf(rows, editing.id);
    return [
      { value: ROOT, label: t('projects.wbs.rootOption') },
      ...rows.filter((r) => !banned.has(r.id) && r.isActive && (!r.hasPostings || r.id === editing.parentId)).map((r) => ({ value: r.id, label: `${r.code} — ${r.name}`, keywords: r.code })),
    ];
  }, [rows, editing, t]);

  const save = useCMutation((_: void, call) => {
    if (editing) {
      return call(`/api/project-wbs/${editing.id}`, {
        method: 'PATCH',
        body: { code: code.trim(), name: name.trim(), ...(parentId !== (editing.parentId ?? ROOT) ? { parentId: parentId || null } : {}) },
      });
    }
    return call(`/api/projects/${projectId}/wbs`, { method: 'POST', body: { code: code.trim(), name: name.trim(), ...(parentId ? { parentId } : {}) } });
  }, PROJECT_INVALIDATE);

  const canSave = code.trim().length > 0 && name.trim().length > 0;
  const submit = () => {
    setError(null);
    save.mutate(undefined, {
      onSuccess: () => {
        toast.success(t('common.saved'));
        onClose();
      },
      onError: (e) => setError(e),
    });
  };
  const parentLabel = state?.mode === 'add' && state.parent ? `${state.parent.code} — ${state.parent.name}` : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={editing ? t('projects.wbs.editTitle') : parentLabel ? t('projects.wbs.addChildTitle') : t('projects.wbs.addRootTitle')}
      description={parentLabel ? t('projects.wbs.parentLabel', { parent: parentLabel }) : undefined}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) submit();
        }}
      >
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('projects.wbs.code')} required hint={t('projects.wbs.codeHint')}>
          {(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} maxLength={30} autoFocus />}
        </Field>
        <Field label={t('projects.wbs.name')} required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />}
        </Field>
        {editing && (
          <Field label={t('projects.wbs.parent')} hint={t('projects.wbs.parentHint')}>
            {(id) => <Combobox id={id} options={parentOptions} value={parentId} onChange={setParentId} />}
          </Field>
        )}
      </form>
    </Sheet>
  );
}

/** Tarihli ilerleme girişi: yaprak başına tamamlanma yüzdesi ve isteğe bağlı elle "tamamlanmaya kalan maliyet". */
function ProgressSheet({ open, onOpenChange, projectId, leaves }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; leaves: ProjectWbsRow[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [percent, setPercent] = useState<Record<string, string>>({});
  const [etc, setEtc] = useState<Record<string, string>>({});
  const [error, setError] = useState<Error | null>(null);
  const { data, error: progressError, isPending: progressPending, refetch: retryProgress, isFetching: retryingProgress } = useCQuery<ProjectProgressOverview>(['project', projectId, 'progress', asOfDate], `/api/projects/${projectId}/progress?asOf=${asOfDate}`, { enabled: open });
  const latest = useMemo(() => new Map((data?.latest ?? []).map((l) => [l.wbsId, l])), [data]);

  useEffect(() => {
    if (!open) return;
    setAsOfDate(todayIso());
    setPercent({});
    setEtc({});
    setError(null);
  }, [open]);

  const save = useCMutation(
    (items: { wbsId: string; percent: string; etcOverride?: string }[], call) => call(`/api/projects/${projectId}/progress`, { method: 'POST', body: { asOfDate, items } }),
    PROJECT_INVALIDATE,
  );

  const items = leaves.filter((l) => percent[l.id] !== undefined && percent[l.id] !== '').map((l) => ({ wbsId: l.id, percent: percent[l.id]!, ...(etc[l.id] ? { etcOverride: etc[l.id] } : {}) }));
  const invalid = items.some((i) => Number(i.percent) > 100);
  const submit = () => {
    if (save.isPending || progressPending || progressError) return;
    setError(null);
    save.mutate(items, {
      onSuccess: () => {
        toast.success(t('projects.progress.saved'));
        onOpenChange(false);
      },
      onError: (e) => setError(e),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={t('projects.progress.title')}
      description={t('projects.progress.desc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={items.length === 0 || invalid || progressPending || !!progressError} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('projects.progress.date')}>{(id) => <Input id={id} type="date" value={asOfDate} onChange={(e) => e.target.value && setAsOfDate(e.target.value)} className="w-44" />}</Field>
        {progressError ? <ErrorState description={errorMessage(progressError)} onRetry={() => void retryProgress()} retrying={retryingProgress} /> : progressPending ? <PageLoading /> : <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('projects.cols.wbs')}</Th>
                <Th num className="w-28">
                  {t('projects.progress.current')}
                </Th>
                <Th num className="w-32">
                  {t('projects.progress.newPercent')}
                </Th>
                <Th num className="w-40">
                  {t('projects.progress.etc')}
                </Th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((l) => {
                const cur = latest.get(l.id);
                return (
                  <Tr key={l.id}>
                    <Td>
                      <span className="font-mono text-[13px] text-muted">{l.code}</span> {l.name}
                    </Td>
                    <Td num className="text-muted">
                      {cur ? `%${money(cur.percent, 1)}` : '—'}
                    </Td>
                    <Td num>
                      <MoneyInput aria-label={`${t('projects.progress.newPercent')} ${l.code}`} value={percent[l.id] ?? ''} onChange={(v) => setPercent((s) => ({ ...s, [l.id]: v }))} maxDecimals={2} />
                    </Td>
                    <Td num>
                      <MoneyInput aria-label={`${t('projects.progress.etc')} ${l.code}`} value={etc[l.id] ?? ''} onChange={(v) => setEtc((s) => ({ ...s, [l.id]: v }))} />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>}
        {invalid && <Callout tone="danger">{t('projects.progress.over100')}</Callout>}

        {data && data.history.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm">{t('projects.progress.history')}</h3>
            <TableWrap>
              <Table>
                <tbody>
                  {data.history.slice(0, 8).map((h) => (
                    <Tr key={h.id}>
                      <Td className="w-28 text-muted">{formatDateTR(h.asOfDate)}</Td>
                      <Td>
                        <span className="font-mono text-[13px] text-muted">{h.wbsCode}</span> {h.wbsName}
                      </Td>
                      <Td num>%{money(h.percent, 1)}</Td>
                      <Td num className="text-muted">
                        {h.etcOverride ? `ETC ${money(h.etcOverride)}` : ''}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </div>
        )}
      </div>
    </Sheet>
  );
}
