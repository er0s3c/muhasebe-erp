import { BookOpen, Pencil, Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, isZero, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { JournalEntry, JournalListItem } from '../../lib/types';
import { JournalForm } from './JournalForm';

type StatusFilter = '' | 'draft' | 'posted';

function StatusBadge({ e }: { e: Pick<JournalListItem, 'status' | 'reversedById' | 'reversalOfId'> }) {
  const { t } = useTranslation();
  if (e.status === 'draft') return <Badge tone="warning">{t('ledger.journal.draft')}</Badge>;
  if (e.reversalOfId) return <Badge tone="neutral">{t('ledger.journal.reversal')}</Badge>;
  if (e.reversedById) return <Badge tone="danger">{t('ledger.journal.reversed')}</Badge>;
  return <Badge tone="success">{t('ledger.journal.posted')}</Badge>;
}

export function JournalPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [status, setStatus] = useState<StatusFilter>('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<JournalEntry | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const query = new URLSearchParams({ from, to, limit: '100', ...(status ? { status } : {}) });
  const { data, isPending } = useCQuery<{ entries: JournalListItem[] }>(['journal', from, to, status], `/api/journal-entries?${query}`);
  const canPost = can('ledger.post');

  // Komut paletinden (?new=1) gelindiyse formu aç
  useEffect(() => {
    if (params.get('new') === '1' && canPost) {
      setEditing(null);
      setFormOpen(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams, canPost]);

  return (
    <>
      <PageHeader
        title={t('ledger.journal.title')}
        description={t('ledger.journal.subtitle')}
        actions={
          canPost && (
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              {t('ledger.journal.new')}
            </Button>
          )
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.status')}>
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="w-40">
              <option value="">{t('ledger.journal.all')}</option>
              <option value="draft">{t('ledger.journal.draft')}</option>
              <option value="posted">{t('ledger.journal.posted')}</option>
            </Select>
          )}
        </Field>
      </div>

      {isPending ? (
        <PageLoading />
      ) : !data?.entries.length ? (
        <Card>
          <EmptyState
            icon={<BookOpen className="size-5" />}
            title={t('ledger.journal.noEntries')}
            description={t('ledger.journal.noEntriesDesc')}
            action={
              canPost && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  <Plus className="size-4" aria-hidden />
                  {t('ledger.journal.new')}
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-28">{t('common.date')}</Th>
                <Th className="w-40">{t('ledger.journal.entryNo')}</Th>
                <Th>{t('common.description')}</Th>
                <Th num>
                  {t('ledger.journal.total')} ({company.baseCurrency})
                </Th>
                <Th className="w-32">{t('common.status')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <Tr
                  key={e.id}
                  clickable
                  tabIndex={0}
                  onClick={() => setDetailId(e.id)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') setDetailId(e.id);
                  }}
                >
                  <Td>{formatDateTR(e.entryDate)}</Td>
                  <Td className="font-mono text-[13px]">{e.entryNo ?? '—'}</Td>
                  <Td className="max-w-md truncate">{e.description}</Td>
                  <Td num>{isZero(e.totalBase) ? '—' : money(e.totalBase)}</Td>
                  <Td>
                    <StatusBadge e={e} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <JournalDetail
        id={detailId}
        onClose={() => setDetailId(null)}
        onEdit={(entry) => {
          setDetailId(null);
          setEditing(entry);
          setFormOpen(true);
        }}
        onOpenOther={setDetailId}
      />
      <JournalForm
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
        onSaved={(entry) => setDetailId(entry.id)}
      />
    </>
  );
}

function JournalDetail({
  id,
  onClose,
  onEdit,
  onOpenOther,
}: {
  id: string | null;
  onClose: () => void;
  onEdit: (e: JournalEntry) => void;
  onOpenOther: (id: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const company = useCompany();
  const canPost = useCan()('ledger.post');
  const { data, isPending } = useCQuery<{ entry: JournalEntry }>(['journal-entry', id], id ? `/api/journal-entries/${id}` : null);
  const entry = data?.entry;
  const [reversing, setReversing] = useState(false);
  const [revDate, setRevDate] = useState(todayIso());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setActionError(null);
    setRevDate(todayIso());
  }, [id]);

  const inval = [['journal'], ['journal-entry'], ['dashboard'], ['trial-balance'], ['account-ledger'], ['parties'], ['party'], ['party-aging']];
  const post = useCMutation((_: void, call) => call<{ entry: JournalEntry }>(`/api/journal-entries/${id}/post`, { method: 'POST' }), inval);
  const remove = useCMutation((_: void, call) => call(`/api/journal-entries/${id}`, { method: 'DELETE' }), inval);
  const reverse = useCMutation(
    (v: { entryDate: string }, call) => call<{ entry: JournalEntry }>(`/api/journal-entries/${id}/reverse`, { method: 'POST', body: v }),
    inval,
  );

  const showForeign = entry?.lines.some((l) => l.currencyCode !== company.baseCurrency) ?? false;

  return (
    <>
      <Sheet
        wide
        open={id !== null}
        onOpenChange={(o) => !o && onClose()}
        title={entry?.entryNo ?? t('ledger.journal.detail')}
        description={entry ? `${formatDateTR(entry.entryDate)} · ${entry.description}` : undefined}
        footer={
          entry && canPost ? (
            entry.status === 'draft' ? (
              <>
                <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="size-4 text-danger" aria-hidden />
                  {t('ledger.journal.deleteDraft')}
                </Button>
                <Button onClick={() => onEdit(entry)}>
                  <Pencil className="size-4" aria-hidden />
                  {t('common.edit')}
                </Button>
                <Button
                  variant="primary"
                  loading={post.isPending}
                  onClick={() =>
                    post.mutate(undefined, {
                      onSuccess: (r) => toast.success(t('ledger.journal.postedMsg', { no: r.entry.entryNo ?? '' })),
                      onError: (e) => setActionError(errorMessage(e)),
                    })
                  }
                >
                  <Send className="size-4" aria-hidden />
                  {t('ledger.journal.postNow')}
                </Button>
              </>
            ) : !entry.reversedById && !entry.reversalOfId ? (
              <Button onClick={() => setReversing(true)}>
                <RotateCcw className="size-4" aria-hidden />
                {t('ledger.journal.reverse')}
              </Button>
            ) : undefined
          ) : undefined
        }
      >
        {isPending || !entry ? (
          <PageLoading />
        ) : (
          <div className="flex flex-col gap-5">
            {actionError && <Callout tone="danger">{actionError}</Callout>}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge e={entry} />
              <span className="text-muted">
                {entry.periodYear}-{String(entry.periodMonth).padStart(2, '0')}
              </span>
              {entry.reversedById && (
                <button className="link" onClick={() => onOpenOther(entry.reversedById!)}>
                  {t('ledger.journal.reversedBy')} →
                </button>
              )}
              {entry.reversalOfId && (
                <button className="link" onClick={() => onOpenOther(entry.reversalOfId!)}>
                  ← {t('ledger.journal.reversalOf')}
                </button>
              )}
            </div>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('ledger.journal.account')}</Th>
                    <Th>{t('common.description')}</Th>
                    {showForeign && <Th num>{t('ledger.accountLedger.fx')}</Th>}
                    {showForeign && <Th num>{t('ledger.journal.fxRate')}</Th>}
                    <Th num>{t('common.debit')}</Th>
                    <Th num>{t('common.credit')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((l) => (
                    <Tr key={l.id}>
                      <Td>
                        <span className="font-mono text-[13px]">{l.accountCode}</span>
                        <span className="ml-2 text-muted">{l.accountName}</span>
                        {l.partyId && (
                          <span className="mt-0.5 block text-xs">
                            <Link to={`/parties/${l.partyId}`} className="link">
                              {l.partyName}
                            </Link>
                            {l.dueDate && <span className="ml-2 text-muted">{t('parties.detail.dueDate')}: {formatDateTR(l.dueDate)}</span>}
                          </span>
                        )}
                      </Td>
                      <Td className="text-muted">{l.description}</Td>
                      {showForeign && (
                        <Td num>
                          {l.currencyCode !== company.baseCurrency ? `${money(Number(l.debit) > 0 ? l.debit : l.credit)} ${l.currencyCode}` : ''}
                        </Td>
                      )}
                      {showForeign && <Td num>{l.currencyCode !== company.baseCurrency ? money(l.fxRate, 4) : ''}</Td>}
                      <Td num>{isZero(l.debitBase) ? '' : money(l.debitBase)}</Td>
                      <Td num>{isZero(l.creditBase) ? '' : money(l.creditBase)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </div>
        )}
      </Sheet>

      <Modal
        open={reversing}
        onOpenChange={setReversing}
        title={t('ledger.journal.reverseTitle')}
        description={t('ledger.journal.reverseDesc')}
        footer={
          <>
            <Button onClick={() => setReversing(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={reverse.isPending}
              onClick={() =>
                reverse.mutate(
                  { entryDate: revDate },
                  {
                    onSuccess: (r) => {
                      toast.success(t('ledger.journal.reversedMsg', { no: r.entry.entryNo ?? '' }));
                      setReversing(false);
                      onOpenOther(r.entry.id);
                    },
                    onError: (e) => {
                      setReversing(false);
                      setActionError(errorMessage(e));
                    },
                  },
                )
              }
            >
              {t('ledger.journal.reverse')}
            </Button>
          </>
        }
      >
        <Field label={t('ledger.journal.reverseDate')}>
          {(fid) => <Input id={fid} type="date" value={revDate} onChange={(e) => setRevDate(e.target.value)} />}
        </Field>
      </Modal>

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('ledger.journal.deleteDraft')}
        description={t('common.confirmDelete')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('ledger.journal.draftDeleted'));
                    setConfirmDelete(false);
                    onClose();
                  },
                  onError: (e) => {
                    setConfirmDelete(false);
                    setActionError(errorMessage(e));
                  },
                })
              }
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  );
}
