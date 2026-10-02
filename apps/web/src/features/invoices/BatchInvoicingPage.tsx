import { CheckCircle2, ChevronDown, ChevronRight, Layers, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { dec, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { BatchHistoryRow, BatchPreview, BatchResult } from '../../lib/types';
import { qtyText, useUnitLabel } from '../inventory/common';
import { INVOICE_INVALIDATE, usePartyOptions } from './common';

/**
 * Toplu faturalama: faturalanmamış satış irsaliyelerini dönem ve cariye göre listeler, seçilenleri cari başına (ya da irsaliye başına)
 * faturalar. Fiyat siparişten ya da stok kartından gelir; fiyatı bulunamayan irsaliye engellenir ve nedeni gösterilir.
 * Her fatura kendi işleminde kaydedilir; biri başarısız olursa diğerleri etkilenmez.
 */
export function BatchInvoicingPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const canPost = can('invoices.post');
  const unitLabel = useUnitLabel();

  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayIso());
  const [partyId, setPartyId] = useState('');
  const [grouping, setGrouping] = useState<'party' | 'note'>('party');
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [post, setPost] = useState(canPost);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BatchResult | null>(null);

  const { parties } = usePartyOptions('customer');
  const qs = new URLSearchParams({ grouping });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (partyId) qs.set('partyId', partyId);
  const preview = useCQuery<BatchPreview>(['batch-preview', qs.toString()], `/api/invoice-batches/preview?${qs}`);
  const history = useCQuery<{ batches: BatchHistoryRow[] }>(['batch-history'], '/api/invoice-batches?limit=10');

  // Önizleme değişince seçim, faturalanabilir irsaliyelerle sınırlanır
  useEffect(() => {
    if (!preview.data) return;
    const ok = new Set(preview.data.parties.flatMap((p) => p.notes.filter((n) => !n.blocked).map((n) => n.noteId)));
    setPicked((cur) => new Set([...cur].filter((id) => ok.has(id))));
  }, [preview.data]);

  const noteById = useMemo(() => new Map((preview.data?.parties ?? []).flatMap((p) => p.notes.map((n) => [n.noteId, { n, p }] as const))), [preview.data]);
  const selectedGross = useMemo(() => {
    const by = new Map<string, ReturnType<typeof dec>>();
    for (const id of picked) {
      const x = noteById.get(id);
      if (x) by.set(x.n.currency, (by.get(x.n.currency) ?? dec(0)).plus(x.n.gross));
    }
    return [...by.entries()];
  }, [picked, noteById]);

  const toggle = (ids: string[], on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const run = useCMutation(
    (_: void, c) => c<BatchResult>('/api/invoice-batches', { method: 'POST', body: { noteIds: [...picked], invoiceDate, grouping, post: post && canPost } }),
    [...INVOICE_INVALIDATE, ['batch-preview'], ['batch-history']],
  );

  const submit = () =>
    run.mutate(undefined, {
      onSuccess: (r) => {
        setResult(r);
        setPicked(new Set());
        if (r.created.length > 0 && r.failed.length === 0) toast.success(t('batch.doneMsg', { count: r.created.length }));
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const data = preview.data;
  return (
    <>
      <PageHeader title={t('batch.title')} description={t('batch.subtitle')} />

      <Card className="mb-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />}</Field>
          <Field label={t('batch.party')}>
            {(id) => (
              <Select id={id} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                <option value="">{t('batch.allParties')}</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('batch.grouping')}>
            {(id) => (
              <Select id={id} value={grouping} onChange={(e) => setGrouping(e.target.value as 'party' | 'note')}>
                <option value="party">{t('batch.groupParty')}</option>
                <option value="note">{t('batch.groupNote')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('batch.invoiceDate')}>{(id) => <Input id={id} type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />}</Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={post && canPost} disabled={!canPost} onChange={(e) => setPost(e.target.checked)} />
            {t('batch.post')}
          </label>
          <span className="text-xs text-muted">{canPost ? t('batch.postHint') : t('batch.draftOnly')}</span>
        </div>
      </Card>

      {result && (
        <div className="mb-5 flex flex-col gap-3" data-testid="batch-result">
          {result.created.length > 0 && (
            <Callout tone="info" title={t('batch.result.created', { count: result.created.length })}>
              <ul className="mt-1 flex flex-col gap-0.5">
                {result.created.map((c) => (
                  <li key={c.invoiceId}>
                    <Link to={`/invoices/${c.invoiceId}`} className="link">
                      {c.invoiceNo ?? t('invoices.status.draft')}
                    </Link>{' '}
                    · {c.partyName} · {moneyIn(c.gross, noteCurrency(c.noteIds, noteById))}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {result.failed.length > 0 && (
            <Callout tone="danger" title={t('batch.result.failed', { count: result.failed.length })}>
              <ul className="mt-1 flex flex-col gap-0.5">
                {result.failed.map((f, i) => (
                  <li key={i}>
                    <strong>{f.partyName}</strong>: {f.message}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs">{t('batch.result.failedHint')}</p>
            </Callout>
          )}
          {result.skipped.length > 0 && <Callout tone="warning">{t('batch.result.skipped', { count: result.skipped.length })}</Callout>}
        </div>
      )}

      {preview.isPending ? (
        <PageLoading />
      ) : !data || data.parties.length === 0 ? (
        <Card>
          <EmptyState icon={<Layers className="size-5" />} title={t('batch.empty')} description={t('batch.emptyDesc')} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {data.parties.map((p) => {
            const selectable = p.notes.filter((n) => !n.blocked).map((n) => n.noteId);
            const allOn = selectable.length > 0 && selectable.every((id) => picked.has(id));
            return (
              <Card key={p.partyId} className="overflow-hidden" data-testid={`batch-party-${p.partyCode}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <label className="flex cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={allOn}
                      disabled={selectable.length === 0}
                      onChange={(e) => toggle(selectable, e.target.checked)}
                      aria-label={t('batch.selectParty', { name: p.partyName })}
                    />
                    <span className="font-medium">{p.partyName}</span>
                    <span className="font-mono text-xs text-muted">{p.partyCode}</span>
                  </label>
                  <span className="flex items-center gap-2 text-sm text-muted">
                    {p.pendingReturns > 0 && <Badge tone="warning">{t('batch.pendingReturns', { count: p.pendingReturns })}</Badge>}
                    {t('batch.invoicesForParty', { count: p.invoiceCount })}
                  </span>
                </div>
                <TableWrap>
                  <Table>
                    <thead>
                      <tr>
                        <Th className="w-10" />
                        <Th className="w-44">{t('deliveries.number')}</Th>
                        <Th className="w-28">{t('common.date')}</Th>
                        <Th>{t('batch.lines')}</Th>
                        <Th num>{t('invoices.grossTotal')}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.notes.map((n) => {
                        const isOpen = open.has(n.noteId);
                        return (
                          <NoteRow key={n.noteId}>
                            <tr className={n.blocked ? 'bg-warning-soft/40' : undefined}>
                              <Td>
                                <input
                                  type="checkbox"
                                  className="size-4"
                                  checked={picked.has(n.noteId)}
                                  disabled={n.blocked}
                                  onChange={(e) => toggle([n.noteId], e.target.checked)}
                                  aria-label={n.noteNo ?? n.noteId}
                                />
                              </Td>
                              <Td>
                                <Link to={`/delivery-notes/${n.noteId}`} className="link font-mono text-[13px]">
                                  {n.noteNo}
                                </Link>
                              </Td>
                              <Td className="text-muted">{formatDateTR(n.noteDate)}</Td>
                              <Td>
                                <button
                                  className="inline-flex items-center gap-1 text-left text-sm text-muted hover:text-text"
                                  onClick={() => setOpen((cur) => { const next = new Set(cur); if (next.has(n.noteId)) next.delete(n.noteId); else next.add(n.noteId); return next; })}
                                  aria-expanded={isOpen}
                                >
                                  {isOpen ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                                  {t('batch.lineCount', { count: n.lines.length })}
                                </button>
                                {n.blocked && (
                                  <ul className="mt-1 flex flex-col gap-0.5 text-[13px] text-warning">
                                    {n.issues.map((i) => (
                                      <li key={i.code + i.message} className="flex items-start gap-1.5">
                                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                        {i.message}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                {isOpen && (
                                  <ul className="mt-1 flex flex-col gap-0.5 text-[13px]">
                                    {n.lines.map((l) => (
                                      <li key={l.lineId} className="flex flex-wrap gap-x-3 text-muted">
                                        <span className="font-mono">{l.itemCode}</span>
                                        <span>{l.description}</span>
                                        <span className="num">
                                          {qtyText(l.quantity)} {l.unit ? unitLabel(l.unit) : ''}
                                        </span>
                                        <span className="num">{l.unitPrice ? `× ${moneyIn(l.unitPrice, n.currency, 2)}` : '—'}</span>
                                        {l.priceSource && <Badge tone="neutral">{t(`batch.source.${l.priceSource}`)}</Badge>}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </Td>
                              <Td num>{n.blocked ? '—' : moneyIn(n.gross, n.currency)}</Td>
                            </tr>
                          </NoteRow>
                        );
                      })}
                    </tbody>
                  </Table>
                </TableWrap>
              </Card>
            );
          })}

          <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-lg print:hidden">
            <div className="text-sm">
              <span className="font-medium">{t('batch.selected', { count: picked.size })}</span>
              {selectedGross.length > 0 && <span className="ml-3 text-muted">{selectedGross.map(([c, v]) => moneyIn(v.toFixed(2), c)).join(' · ')}</span>}
            </div>
            <Button variant="primary" disabled={picked.size === 0} loading={run.isPending} onClick={submit}>
              <CheckCircle2 className="size-4" aria-hidden />
              {t('batch.run')}
            </Button>
          </div>
        </div>
      )}

      {history.data && history.data.batches.length > 0 && (
        <section className="mt-8" aria-label={t('batch.history')}>
          <h2 className="mb-2 text-sm font-medium">{t('batch.history')}</h2>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-40">{t('common.date')}</Th>
                  <Th>{t('batch.invoiceDate')}</Th>
                  <Th>{t('batch.grouping')}</Th>
                  <Th num>{t('batch.created')}</Th>
                  <Th num>{t('batch.failed')}</Th>
                  <Th>{t('batch.user')}</Th>
                </tr>
              </thead>
              <tbody>
                {history.data.batches.map((b) => (
                  <tr key={b.id}>
                    <Td className="text-muted">{formatDateTR(b.createdAt.slice(0, 10))}</Td>
                    <Td>{formatDateTR(b.invoiceDate)}</Td>
                    <Td className="text-muted">
                      {b.grouping === 'party' ? t('batch.groupParty') : t('batch.groupNote')} · {b.post ? t('batch.posted') : t('batch.draft')}
                    </Td>
                    <Td num>{b.invoicesCreated}</Td>
                    <Td num className={b.invoicesFailed > 0 ? 'text-danger' : 'text-muted'}>{b.invoicesFailed}</Td>
                    <Td className="text-muted">{b.userName ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </section>
      )}
    </>
  );
}

/** tbody içinde sarmalayıcı: yalnızca düzen (React anahtarı için). */
function NoteRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function noteCurrency(noteIds: string[], byId: Map<string, { n: { currency: string } }>): string {
  return byId.get(noteIds[0] ?? '')?.n.currency ?? 'TRY';
}
