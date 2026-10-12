import { Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '../../components/ui/Card';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { cn } from '../../lib/cn';

type ChainKind = 'quote' | 'order' | 'delivery' | 'invoice' | 'payment';
interface ChainNode {
  kind: ChainKind; id: string; restricted: boolean; no: string | null; date: string | null; status: string | null;
  type: string | null; amount: string | null; currency: string | null; path: string | null;
}
interface ChainData { start: string; nodes: ChainNode[]; edges: { from: string; to: string }[]; truncated: boolean }

const STAGES: { kind: ChainKind; label: string }[] = [
  { kind: 'quote', label: 'Teklif' },
  { kind: 'order', label: 'Sipariş' },
  { kind: 'delivery', label: 'İrsaliye' },
  { kind: 'invoice', label: 'Fatura' },
  { kind: 'payment', label: 'Tahsilat' },
];
const STATUS: Record<string, string> = {
  draft: 'Taslak', sent: 'Gönderildi', accepted: 'Kabul edildi', rejected: 'Reddedildi', converted: 'Siparişe dönüştü',
  confirmed: 'Onaylandı', closed: 'Kapandı', cancelled: 'İptal', posted: 'Kayıtlı',
};
const TYPE: Record<string, string> = { sales_return: 'İade', receipt: 'Tahsilat', payment: 'Ödeme' };

/**
 * Satış belge zinciri (öneri 3): teklif → sipariş → irsaliye → fatura/iade → tahsilat. Bağlar kayıtlı ilişkilerden gelir;
 * kullanıcının yetkisi dışındaki aşamada belge numarası ve tutar gösterilmez.
 */
export function DocumentChain({ kind, id }: { kind: 'quote' | 'order' | 'delivery' | 'invoice'; id: string }) {
  const chain = useCQuery<ChainData>(['sales-chain', kind, id], `/api/sales-chain?kind=${kind}&id=${id}`, { allowForbidden: true });
  const data = chain.data;
  // Tek başına duran belge için kart gösterilmez
  if (!data || data.nodes.length < 2) return null;
  const stages = STAGES.filter((stage) => data.nodes.some((n) => n.kind === stage.kind));
  return (
    <Card className="p-5 print:hidden">
      <section aria-label="Belge zinciri">
        <h2 className="text-base font-semibold">Belge zinciri</h2>
        <p className="mb-3 text-xs text-muted">Bu belgeye bağlı teklif, sipariş, irsaliye, fatura ve tahsilatlar.</p>
        <ol className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
          {stages.map((stage) => (
            <li key={stage.kind} className="min-w-0">
              <p className="micro mb-1.5">{stage.label}</p>
              <ul className="flex flex-col gap-1.5">
                {data.nodes.filter((n) => n.kind === stage.kind).map((n) => {
                  const current = data.start === `${n.kind}:${n.id}`;
                  const body = <>
                    <span className="flex items-center gap-1.5 font-medium">
                      {n.restricted && <Lock className="size-3.5 text-muted" aria-hidden />}
                      {n.restricted ? 'Yetkiniz dışında' : n.no ?? 'Numarasız taslak'}
                      {n.type && TYPE[n.type] && <span className="text-xs font-normal text-muted">· {TYPE[n.type]}</span>}
                    </span>
                    {!n.restricted && <span className="block text-xs text-muted">
                      {[n.date ? formatDateTR(n.date) : null, n.status ? STATUS[n.status] ?? n.status : null].filter(Boolean).join(' · ')}
                    </span>}
                    {n.amount && n.currency && <span className="num block text-xs">{moneyIn(n.amount, n.currency)}</span>}
                  </>;
                  const style = cn('block rounded-lg border px-3 py-2 text-sm', current ? 'border-text bg-surface-2' : 'border-border', n.status === 'cancelled' && 'opacity-60');
                  return <li key={n.id}>
                    {n.path && !current
                      ? <Link to={n.path} className={cn(style, 'hover:bg-surface-2')}>{body}</Link>
                      : <div className={style} aria-current={current ? 'page' : undefined}>{body}</div>}
                  </li>;
                })}
              </ul>
            </li>
          ))}
        </ol>
        {data.truncated && <p className="mt-2 text-xs text-muted">Zincir çok uzun; ilk 200 belge gösteriliyor.</p>}
      </section>
    </Card>
  );
}
