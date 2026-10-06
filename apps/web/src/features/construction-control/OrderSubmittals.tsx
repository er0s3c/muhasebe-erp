import { Link } from 'react-router-dom';
import { useCQuery, useModuleEnabled } from '../../lib/queries';
import { Card, CardHeader } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
export function OrderSubmittals({ orderId }: { orderId: string }) {
  const enabled = useModuleEnabled('construction.procurement');
  const { data } = useCQuery<{
    items: {
      id: string;
      title: string;
      status: string;
      projectId: string;
      brand: string;
      revision: string;
    }[];
  }>(
    ['control', 'order-submittals', orderId],
    enabled ? `/api/construction/order-submittals?orderId=${orderId}` : null,
    { allowForbidden: true },
  );
  if (!data?.items.length) return null;
  const labels: Record<string, string> = {
    draft: 'Taslak',
    submitted: 'İncelemede',
    rejected: 'Reddedildi',
    approved: 'Onaylı',
    closed: 'Kapalı',
    cancelled: 'İptal',
  };
  return (
    <Card>
      <CardHeader
        title="Malzeme ve numune onayları"
        description="Bu siparişe bağlı teknik föy, marka ve revizyon dosyaları."
      />
      <div className="space-y-3 p-5">
        {data.items.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3">
            <Link
              className="underline"
              to={`/workspace/project-control?projectId=${r.projectId}&tab=field&open=${r.id}`}
            >
              {r.title} · {r.brand} · Rev {r.revision}
            </Link>
            <Badge
              tone={
                r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'
              }
            >
              {labels[r.status] ?? r.status}
            </Badge>
          </div>
        ))}
      </div>
    </Card>
  );
}
