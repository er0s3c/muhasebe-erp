import { CheckCircle2, ChevronDown, ChevronRight, Link2Off, Plus, Trash2, Upload, Wand2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { dec, todayIso, type BankLine, type BankLineStatus, type MatchSuggestion, type ReconciliationData } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, isZero, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { TreasuryAccount } from '../../lib/types';
import { ImportWizard } from '../imports/ImportWizard';
import { TransactionSheet } from './TransactionSheet';

type Filter = BankLineStatus | 'all';

/** Banka hesabı için ekstre içe aktarma, eşleştirme ve mutabakat özeti. */
export function ReconciliationTab({ account }: { account: TreasuryAccount }) {
  const { t } = useTranslation();
  const toast = useToast();
  const canPost = useCan()('treasury.post');
  const cur = account.currencyCode;

  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [filter, setFilter] = useState<Filter>('open');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState<BankLine | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState<BankLine | null>(null);
  const [ignoreReason, setIgnoreReason] = useState('');
  const [undoing, setUndoing] = useState<{ id: string; name: string } | null>(null);

  const query = new URLSearchParams({ from, to });
  const { data, isPending, error } = useCQuery<ReconciliationData>(['treasury', 'reconciliation', account.id, from, to], `/api/treasury/accounts/${account.id}/reconciliation?${query}`, {
    enabled: Boolean(from && to),
  });

  const refresh = [['treasury']];
  const matchM = useCMutation((v: { lineId: string; journalLineId: string }, call) => call(`/api/bank-statement-lines/${v.lineId}/match`, { method: 'POST', body: { journalLineId: v.journalLineId } }), refresh);
  const unmatchM = useCMutation((lineId: string, call) => call(`/api/bank-statement-lines/${lineId}/unmatch`, { method: 'POST', body: {} }), refresh);
  const ignoreM = useCMutation((v: { lineId: string; reason: string }, call) => call(`/api/bank-statement-lines/${v.lineId}/ignore`, { method: 'POST', body: v.reason ? { reason: v.reason } : {} }), refresh);
  const restoreM = useCMutation((lineId: string, call) => call(`/api/bank-statement-lines/${lineId}/restore`, { method: 'POST', body: {} }), refresh);
  const autoM = useCMutation((_: void, call) => call<{ matched: number }>(`/api/treasury/accounts/${account.id}/reconciliation/auto-match`, { method: 'POST', body: { from, to } }), refresh);
  const undoM = useCMutation((id: string, call) => call(`/api/bank-statements/${id}`, { method: 'DELETE' }), refresh);

  const note = (sg: MatchSuggestion) => (sg.dayDiff === 0 ? t('treasury.recon.suggest.same') : t('treasury.recon.suggest.days', { count: sg.dayDiff }));
  const run = <T,>(p: Promise<T>, okMessage?: string) =>
    p.then(
      () => {
        if (okMessage) toast.success(okMessage);
      },
      (e: unknown) => toast.error(errorMessage(e)),
    );

  if (error) return <Callout tone="danger">{errorMessage(error)}</Callout>;
  if (isPending || !data) return <PageLoading />;

  const s = data.summary;
  const hasStatements = data.statements.length > 0;
  const exactCount = data.lines.filter((l) => l.status === 'open' && l.suggestions[0]?.confidence === 'exact').length;
  const visible = data.lines.filter((l) => filter === 'all' || l.status === filter);
  const counts = { open: s.openLines, matched: s.matchedLines, ignored: s.ignoredLines, all: data.lines.length };
  const differenceZero = s.difference !== null && isZero(s.difference);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <h2 className="text-[15px]">{t('treasury.recon.title')}</h2>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted">{t('treasury.recon.subtitle')}</p>
        </div>
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
        {canPost && (
          <>
            <Button
              disabled={exactCount === 0}
              loading={autoM.isPending}
              onClick={() =>
                autoM.mutate(undefined, {
                  onSuccess: (r) => toast.success(r.matched > 0 ? t('treasury.recon.autoMatched', { count: r.matched }) : t('treasury.recon.autoNone')),
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              <Wand2 className="size-4" aria-hidden />
              {t('treasury.recon.autoMatch')}
              {exactCount > 0 && ` (${exactCount})`}
            </Button>
            <Button variant="primary" onClick={() => setImporting(true)}>
              <Upload className="size-4" aria-hidden />
              {t('treasury.recon.import')}
            </Button>
          </>
        )}
        <ExportMenu exportKey="bank-reconciliation" params={{ accountId: account.id, from, to }} print={false} disabled={!hasStatements} />
      </div>

      {!hasStatements ? (
        <Card>
          <EmptyState
            title={t('treasury.recon.empty.title')}
            description={t('treasury.recon.empty.description')}
            action={
              canPost && (
                <Button variant="primary" onClick={() => setImporting(true)}>
                  <Upload className="size-4" aria-hidden />
                  {t('treasury.recon.import')}
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label={t('treasury.recon.stats.closing')} sub={s.statementClosingDate ? t('treasury.recon.stats.closingSub', { date: formatDateTR(s.statementClosingDate) }) : t('treasury.recon.stats.closingUnknown')}>
              {s.statementClosing === null ? '—' : moneyIn(s.statementClosing, cur)}
            </Stat>
            <Stat label={t('treasury.recon.stats.ledger')} sub={s.statementClosingDate ? t('treasury.recon.stats.closingSub', { date: formatDateTR(s.statementClosingDate) }) : undefined}>
              {moneyIn(s.ledgerBalance, cur)}
            </Stat>
            <Stat label={t('treasury.recon.stats.difference')} sub={differenceZero ? undefined : t('treasury.recon.stats.differenceSub')}>
              {s.difference === null ? (
                '—'
              ) : differenceZero ? (
                <span className="inline-flex items-center gap-2 text-success">
                  <CheckCircle2 className="size-5" aria-hidden />
                  {t('treasury.recon.stats.reconciled')}
                </span>
              ) : (
                <span className="text-danger">
                  {moneyIn(s.difference, cur)}
                </span>
              )}
            </Stat>
            <Stat label={t('treasury.recon.stats.openLines')} sub={moneyIn(s.openAmount, cur)}>
              {s.openLines}
            </Stat>
            <Stat label={t('treasury.recon.stats.unmatchedLedger')} sub={moneyIn(s.unmatchedLedgerAmount, cur)}>
              {s.unmatchedLedgerCount}
            </Stat>
          </div>

          <SegmentedTabs variant="filter"
            value={filter}
            onChange={setFilter}
            items={(['open', 'matched', 'ignored', 'all'] as const).map((k) => ({ key: k, label: `${t(`treasury.recon.filter.${k}`)} (${counts[k]})` }))}
          />

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('treasury.recon.cols.date')}</Th>
                  <Th>{t('treasury.recon.cols.description')}</Th>
                  <Th num>
                    {t('treasury.recon.cols.amount')} ({currencySymbol(cur)})
                  </Th>
                  <Th>{t('treasury.recon.cols.match')}</Th>
                  {canPost && <Th className="text-right">{t('treasury.recon.cols.actions')}</Th>}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <Td colSpan={canPost ? 5 : 4} className="py-8 text-center text-muted">
                      {t('treasury.recon.noLines')}
                    </Td>
                  </tr>
                )}
                {visible.map((l) => {
                  const best = l.suggestions[0];
                  const open = expanded === l.id;
                  return (
                    <Fragment key={l.id}>
                      <tr className="border-b border-border/70 last:border-b-0">
                        <Td className="align-top">{formatDateTR(l.txnDate)}</Td>
                        <Td className="align-top">
                          <span className="block">{l.description || '—'}</span>
                          {l.reference && <span className="block font-mono text-xs text-muted">{l.reference}</span>}
                        </Td>
                        <Td num className={dec(l.amount).gt(0) ? 'align-top text-success' : 'align-top'}>
                          {dec(l.amount).gt(0) ? '+' : ''}
                          {money(l.amount)}
                        </Td>
                        <Td className="align-top">
                          {l.status === 'matched' && l.match && (
                            <span className="block text-[13px]">
                              <Link to={`/accounting/journal?open=${l.match.entryId}`} className="link font-mono">
                                {t('treasury.recon.matchedTo', { no: l.match.entryNo })}
                              </Link>
                              {l.match.txnNo && <span className="ml-2 font-mono text-xs text-muted">{l.match.txnNo}</span>}
                              <span className="block truncate text-xs text-muted">{l.match.description}</span>
                            </span>
                          )}
                          {l.status === 'ignored' && <span className="text-[13px] text-muted">{l.ignoreReason ?? t('treasury.recon.filter.ignored')}</span>}
                          {l.status === 'open' &&
                            (best ? (
                              <span className="flex flex-wrap items-center gap-2 text-[13px]">
                                <Badge tone={best.confidence === 'exact' ? 'success' : 'warning'}>{t(`treasury.recon.suggest.${best.confidence}`)}</Badge>
                                <span className="font-mono text-xs">{best.entryNo}</span>
                                <span className="text-muted">{note(best)}</span>
                              </span>
                            ) : (
                              <span className="text-[13px] text-muted">{t('treasury.recon.suggest.none')}</span>
                            ))}
                        </Td>
                        {canPost && (
                          <Td className="align-top text-right">
                            <span className="inline-flex flex-wrap justify-end gap-1.5">
                              {l.status === 'open' && (
                                <>
                                  {best && (
                                    <Button size="sm" variant="primary" loading={matchM.isPending && matchM.variables?.lineId === l.id} onClick={() => void run(matchM.mutateAsync({ lineId: l.id, journalLineId: best.journalLineId }), t('treasury.recon.matchedOk'))}>
                                      {t('treasury.recon.actions.match')}
                                    </Button>
                                  )}
                                  {l.suggestions.length > 1 && (
                                    <Button size="sm" onClick={() => setExpanded(open ? null : l.id)} aria-expanded={open}>
                                      {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                                      {t('treasury.recon.actions.candidates')} ({l.suggestions.length})
                                    </Button>
                                  )}
                                  <Button size="sm" onClick={() => setCreating(l)}>
                                    <Plus className="size-3.5" aria-hidden />
                                    {t('treasury.recon.actions.create')}
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => setIgnoring(l)}>
                                    {t('treasury.recon.actions.ignore')}
                                  </Button>
                                </>
                              )}
                              {l.status === 'matched' && (
                                <Button size="sm" onClick={() => void run(unmatchM.mutateAsync(l.id), t('treasury.recon.unmatchedOk'))}>
                                  <Link2Off className="size-3.5" aria-hidden />
                                  {t('treasury.recon.actions.unmatch')}
                                </Button>
                              )}
                              {l.status === 'ignored' && (
                                <Button size="sm" onClick={() => void run(restoreM.mutateAsync(l.id), t('treasury.recon.restoredOk'))}>
                                  {t('treasury.recon.actions.restore')}
                                </Button>
                              )}
                            </span>
                          </Td>
                        )}
                      </tr>
                      {open &&
                        l.suggestions.map((sg) => (
                          <tr key={sg.journalLineId} className="bg-surface-2/60">
                            <Td />
                            <Td colSpan={2} className="text-[13px]">
                              <span className="font-mono text-xs">{sg.entryNo}</span> <span className="text-muted">{formatDateTR(sg.entryDate)}</span> {sg.description}
                              {sg.partyName && <span className="text-muted"> · {sg.partyName}</span>}
                            </Td>
                            <Td>
                              <Badge tone={sg.confidence === 'exact' ? 'success' : 'warning'}>{t(`treasury.recon.suggest.${sg.confidence}`)}</Badge>
                              <span className="ml-2 text-xs text-muted">{note(sg)}</span>
                            </Td>
                            <Td className="text-right">
                              <Button size="sm" onClick={() => void run(matchM.mutateAsync({ lineId: l.id, journalLineId: sg.journalLineId }), t('treasury.recon.matchedOk'))}>
                                {t('treasury.recon.actions.match')}
                              </Button>
                            </Td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>

          <Card>
            <CardHeader title={t('treasury.recon.ledger.title')} description={t('treasury.recon.ledger.hint')} />
            {data.unmatchedLedger.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">{t('treasury.recon.ledger.empty')}</p>
            ) : (
              <TableWrap className="rounded-none border-0">
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-28">{t('treasury.recon.cols.date')}</Th>
                      <Th className="w-40">{t('treasury.recon.ledger.entry')}</Th>
                      <Th>{t('treasury.recon.cols.description')}</Th>
                      <Th>{t('treasury.recon.ledger.party')}</Th>
                      <Th num>
                        {t('treasury.recon.cols.amount')} ({currencySymbol(cur)})
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unmatchedLedger.map((c) => (
                      <tr key={c.journalLineId} className="border-b border-border/70 last:border-b-0">
                        <Td>{formatDateTR(c.entryDate)}</Td>
                        <Td>
                          <Link to={`/accounting/journal?open=${c.entryId}`} className="link font-mono text-[13px]">
                            {c.entryNo}
                          </Link>
                        </Td>
                        <Td>
                          {c.description}
                          {c.txnNo && <span className="ml-2 font-mono text-xs text-muted">{c.txnNo}</span>}
                        </Td>
                        <Td className="text-muted">{c.partyName ?? ''}</Td>
                        <Td num>{money(c.amount)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>

          <Card>
            <CardHeader title={t('treasury.recon.statements.title')} />
            <TableWrap className="rounded-none border-0">
              <Table>
                <thead>
                  <tr>
                    <Th>{t('treasury.recon.statements.file')}</Th>
                    <Th>{t('treasury.recon.statements.range')}</Th>
                    <Th num>{t('treasury.recon.statements.lines')}</Th>
                    <Th num>{t('treasury.recon.statements.matched')}</Th>
                    <Th num>{t('treasury.recon.statements.closing')}</Th>
                    {canPost && <Th />}
                  </tr>
                </thead>
                <tbody>
                  {data.statements.map((st) => (
                    <tr key={st.id} className="border-b border-border/70 last:border-b-0">
                      <Td>{st.fileName}</Td>
                      <Td>
                        {formatDateTR(st.fromDate)} – {formatDateTR(st.toDate)}
                      </Td>
                      <Td num>{st.lineCount}</Td>
                      <Td num>{st.matchedCount}</Td>
                      <Td num>{st.closingBalance === null ? '—' : moneyIn(st.closingBalance, cur)}</Td>
                      {canPost && (
                        <Td className="text-right">
                          <Button size="sm" variant="ghost" disabled={st.matchedCount > 0} onClick={() => setUndoing({ id: st.id, name: st.fileName })}>
                            <Trash2 className="size-3.5" aria-hidden />
                            {t('treasury.recon.statements.undo')}
                          </Button>
                        </Td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </Card>
        </>
      )}

      <ImportWizard kind="bank_statement" open={importing} onOpenChange={setImporting} fixedOptions={{ accountId: account.id }} previousMapping={data.lastMapping} />

      <TransactionSheet
        open={creating !== null}
        onOpenChange={(o) => !o && setCreating(null)}
        line={
          creating
            ? { id: creating.id, date: creating.txnDate, amount: dec(creating.amount).abs().toFixed(2), direction: dec(creating.amount).gt(0) ? 'in' : 'out', accountId: account.id, description: creating.description }
            : undefined
        }
        onSaved={() => setCreating(null)}
      />

      <Modal
        open={ignoring !== null}
        onOpenChange={(o) => !o && setIgnoring(null)}
        title={t('treasury.recon.ignoreTitle')}
        description={t('treasury.recon.ignoreHint')}
        footer={
          <>
            <Button onClick={() => setIgnoring(null)}>{t('treasury.recon.actions.cancel')}</Button>
            <Button
              variant="primary"
              loading={ignoreM.isPending}
              onClick={() => {
                if (!ignoring) return;
                void run(ignoreM.mutateAsync({ lineId: ignoring.id, reason: ignoreReason.trim() }), t('treasury.recon.ignoredOk')).then(() => {
                  setIgnoring(null);
                  setIgnoreReason('');
                });
              }}
            >
              {t('treasury.recon.actions.ignore')}
            </Button>
          </>
        }
      >
        <Field label={t('treasury.recon.ignoreReason')}>{(id) => <Input id={id} value={ignoreReason} maxLength={200} onChange={(e) => setIgnoreReason(e.target.value)} />}</Field>
      </Modal>

      <Modal
        open={undoing !== null}
        onOpenChange={(o) => !o && setUndoing(null)}
        title={t('treasury.recon.statements.undoTitle')}
        description={undoing ? t('treasury.recon.statements.undoBody', { name: undoing.name }) : undefined}
        footer={
          <>
            <Button onClick={() => setUndoing(null)}>{t('treasury.recon.actions.cancel')}</Button>
            <Button
              variant="danger"
              loading={undoM.isPending}
              onClick={() => {
                if (!undoing) return;
                void run(undoM.mutateAsync(undoing.id), t('treasury.recon.statements.undone')).then(() => setUndoing(null));
              }}
            >
              {t('treasury.recon.statements.undo')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </div>
  );
}
