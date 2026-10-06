import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  HardHat,
  ArrowUpRight,
  ClipboardCheck,
  ShieldCheck,
  MessageSquare,
  FileText,
  Wrench,
  CalendarDays,
  Building2,
  Wallet,
  Boxes,
  Users,
} from 'lucide-react';
import type { OperationKind } from '@erp/shared';
import { PageHeader, Card, CardHeader } from '../../components/ui/Card';
import { Stat } from '../../components/ui/Stat';
import { Select } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { useCQuery, useNavigation } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { labels, permissions } from './config';
const details: Record<OperationKind, string> = {
  collection: 'Görüşme, ödeme sözü ve sonraki takip',
  site_report: 'İmalat, çalışanlar, engeller ve saha fotoğrafları',
  schedule: 'İş kırılımı, bağımlılıklar ve gecikme tahmini',
  equipment: 'Araç / makine envanteri ve bakım tarihleri',
  equipment_log: 'Çalışma saati, yakıt, bakım ve gider bağlantıları',
  defect: 'Birim kontrolleri, kusur çözümü ve teslim tutanağı',
  rfi: 'Çizim referanslı sorular, disiplin ve teknik yanıt',
  site_instruction: 'Saha uygulama talimatları ve tamamlanma notları',
  quality_check: 'İmalat kontrolleri ve uygunsuzlukların giderilmesi',
  safety: 'Risk, ramak kala ve düzeltici faaliyet takibi',
};
const icons = {
  collection: Wallet,
  site_report: HardHat,
  schedule: CalendarDays,
  equipment: Wrench,
  equipment_log: Wrench,
  defect: Building2,
  rfi: MessageSquare,
  site_instruction: FileText,
  quality_check: ClipboardCheck,
  safety: ShieldCheck,
};
export function ConstructionPage() {
  return <ConstructionContent key={useCompany().id} />;
}
function ConstructionContent() {
  const [projectId, setProjectId] = useState('');
  const nav = useNavigation();
  const can = (p: string) => nav.data?.permissions.includes(p) ?? false;
  const enabled = (m: string) => nav.data?.modules.includes(m) ?? false;
  const projects = useCQuery<{ projects: { id: string; name: string; code: string }[] }>(
    ['workspace-projects'],
    '/api/projects?limit=200',
  );
  const summary = useCQuery<{
    items: { kind: OperationKind; total: number; open: number; done: number; overdue: number }[];
    asOf: string;
  }>(
    ['construction-summary', projectId],
    '/api/workspace/construction-summary' + (projectId ? '?projectId=' + projectId : ''),
  );
  const rows = summary.data?.items ?? [];
  const totals = rows.reduce(
    (a, r) => ({ open: a.open + r.open, overdue: a.overdue + r.overdue, done: a.done + r.done }),
    { open: 0, overdue: 0, done: 0 },
  );
  const shortcuts = [
    {
      name: 'Proje bütçesi ve maliyetler',
      description: 'Bütçe, iş kırılımı, gerçekleşen maliyet ve tahmin',
      path: projectId ? '/projects/' + projectId : '/projects',
      permission: 'projects.read',
      module: 'construction.projects',
      icon: Building2,
    },
    {
      name: 'Taşeron ve hakediş',
      description: 'Sözleşmeler, metraj, kesintiler ve onaylar',
      path: '/subcontracts',
      permission: 'subcontracts.read',
      module: 'construction.subcontracts',
      icon: Users,
    },
    {
      name: 'Satın alma',
      description: 'Talep, teklif karşılaştırma, sipariş ve teslim',
      path: '/purchasing/requests',
      permission: 'procurement.read',
      module: 'construction.procurement',
      icon: Boxes,
    },
    {
      name: 'Gayrimenkul satışları',
      description: 'Bağımsız birimler, sözleşmeler ve taksitler',
      path: '/real-estate/units',
      permission: 'realestate.read',
      module: 'construction.realestate',
      icon: Building2,
    },
    {
      name: 'Şantiye puantajı',
      description: 'Proje bazında çalışan saatleri ve mesai',
      path: '/hr/attendance',
      permission: 'hr.read',
      module: 'hr.attendance',
      icon: Users,
    },
    {
      name: 'Nakit senaryoları',
      description: 'Tahsilat gecikmesi ve maliyet artışı etkisi',
      path: '/workspace/scenarios',
      permission: 'treasury.read',
      module: 'core.treasury',
      icon: Wallet,
    },
  ].filter((s) => can(s.permission) && enabled(s.module));
  return (
    <>
      <PageHeader
        title="İnşaat kontrol merkezi"
        description="Saha operasyonları, teknik takip ve ticari süreçler için ortak çalışma alanı."
        actions={
          <Link className="link inline-flex items-center gap-2 text-sm" to="/projects">
            Projelere git
            <ArrowUpRight className="size-4" />
          </Link>
        }
      />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <label className="flex flex-wrap items-center gap-3 text-sm">
          Proje kapsamı
          <Select
            aria-label="Proje kapsamı"
            className="w-auto max-w-full"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">Tüm projeler</option>
            {projects.data?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </Select>
        </label>
        <p className="text-xs text-muted">Özetler erişim yetkinize göre gösterilir.</p>
      </div>
      {(summary.error || projects.error) && (
        <Callout tone="danger">{(summary.error ?? projects.error)?.message}</Callout>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Açık operasyon" sub="Seçilen kapsamda">
          {summary.data ? totals.open : '—'}
        </Stat>
        <Stat label="Gecikmiş takip" sub="Termin geçen açık kayıtlar">
          <span className="text-danger">{summary.data ? totals.overdue : '—'}</span>
        </Stat>
        <Stat label="Tamamlanan" sub="Tamamlanan operasyon kayıtları">
          {summary.data ? totals.done : '—'}
        </Stat>
        <Stat label="Proje sayısı" sub="İlk 200 projedeki kayıtlar">
          {projects.data?.projects.length ?? '—'}
        </Stat>
      </div>
      {summary.isPending ? (
        <PageLoading />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows
            .filter((r) => can(permissions[r.kind]) && (!projectId || r.kind !== 'collection'))
            .map((r) => {
              const Icon = icons[r.kind];
              return (
                <Link
                  className="group rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-border-strong"
                  key={r.kind}
                  to={
                    '/workspace/operations?kind=' +
                    r.kind +
                    (projectId ? '&projectId=' + projectId : '')
                  }
                >
                  <div className="mb-5 flex items-center justify-between">
                    <Icon className="size-5 text-muted" />
                    <ArrowUpRight className="size-4 text-muted" />
                  </div>
                  <h2 className="text-base">{labels[r.kind]}</h2>
                  <p className="mt-2 min-h-10 text-sm text-muted">{details[r.kind]}</p>
                  <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <Badge>{r.open} açık</Badge>
                    {r.overdue > 0 && <Badge tone="danger">{r.overdue} gecikmiş</Badge>}
                    <span className="ml-auto text-xs text-muted">{r.total} kayıt</span>
                  </div>
                </Link>
              );
            })}
        </div>
      )}
      <Link to={"/workspace/project-control"+(projectId?"?projectId="+projectId:"")} className="mt-6 flex items-center justify-between rounded-2xl border border-border bg-surface p-5"><div><h2>Proje 360</h2><p className="mt-2 text-sm text-muted">Çizim revizyonları, plan işaretleri, fotoğraflar ve risk radarı.</p></div><ArrowUpRight className="size-5"/></Link>
      <Card className="mt-6">
        <CardHeader
          title="Ticari ve idari süreçler"
          description="Mevcut ERP kayıtlarıyla birlikte çalışın."
        />
        <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-3">
          {shortcuts.map((s) => (
            <Link
              className="flex items-start gap-3 border-b border-border p-5 hover:bg-surface-2"
              key={s.path}
              to={s.path}
            >
              <s.icon className="mt-1 size-4 shrink-0 text-muted" />
              <div>
                <h2 className="text-sm">{s.name}</h2>
                <p className="mt-1 text-xs text-muted">{s.description}</p>
              </div>
              <ArrowUpRight className="ml-auto size-4 shrink-0 text-muted" />
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}
