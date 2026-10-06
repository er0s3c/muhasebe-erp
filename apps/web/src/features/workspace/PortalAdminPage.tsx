import { Plus, Link2, Copy, ShieldCheck } from 'lucide-react';
import { Sheet } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { Badge } from '../../components/ui/Badge';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { useState } from 'react';
import type { SearchHit } from '@erp/shared';
import { useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { PageHeader, Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { RecordPicker } from './RecordPicker';
export function PortalAdminPage() {
  const company = useCompany();
  return <PortalAdminContent key={company.id} />;
}
function PortalAdminContent() {
  const [formOpen, setFormOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [record, setRecord] = useState<SearchHit | null>(null);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [days, setDays] = useState(7);
  const [selected, setSelected] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const links = useCQuery<{
    items: {
      id: string;
      label: string;
      partyName: string;
      expiresAt: string;
      revokedAt: string | null;
    }[];
  }>(['portal-links'], '/api/workspace/portal-links');
  const documents = useCQuery<{ items: { id: string; filename: string }[] }>(
    ['record-documents', 'party', record?.id],
    record ? `/api/workspace/documents?kind=party&id=${record.id}` : null,
  );
  const create = useCMutation(
    (_v: void, call) =>
      call<{ token: string }>('/api/workspace/portal-links', {
        method: 'POST',
        body: { partyId: record?.id, label, password, days, documentIds: selected },
      }),
    [['portal-links']],
  );
  const revoke = useCMutation(
    (id: string, call) => call(`/api/workspace/portal-links/${id}/revoke`, { method: 'POST' }),
    [['portal-links']],
  );
  return (
    <>
      <PageHeader
        title="Portal erişimleri"
        description="Müşteri ve taşeronlara cari, sözleşme ve seçilmiş belgeler için süreli erişim verin."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              create.reset();
              setFormOpen(true);
            }}
          >
            <Plus className="size-4" />
            Yeni erişim
          </Button>
        }
      />
      {(create.error || revoke.error || links.error) && (
        <Callout tone="danger">{(create.error ?? revoke.error ?? links.error)?.message}</Callout>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat label="Aktif erişim">
          {links.data?.items.filter((l) => !l.revokedAt && new Date(l.expiresAt) > new Date())
            .length ?? '—'}
        </Stat>
        <Stat label="Süresi dolmuş">
          {links.data?.items.filter((l) => !l.revokedAt && new Date(l.expiresAt) <= new Date())
            .length ?? '—'}
        </Stat>
        <Stat label="Kapatılan">{links.data?.items.filter((l) => l.revokedAt).length ?? '—'}</Stat>
      </div>
      {url && (
        <Card className="mb-5 space-y-2 p-5">
          <p className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            Bağlantı oluşturuldu
          </p>
          <Input
            readOnly
            aria-label="Portal bağlantısı"
            value={url}
            onFocus={(e) => e.target.select()}
          />
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => setCopied(true));
            }}
          >
            <Copy className="size-4" />
            {copied ? 'Kopyalandı' : 'Bağlantıyı kopyala'}
          </Button>
          <p className="text-sm text-muted">
            Bağlantıyı ve belirlediğiniz parolayı alıcıya iletin. Bağlantı yalnızca bu oluşturma
            işleminde gösterilir.
          </p>
        </Card>
      )}
      <div>
        <Sheet
          open={formOpen}
          onOpenChange={setFormOpen}
          title="Yeni portal erişimi"
          description="Cariyi, parolayı ve paylaşılacak belgeleri belirleyin."
          footer={
            <>
              <Button onClick={() => setFormOpen(false)}>Vazgeç</Button>
              <Button
                type="submit"
                form="portal-form"
                variant="primary"
                loading={create.isPending}
                disabled={!record}
              >
                Erişim oluştur
              </Button>
            </>
          }
        >
          <form
            id="portal-form"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: (r) => {
                  setUrl(`${window.location.origin}/portal#${r.token}`);
                  setPassword('');
                  setFormOpen(false);
                  setCopied(false);
                },
              });
            }}
          >
            {create.error && <Callout tone="danger">{create.error.message}</Callout>}
            <RecordPicker
              kind="party"
              value={record}
              onChange={(r) => {
                setRecord(r);
                setSelected([]);
              }}
            />
            <label className="block text-sm">
              Erişim adı
              <Input
                required
                minLength={2}
                maxLength={120}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Portal parolası (en az 12 karakter)
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Geçerlilik (gün)
              <Input
                type="number"
                min={1}
                max={30}
                required
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </label>
            <fieldset>
              <legend className="mb-2 text-sm">Paylaşılacak belgeler</legend>
              {documents.data?.items.map((d) => (
                <label key={d.id} className="mb-2 flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(d.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, d.id]
                          : selected.filter((id) => id !== d.id),
                      )
                    }
                  />
                  {d.filename}
                </label>
              ))}
              {!documents.data?.items.length && (
                <p className="text-sm text-muted">Cariye bağlı paylaşılabilecek belge yok.</p>
              )}
            </fieldset>
          </form>
        </Sheet>
        <section className="space-y-3">
          {links.isPending && <PageLoading />}
          {links.data?.items.length === 0 && (
            <Card>
              <EmptyState
                icon={<Link2 className="size-5" />}
                title="Henüz erişim oluşturulmadı"
                description="Paylaşacağınız cari ve belgeleri seçerek başlayın."
              />
            </Card>
          )}
          {links.data?.items.map((l) => (
            <Card key={l.id} className="space-y-2 p-4">
              <div className="flex flex-wrap justify-between gap-3">
                <h2 className="text-base">
                  {l.label} · {l.partyName}
                </h2>
                <Badge
                  tone={l.revokedAt || new Date(l.expiresAt) <= new Date() ? 'neutral' : 'success'}
                >
                  {l.revokedAt
                    ? 'Kapatıldı'
                    : new Date(l.expiresAt) <= new Date()
                      ? 'Süresi doldu'
                      : 'Aktif'}
                </Badge>
              </div>
              <p className="text-sm text-muted">
                Geçerlilik sonu: {new Date(l.expiresAt).toLocaleString('tr-TR')}
              </p>
              {l.revokedAt ? (
                <p className="text-sm">Erişim kapatıldı.</p>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(l.id)}
                >
                  Erişimi kapat
                </Button>
              )}
            </Card>
          ))}
        </section>
      </div>
    </>
  );
}
