import { Plus, Link2, Copy, ShieldCheck } from 'lucide-react';
import { Sheet } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { Badge } from '../../components/ui/Badge';
import { EmptyState, ErrorState, PageLoading } from '../../components/ui/Feedback';
import { errorMessage } from '../../lib/errors';
import { useState } from 'react';
import { EMPTY_PORTAL_SCOPES, PORTAL_SCOPE_LABELS, type PortalDocumentScopes, type SearchHit } from '@erp/shared';
import { useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { PageHeader, Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { RecordPicker } from './RecordPicker';
import { PortalScopePicker } from './PortalScopePicker';
type PortalLink = { id: string; label: string; partyName: string; expiresAt: string; revokedAt: string | null; scopes: PortalDocumentScopes };
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
  const [copyError, setCopyError] = useState('');
  const [scopes, setScopes] = useState<PortalDocumentScopes>(EMPTY_PORTAL_SCOPES);
  const [editing, setEditing] = useState<{ link: PortalLink; mode: 'scopes' | 'rotate' } | null>(null);
  const links = useCQuery<{
    items: PortalLink[];
    availableScopes: PortalDocumentScopes;
    canShare: boolean;
  }>(['portal-links'], '/api/workspace/portal-links');
  const documents = useCQuery<{ items: { id: string; filename: string }[] }>(
    ['record-documents', 'party', record?.id],
    record ? `/api/workspace/documents?kind=party&id=${record.id}` : null,
  );
  const create = useCMutation(
    (_v: void, call) =>
      call<{ token: string }>('/api/workspace/portal-links', {
        method: 'POST',
        body: { partyId: record?.id, label, password, days, documentIds: selected, scopes },
      }),
    [['portal-links']],
  );
  const revoke = useCMutation(
    (id: string, call) => call(`/api/workspace/portal-links/${id}/revoke`, { method: 'POST' }),
    [['portal-links']],
  );
  const updateScopes = useCMutation((id: string, call) => call(`/api/workspace/portal-links/${id}`, { method: 'PATCH', body: { scopes } }), [['portal-links']]);
  const rotate = useCMutation((id: string, call) => call<{ token: string }>(`/api/workspace/portal-links/${id}/rotate`, { method: 'POST', body: { password, days } }), [['portal-links']]);
  const showLink = (token: string) => { setUrl(`${window.location.origin}/portal#${token}`); setPassword(''); setCopied(false); setCopyError(''); };
  const available = links.data?.availableScopes ?? EMPTY_PORTAL_SCOPES;
  return (
    <>
      <PageHeader
        title="Portal erişimleri"
        description="Müşteri ve taşeronlara cari, sözleşme ve seçtiğiniz satış belgeleri için süreli, parolalı erişim verin."
        actions={
          <Button
            variant="primary"
            disabled={!links.data?.canShare}
            onClick={() => {
              create.reset();
              setScopes(EMPTY_PORTAL_SCOPES); setPassword(''); setSelected([]); setRecord(null); setLabel(''); setDays(7);
              setFormOpen(true);
            }}
          >
            <Plus className="size-4" />
            Yeni erişim
          </Button>
        }
      />
      {links.data?.canShare === false && <Callout>Portal paylaşımı için tüm şubelere erişiminiz olmalı, tüm şubeler seçilmeli ve cari dışa aktarma yetkisi açık olmalı.</Callout>}
      {(create.error || revoke.error) && (
        <Callout tone="danger">{(create.error ?? revoke.error)?.message}</Callout>
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
              void navigator.clipboard.writeText(url).then(() => { setCopied(true); setCopyError(''); }).catch(() => setCopyError('Bağlantı kopyalanamadı. Alanı seçip elle kopyalayabilirsiniz.'));
            }}
          >
            <Copy className="size-4" />
            {copied ? 'Kopyalandı' : 'Bağlantıyı kopyala'}
          </Button>
          {copyError && <Callout tone="danger">{copyError}</Callout>}
          <p className="text-sm text-muted">
            Bağlantıyı ve belirlediğiniz parolayı alıcıya iletin. Bağlantı yalnızca bu oluşturma
            veya yenileme işleminde gösterilir. Yenileme eski bağlantıyı ve eski parolayı hemen geçersiz kılar.
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
              if (create.isPending) return;
              create.mutate(undefined, {
                onSuccess: (r) => {
                  showLink(r.token);
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
            <PortalScopePicker value={scopes} available={available} onChange={setScopes} />
            <fieldset>
              <legend className="mb-2 text-sm">Cari arşivinden seçilen dosyalar</legend>
              {record && documents.error && <ErrorState description={errorMessage(documents.error)} onRetry={() => void documents.refetch()} retrying={documents.isFetching} />}
              {record && !documents.error && documents.isPending && <PageLoading />}
              {!documents.error && documents.data?.items.map((d) => (
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
              {record && !documents.error && !documents.isPending && !documents.data?.items.length && (
                <p className="text-sm text-muted">Cariye bağlı paylaşılabilecek belge yok.</p>
              )}
            </fieldset>
          </form>
        </Sheet>
        <Sheet open={!!editing} onOpenChange={open => { if (!open) { setEditing(null); setPassword(''); } }} title={editing?.mode === 'rotate' ? 'Bağlantıyı ve parolayı yenile' : 'Belge kapsamını düzenle'} description={editing ? `${editing.link.label} · ${editing.link.partyName}` : undefined} footer={<><Button onClick={() => { setEditing(null); setPassword(''); }}>Vazgeç</Button><Button type="submit" form="portal-edit-form" variant="primary" loading={updateScopes.isPending || rotate.isPending}>Kaydet</Button></>}>
          <form id="portal-edit-form" className="space-y-4" onSubmit={event => { event.preventDefault(); if (!editing || updateScopes.isPending || rotate.isPending) return; if (editing.mode === 'scopes') updateScopes.mutate(editing.link.id, { onSuccess: () => setEditing(null) }); else rotate.mutate(editing.link.id, { onSuccess: value => { showLink(value.token); setEditing(null); } }); }}>
            {(updateScopes.error || rotate.error) && <Callout tone="danger">{(updateScopes.error ?? rotate.error)?.message}</Callout>}
            {editing?.mode === 'scopes' ? <PortalScopePicker value={scopes} available={available} onChange={setScopes} /> : <><Callout>Eski bağlantı ve parola hemen geçersiz olur. Yeni bağlantıyı ve parolayı alıcıya tekrar iletin.</Callout><label className="block text-sm">Yeni portal parolası<Input required type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></label><label className="block text-sm">Yeni geçerlilik (gün)<Input required type="number" min={1} max={30} value={days} onChange={e => setDays(Number(e.target.value))} /></label></>}
          </form>
        </Sheet>
        <section className="space-y-3">
          {links.error && <ErrorState description={errorMessage(links.error)} onRetry={() => void links.refetch()} retrying={links.isFetching} />}
          {!links.error && links.isPending && <PageLoading />}
          {!links.error && links.data?.items.length === 0 && (
            <Card>
              <EmptyState
                icon={<Link2 className="size-5" />}
                title="Henüz erişim oluşturulmadı"
                description="Paylaşacağınız cari ve belgeleri seçerek başlayın."
              />
            </Card>
          )}
          {!links.error && links.data?.items.map((l) => (
            <Card key={l.id} className="space-y-2 p-4">
              <div className="flex flex-wrap justify-between gap-3">
                <h2 className="min-w-0 break-words text-base">
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
              <div className="flex flex-wrap gap-2">{(Object.entries(PORTAL_SCOPE_LABELS) as [keyof PortalDocumentScopes, string][]).filter(([key]) => l.scopes?.[key]).map(([key, text]) => <Badge key={key}>{text}</Badge>)}{!Object.values(l.scopes ?? EMPTY_PORTAL_SCOPES).some(Boolean) && <span className="text-xs text-muted">Satış belgesi paylaşımı kapalı</span>}</div>
              {l.revokedAt ? (
                <p className="text-sm">Erişim kapatıldı.</p>
              ) : (
                <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!links.data?.canShare} onClick={() => { updateScopes.reset(); rotate.reset(); setScopes(l.scopes ?? EMPTY_PORTAL_SCOPES); setEditing({ link: l, mode: 'scopes' }); }}>Kapsamı düzenle</Button><Button size="sm" disabled={!links.data?.canShare} onClick={() => { updateScopes.reset(); rotate.reset(); setPassword(''); setDays(7); setEditing({ link: l, mode: 'rotate' }); }}>Bağlantıyı yenile</Button><Button
                  size="sm"
                  variant="danger"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(l.id)}
                >
                  Erişimi kapat
                </Button></div>
              )}
            </Card>
          ))}
        </section>
      </div>
    </>
  );
}
