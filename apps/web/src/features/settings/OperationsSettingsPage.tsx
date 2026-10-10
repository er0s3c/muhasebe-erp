import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, ShieldCheck, RefreshCw, Landmark, HardDrive, Activity } from 'lucide-react';
import { type OperationsSettings, operationsSettingsSchema } from '@erp/shared';
import { PageHeader, Card, CardHeader } from '../../components/ui/Card';
import { Field, Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { useCQuery, useCMutation, useCan } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { TableWrap, Table, Tr, Th, Td } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { DocumentSettingsSection } from './DocumentSettingsSection';

type Run = {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: { date?: string; imported?: unknown[]; skipped?: string[] };
};
type SettingsData = {
  settings: OperationsSettings;
  version: number;
  runs: Run[];
  rateSource: string | null;
  rateProviderLabel: string | null;
  timeZone: string;
};
export function OperationsSettingsPage() {
  return <SettingsContent key={useCompany().id} />;
}
function SettingsContent() {
  const query = useCQuery<SettingsData>(['operations-settings'], '/api/settings/operations', {
    refetchInterval: 60000,
  });
  if (query.error) return <Callout tone="danger">{query.error.message}</Callout>;
  if (!query.data) return <PageLoading />;
  return <SettingsForm key={query.data.version} data={query.data} />;
}
function SettingsForm({ data }: { data: SettingsData }) {
  const [settings, setSettings] = useState(data.settings),
    toast = useToast(),
    can = useCan();
  const edit = can('settings.manage');
  const change = <K extends keyof OperationsSettings>(key: K, value: OperationsSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  const save = useCMutation(
    (_: void, call) =>
      call('/api/settings/operations', {
        method: 'PUT',
        body: { settings: operationsSettingsSchema.parse(settings), version: data.version },
      }),
    [['operations-settings'], ['upload-limits'], ['document-format']],
  );
  const rates = useCMutation(
    (_: void, call) =>
      call<{ status: string; error?: string }>('/api/settings/operations/rates/run', {
        method: 'POST',
      }),
    [['operations-settings'], ['rates']],
  );
  return (
    <>
      <PageHeader
        title="İşletim ve güvenlik"
        description="Belge serileri, çıktı şablonları, dosya yükleme, güvenlik ve otomatik kur işlemleri için şirket ayarları."
        actions={
          <Link to="/reports/activity" className="link inline-flex items-center gap-2 text-sm">
            <Activity className="size-4" />
            Faaliyet raporu
          </Link>
        }
      />
      {save.error && (
        <div className="mb-4">
          <Callout tone="danger">{save.error.message}</Callout>
        </div>
      )}
      <form
        id="operations-settings-form"
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, {
            onSuccess: () => toast.success('İşletim ayarları kaydedildi.'),
          });
        }}
      >
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <DocumentSettingsSection settings={settings} edit={edit} onChange={patch => setSettings(current => ({ ...current, ...patch }))} />
          <Card>
            <CardHeader
              title="Dosya yükleme sınırları"
              description="Sınırlar yeni yüklemelere uygulanır; eski dosyalar erişilebilir kalır."
              action={<Upload className="size-4 text-muted" />}
            />
            <div className="space-y-4 p-5">
              <Field
                label="Belge arşivi: dosya başına MB"
                hint="Fatura, sözleşme ve personel belgeleri. 1–100 MB."
              >
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={100}
                    required
                    disabled={!edit}
                    value={settings.documentLimitMb}
                    onChange={(e) => change('documentLimitMb', Number(e.target.value))}
                  />
                )}
              </Field>
              <Field
                label="Saha / plan / model: dosya başına MB"
                hint="Fotoğraf, PDF çizim ve IFC dosyaları. 1–25 MB."
              >
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={25}
                    required
                    disabled={!edit}
                    value={settings.fieldLimitMb}
                    onChange={(e) => change('fieldLimitMb', Number(e.target.value))}
                  />
                )}
              </Field>
              <Link to="/workspace/documents" className="link text-sm">
                Belge arşivini aç
              </Link>
            </div>
          </Card>
          <Card>
            <CardHeader
              title="Şirket güvenliği"
              description="Tüm üyeler için iki adımlı doğrulama."
              action={<ShieldCheck className="size-4 text-muted" />}
            />
            <div className="space-y-4 p-5">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4"
                  checked={settings.requireMfa}
                  disabled={!edit}
                  onChange={(e) => change('requireMfa', e.target.checked)}
                />
                <span>
                  MFA zorunlu olsun
                  <span className="mt-1 block text-xs text-muted">
                    MFA kurmamış üyeler şirket kayıtlarına erişmeden önce hesap güvenliğinde
                    kurulumu tamamlar. Zorunluluk açıkken MFA kapatılamaz.
                  </span>
                </span>
              </label>
              <Link to="/account/security" className="link text-sm">
                Hesap güvenliğini aç
              </Link>
            </div>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader
              title="Merkez Bankası günlük kur işlemi"
              description="XML dosyası doğrudan sunucudan indirilir ve bankanın yayın tarihiyle saklanır."
              action={<Landmark className="size-4 text-muted" />}
            />
            <div className="grid gap-5 p-5 lg:grid-cols-2">
              <div className="space-y-4">
                {data.rateSource ? (
                  <>
                    <p className="text-sm">{data.rateProviderLabel}</p>
                    <a
                      className="link block break-all text-sm"
                      href={data.rateSource}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {data.rateSource}
                    </a>
                  </>
                ) : (
                  <Callout>Resmî kur için şirket çalışma ülkesini seçin.</Callout>
                )}
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-4"
                    checked={settings.automaticRates}
                    disabled={!edit || !can('rates.manage') || !data.rateSource}
                    onChange={(e) => change('automaticRates', e.target.checked)}
                  />
                  <span>
                    Günlük otomatik kur indir
                    <span className="mt-1 block text-xs text-muted">
                      {data.timeZone} saatine göre çalışır. Elle girilen aynı gün/para birimi
                      kurları korunur. TCMB güncel bülteni için 16:00 veya sonrası seçilebilir.
                    </span>
                  </span>
                </label>
                <Field label="İlk deneme saati (0–23)">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      max={23}
                      required
                      value={settings.rateHour}
                      disabled={!edit}
                      onChange={(e) => change('rateHour', Number(e.target.value))}
                    />
                  )}
                </Field>
              </div>
              <div className="space-y-4">
                <Callout>
                  GBP, EUR ve USD, TRY karşılığıyla kaydedilir. Tatil gününde yeni kur yoksa son
                  yayın tarihi görünür; bağlantı hatası mali kayda sıfır kur yazmaz.
                </Callout>
                {can('rates.manage') && (
                  <Button
                    size="sm"
                    loading={rates.isPending}
                    onClick={() =>
                      rates.mutate(undefined, {
                        onSuccess: (r) =>
                          r.status === 'failed'
                            ? toast.error(r.error ?? 'Kur indirilemedi.')
                            : toast.success('Kurlar kontrol edildi ve kaydedildi.'),
                      })
                    }
                  >
                    <RefreshCw className="size-4" />
                    Şimdi kontrol et
                  </Button>
                )}
                {rates.error && <Callout tone="danger">{rates.error.message}</Callout>}
                <Link to="/settings/currencies" className="link block text-sm">
                  Kur tablosu ve elle XML yükleme
                </Link>
              </div>
            </div>
          </Card>
        </div>
        {edit && (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" loading={save.isPending}>
              Ayarları kaydet
            </Button>
            <span className="text-xs text-muted">
              Sürüm {data.version} · eşzamanlı değişiklik kontrolü
            </span>
          </div>
        )}
      </form>
      <Card className="mt-6 overflow-hidden">
        <CardHeader
          title="Otomatik işlem geçmişi"
          description="Son 30 deneme; başarısız işlemler hata nedeni ile saklanır."
        />
        <TableWrap className="rounded-none border-0">
          <Table>
            <thead>
              <Tr>
                <Th>İşlem</Th>
                <Th>Başlangıç</Th>
                <Th>Sonuç</Th>
                <Th>Ayrıntı</Th>
              </Tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    {r.kind === 'rates'
                      ? 'Kur indirme'
                      : r.kind === 'backup'
                        ? 'Yedekleme'
                        : r.kind}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {new Date(r.startedAt).toLocaleString('tr-TR')}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        r.status === 'failed'
                          ? 'danger'
                          : r.status === 'succeeded'
                            ? 'success'
                            : 'neutral'
                      }
                    >
                      {r.status === 'failed'
                        ? 'Başarısız'
                        : r.status === 'succeeded'
                          ? 'Tamamlandı'
                          : 'Çalışıyor'}
                    </Badge>
                  </Td>
                  <Td className="max-w-96 break-words text-xs text-muted">
                    {r.error ??
                      [
                        r.result.date,
                        r.result.imported ? r.result.imported.length + ' kur' : '',
                        r.result.skipped?.join(', '),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
        {!data.runs.length && (
          <p className="p-5 text-sm text-muted">Henüz bir otomatik işlem çalışmadı.</p>
        )}
      </Card>
      <Card className="mt-5">
        <CardHeader
          title="Yedekleme ve geri yükleme"
          description="Veritabanı ve özel dosya deposu birlikte korunur."
          action={<HardDrive className="size-4 text-muted" />}
        />
        <div className="p-5">
          <Link to="/settings/backups" className="link text-sm">
            Yedekleme merkezini aç
          </Link>
        </div>
      </Card>
    </>
  );
}
