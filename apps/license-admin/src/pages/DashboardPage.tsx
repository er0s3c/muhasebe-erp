import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PageHeader } from '@ui/Card';
import { PageLoading } from '@ui/Feedback';
import { Stat } from '@ui/Stat';
import { api, type Dashboard } from '../api';

export function DashboardPage() {
  const { data, isPending } = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/admin/api/dashboard') });
  if (isPending || !data) return <PageLoading />;
  const { licenses, activations } = data;
  return (
    <>
      <PageHeader title="Özet" description="Müşteri, lisans ve etkinleştirme durumu." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="dashboard">
        <Stat label="Müşteri">
          <Link to="/customers" className="link">{data.customers}</Link>
        </Stat>
        <Stat label="Etkin lisans" sub={`${licenses.suspended ?? 0} askıda · ${licenses.revoked ?? 0} iptal`}>
          <Link to="/licenses?status=active" className="link">{licenses.active ?? 0}</Link>
        </Stat>
        <Stat label="Etkin kurulum" sub={`${activations.reportedDevices} cihaz bildirildi`}>
          {activations.active}
        </Stat>
        <Stat label="Klon şüphesi" sub="Aynı kurulum kimliği birden çok IP'den">
          <Link to="/licenses?flagged=1" className="link">{activations.flagged}</Link>
        </Stat>
        <Stat label="30 gün içinde bitecek" sub="Yenileme için müşteriyle görüşün">
          {data.expiringIn30Days}
        </Stat>
      </div>
    </>
  );
}
