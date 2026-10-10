import { useEffect, useState } from 'react';
import { PORTAL_DOCUMENT_KINDS, PORTAL_SCOPE_LABELS, portalScopeOf, ITEM_UNIT_LABELS, type PortalDocumentKind, type PortalDocumentScopes, type PortalDocumentDetail, type PortalDocumentList } from '@erp/shared';
import { FileText, ChevronRight } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { formatDateTR, formatTR, moneyIn } from '../../lib/format';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';

const labels = { invoice: 'Faturalar', quote: 'Teklifler', order: 'Siparişler' } as const;
const statuses: Record<string, string> = { posted: 'Kesinleşti', sent: 'Gönderildi', accepted: 'Kabul edildi', converted: 'Siparişe dönüştü', confirmed: 'Onaylandı', closed: 'Tamamlandı' };
const PAGE_SIZE = 20;
type Props = { scopes: PortalDocumentScopes; token: string; password: string; revision: number; onAccessLost: (message: string) => void };

export function PortalBusinessDocuments({ scopes, token, password, revision, onAccessLost }: Props) {
  const available = PORTAL_DOCUMENT_KINDS.filter(kind => scopes[portalScopeOf(kind)]);
  const [selectedKind, setKind] = useState<PortalDocumentKind>('invoice');
  const kind = available.includes(selectedKind) ? selectedKind : available[0];
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<PortalDocumentList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PortalDocumentDetail | null>(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!kind) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setResult(null);
    void api<PortalDocumentList>('/api/portal/view', { anonymous: true, method: 'POST', signal: controller.signal, body: { token, password, action: 'list_documents', recordKind: kind, offset, limit: PAGE_SIZE } })
      .then(value => { if (!controller.signal.aborted) setResult(value); })
      .catch((e: Error) => { if (controller.signal.aborted) return; if (e instanceof ApiError && [401, 403].includes(e.status)) onAccessLost(e.message); else setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, token, password, offset, revision, onAccessLost]);
  useEffect(() => {
    if (!selected || !kind) return;
    const controller = new AbortController();
    setDetailLoading(true); setDetailError(''); setDetail(null);
    void api<{ document: PortalDocumentDetail }>('/api/portal/view', { anonymous: true, method: 'POST', signal: controller.signal, body: { token, password, action: 'document_detail', recordKind: kind, recordId: selected } })
      .then(value => { if (!controller.signal.aborted) setDetail(value.document); })
      .catch((e: Error) => { if (controller.signal.aborted) return; if (e instanceof ApiError && [401, 403].includes(e.status)) onAccessLost(e.message); else setDetailError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, kind, token, password, revision, onAccessLost]);
  if (!kind) return null;
  return <Card className="min-w-0 space-y-4 p-5">
    <div><h2 className="font-semibold">Satış belgeleriniz</h2><p className="mt-1 text-sm text-muted">{available.map(k => PORTAL_SCOPE_LABELS[portalScopeOf(k)]).join(' · ')}</p></div>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Belge türü">{available.map(k => <Button key={k} size="sm" variant={kind === k ? 'primary' : 'secondary'} aria-pressed={kind === k} onClick={() => { setKind(k); setOffset(0); setSelected(null); }}>{labels[k]}</Button>)}</div>
    {error && <Callout tone="danger">{error}</Callout>}
    {loading && <PageLoading />}
    {!loading && !error && result?.items.length === 0 && <EmptyState icon={<FileText className="size-5" />} title="Paylaşılabilir belge bulunmuyor" description="Bu kapsamda yalnızca kesinleşmiş veya müşteriye gönderilmiş belgeler görünür." />}
    <ul className="divide-y divide-border">{result?.items.map(row => <li key={row.id}>
      <button type="button" className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg py-4 text-left hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-text" onClick={() => setSelected(row.id)}>
        <span className="min-w-0 space-y-1"><span className="block break-all font-medium">{row.number}</span><span className="block text-xs text-muted">{formatDateTR(row.date)} · {row.currency}{row.type === 'sales_return' ? ' · Satış iadesi' : ''}</span><Badge>{statuses[row.status] ?? 'Kesinleşti'}</Badge></span>
        <span className="flex shrink-0 items-center gap-2"><span className="text-sm tabular-nums">{moneyIn(row.grossTotal, row.currency)}</span><ChevronRight className="size-4 text-muted" /></span>
      </button>
    </li>)}</ul>
    {result && result.total > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"><p className="text-xs text-muted">{offset + 1}–{Math.min(offset + PAGE_SIZE, result.total)} / {result.total} belge</p><div className="flex gap-2"><Button size="sm" disabled={loading || offset === 0} onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setSelected(null); }}>Önceki</Button><Button size="sm" disabled={loading || offset + PAGE_SIZE >= result.total} onClick={() => { setOffset(offset + PAGE_SIZE); setSelected(null); }}>Sonraki</Button></div></div>}
    <Sheet open={!!selected} onOpenChange={open => { if (!open) { setSelected(null); setDetail(null); } }} title={detail?.number ?? 'Belge ayrıntısı'} description="Yalnız size ait paylaşılabilir satış bilgileri gösterilir." wide>
      {detailLoading && <PageLoading />}{detailError && <Callout tone="danger">{detailError}</Callout>}{detail && <PortalDocumentContent document={detail} />}
    </Sheet>
  </Card>;
}

export function PortalDocumentContent({ document: d }: { document: PortalDocumentDetail }) {
  const totals = [['Ara toplam', d.netTotal], ['KDV', d.vatTotal], ['Vergiler dahil toplam', d.grossTotal], ...(Number(d.vatWithheld) ? [['KDV tevkifatı', d.vatWithheld]] : []), ...(Number(d.incomeWithheld) ? [['Stopaj', d.incomeWithheld]] : []), ...(Number(d.stamp) ? [['Damga vergisi', d.stamp]] : []), ['Ödenecek tutar', d.payableToSeller]];
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-2"><Badge>{labels[d.kind]}</Badge><Badge>{statuses[d.status] ?? 'Kesinleşti'}</Badge>{d.type === 'sales_return' && <Badge>Satış iadesi</Badge>}</div>
    <dl className="grid grid-cols-2 gap-4 text-sm">{[['Belge tarihi', d.date], ['Vade', d.dueDate], ['Teklif geçerlilik sonu', d.validUntil], ['Planlanan teslim', d.deliveryDate]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1">{formatDateTR(value)}</dd></div>)}<div><dt className="text-xs text-muted">Para birimi</dt><dd className="mt-1">{d.currency}</dd></div><div><dt className="text-xs text-muted">Birim fiyat</dt><dd className="mt-1">{d.vatIncluded ? 'KDV dahil' : 'KDV hariç'}</dd></div></dl>
    <section className="space-y-3"><h3 className="font-medium">Kalemler</h3>{d.lines.map(line => <div key={line.lineNo} className="min-w-0 rounded-lg border border-border p-4 text-sm"><p className="mb-3 break-words font-medium">{line.lineNo}. {line.description}</p><dl className="grid grid-cols-2 gap-x-4 gap-y-3"><div><dt className="text-xs text-muted">Miktar</dt><dd>{formatTR(line.quantity, 3)} {line.unit ? (ITEM_UNIT_LABELS as Record<string, string>)[line.unit] ?? line.unit : ''}</dd></div><div><dt className="text-xs text-muted">Birim fiyat</dt><dd>{moneyIn(line.unitPrice, d.currency)}</dd></div>{Number(line.discountPct) > 0 && <div><dt className="text-xs text-muted">İndirim</dt><dd>%{formatTR(line.discountPct, 2)}</dd></div>}<div><dt className="text-xs text-muted">KDV oranı</dt><dd>%{formatTR(line.vatRate, 2)}</dd></div><div><dt className="text-xs text-muted">Kalem toplamı</dt><dd className="font-medium">{moneyIn(line.gross, d.currency)}</dd></div></dl></div>)}</section>
    <dl className="space-y-3 rounded-lg bg-surface-2 p-4">{totals.map(([label, value], index) => <div key={label} className={`flex flex-wrap justify-between gap-2 text-sm ${index === totals.length - 1 ? 'border-t border-border pt-3 font-semibold' : ''}`}><dt>{label}</dt><dd className="tabular-nums">{moneyIn(value, d.currency)}</dd></div>)}</dl>
  </div>;
}
