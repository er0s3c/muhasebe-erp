import { Link } from 'react-router-dom';
import { Card } from '../ui/Card';
import { ListSkeleton } from '../ui/Feedback';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { ErrorCallout } from './Blocked';

interface RelatedRow { id: string; no: string | null; date: string | null; status: string | null; amount: string | null; currency: string | null; path: string }
interface RelatedData { sections: { key: string; label: string; total: number; recent: RelatedRow[] }[] }

const STATUS: Record<string, string> = {
  draft: 'Taslak', sent: 'Gönderildi', accepted: 'Kabul edildi', rejected: 'Reddedildi', converted: 'Siparişe dönüştü',
  confirmed: 'Onaylandı', closed: 'Kapandı', cancelled: 'İptal', posted: 'Kayıtlı', issued: 'Gönderildi', active: 'Yürürlükte',
  completed: 'Tamamlandı', terminated: 'Feshedildi',
};

/**
 * Cari, ürün ve proje için ortak ilişkili kayıtlar görünümü (öneri 4): teklif, sipariş, irsaliye, fatura, tahsilat/ödeme,
 * satın alma ve taşeron belgeleri tek yerde. Yalnız kullanıcının yetkili olduğu bölümler gelir.
 */
export function RelatedRecords({ kind, id }: { kind: 'party' | 'item' | 'project'; id: string }) {
  const query = useCQuery<RelatedData>(['related', kind, id], `/api/related?kind=${kind}&id=${id}`);
  if (query.isPending) return <ListSkeleton />;
  if (query.error) return <ErrorCallout error={query.error} />;
  const sections = query.data?.sections ?? [];
  if (sections.length === 0) return <p className="text-sm text-muted">Bu kayda bağlı belge yok.</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2" aria-label="İlişkili kayıtlar">
      {sections.map((s) => (
        <Card key={s.key} className="p-4">
          <section aria-label={s.label}>
            <h3 className="mb-2 flex items-baseline justify-between gap-2 text-sm font-semibold">
              {s.label}<span className="text-xs font-normal text-muted">{s.total} kayıt{s.total > s.recent.length ? ` · son ${s.recent.length}` : ''}</span>
            </h3>
            <ul className="flex flex-col divide-y divide-border">
              {s.recent.map((r) => (
                <li key={r.id}>
                  <Link to={r.path} className="flex items-center justify-between gap-3 py-1.5 text-sm hover:bg-surface-2">
                    <span className="min-w-0">
                      <span className="block truncate">{r.no ?? 'Numarasız taslak'}</span>
                      <span className="block text-xs text-muted">{[r.date ? formatDateTR(r.date) : null, r.status ? STATUS[r.status] ?? r.status : null].filter(Boolean).join(' · ')}</span>
                    </span>
                    {r.amount && r.currency && <span className="num shrink-0 text-xs">{moneyIn(r.amount, r.currency)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </Card>
      ))}
    </div>
  );
}
