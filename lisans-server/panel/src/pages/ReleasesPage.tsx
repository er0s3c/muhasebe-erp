import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@ui/Badge';
import { Button } from '@ui/Button';
import { Card, CardHeader, PageHeader } from '@ui/Card';
import { Callout, EmptyState, PageLoading } from '@ui/Feedback';
import { Field, Input, Textarea } from '@ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '@ui/Table';
import { api, ApiError, errorText } from '../api';
import { fmtDateTime } from '../format';

type Target = 'linux-x64' | 'win-x64';
interface ReleaseFile {
  target: Target;
  name: string;
  sha256: string;
  size: number;
}
interface Release {
  id: string;
  version: string;
  notes: string;
  status: 'draft' | 'published' | 'withdrawn';
  sourceCommit: string | null;
  ciRun: string | null;
  testsPassed: boolean;
  installerFile: { name: string; sha256: string; size: number } | null;
  installerSignature: string | null;
  manifest: string | null;
  files: ReleaseFile[];
  createdAt: string;
  publishedAt: string | null;
  sentLicenses: number;
  installedActivations: number;
}
interface UpdateTarget {
  id: string;
  customer: string;
  codePrefix: string;
  kind: string;
  updateVersion: string | null;
  updateSentAt: string | null;
  installations: { appVersion: string | null; platform: string | null; lastSeenAt: string }[];
}

const STATUS = { draft: ['Taslak', 'neutral'], published: ['Yayımda', 'success'], withdrawn: ['Geri çekildi', 'danger'] } as const;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const fileName = (version: string, t: Target) => `muhasebe-erp-${version}-${t}.${t === 'win-x64' ? 'zip' : 'tar.gz'}`;

/** Kit arşivini sunucuya parça parça yükler (sunucunun istek zaman aşımı kısa); bozulursa sunucunun beklediği konumdan sürdürür. */
async function uploadFile(release: Release, file: File, chunkBytes: number, onProgress: (p: number) => void) {
  let offset = 0;
  while (offset < file.size || file.size === 0) {
    const end = Math.min(offset + chunkBytes, file.size);
    const final = end >= file.size;
    const res = await fetch(`/admin/api/releases/${release.id}/files/${encodeURIComponent(file.name)}?offset=${offset}${final ? `&final=1&size=${file.size}` : ''}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-requested-with': 'erp-license-admin' },
      credentials: 'same-origin',
      body: file.slice(offset, end),
    });
    const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: { expectedOffset?: number } } } | null;
    if (res.status === 409 && json?.error?.code === 'RELEASE_UPLOAD_OFFSET' && typeof json.error.details?.expectedOffset === 'number') {
      offset = json.error.details.expectedOffset;
      continue;
    }
    if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? `Yükleme başarısız (${res.status})`);
    offset = end;
    onProgress(file.size ? offset / file.size : 1);
    if (final) break;
  }
}

export function ReleasesPage() {
  const qc = useQueryClient();
  const { data, isPending } = useQuery({ queryKey: ['releases'], queryFn: () => api<{ releases: Release[]; chunkBytes: number }>('/admin/api/releases') });
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['releases'] });

  const create = useMutation({
    mutationFn: () => api<{ release: Release }>('/admin/api/releases', { method: 'POST', body: { version: version.trim(), notes } }),
    onSuccess: (r) => {
      setVersion('');
      setNotes('');
      setError(null);
      setSelected(r.release.id);
      void refresh();
    },
    onError: (e) => setError(errorText(e)),
  });

  if (isPending || !data) return <PageLoading />;
  const current = data.releases.find((r) => r.id === selected) ?? null;

  return (
    <>
      <PageHeader
        title="Sürümler ve uzaktan güncelleme"
        description="Kit arşivlerini (npm run release) yükleyin, yayımlayın ve müşterilere tek tıkla gönderin. Müşteride kurulum sahibi onaylayınca güncelleyici yedek alıp uygular; sorun çıkarsa önceki sürüme döner."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-6">
          {data.releases.length === 0 ? (
            <TableWrap>
              <EmptyState title="Henüz sürüm yok" description="Sağdaki formdan ilk sürümü oluşturun." />
            </TableWrap>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Sürüm</Th>
                    <Th>Durum</Th>
                    <Th>Kitler</Th>
                    <Th>Yayım</Th>
                    <Th num>Gönderilen lisans</Th>
                    <Th num>Bu sürümde kurulum</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.releases.map((r) => (
                    <Tr key={r.id} clickable tabIndex={0} onClick={() => setSelected(r.id)} onKeyDown={(e) => e.key === 'Enter' && setSelected(r.id)} className={r.id === selected ? 'bg-surface-2' : undefined}>
                      <Td className="font-mono text-[13px]">{r.version}</Td>
                      <Td>
                        <Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge>
                      </Td>
                      <Td className="text-muted">{r.files.map((f) => f.target).join(', ') || '—'}</Td>
                      <Td className="whitespace-nowrap text-muted">{r.publishedAt ? fmtDateTime(r.publishedAt) : '—'}</Td>
                      <Td num>{r.sentLicenses}</Td>
                      <Td num>{r.installedActivations}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          {current && <ReleaseDetail key={current.id} release={current} chunkBytes={data.chunkBytes} onChange={() => void refresh()} />}
        </div>

        <Card className="h-fit">
          <CardHeader title="Yeni sürüm" />
          <form
            className="flex flex-col gap-4 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            {error && <Callout tone="danger">{error}</Callout>}
            <Field label="Sürüm numarası" hint="Kitin sürümüyle aynı olmalı (ör. 1.2.0)">
              {(id) => <Input id={id} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.2.0" />}
            </Field>
            <Field label="Sürüm notu" hint="Müşterinin güncelleme ekranında görünür">
              {(id) => <Textarea id={id} rows={5} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version.trim())}>
              Taslak oluştur
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}

function ReleaseDetail({ release, chunkBytes, onChange }: { release: Release; chunkBytes: number; onChange: () => void }) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [installerLink, setInstallerLink] = useState<string | null>(null);
  const share = useMutation({ mutationFn: () => api<{ url: string; sha256: string }>(`/admin/api/releases/${release.id}/installer-link`, { method: 'POST', body: {} }), onSuccess: (r) => { setInstallerLink(r.url); setError(null); }, onError: (e) => setError(errorText(e)) });
  const targets = useQuery({
    queryKey: ['update-targets'],
    queryFn: () => api<{ licenses: UpdateTarget[] }>('/admin/api/update-targets'),
    enabled: release.status === 'published',
  });
  const act = useMutation({
    mutationFn: (v: { path: string; body?: unknown }) => api(v.path, { method: 'POST', body: v.body ?? {} }),
    onSuccess: () => {
      setError(null);
      setPicked(new Set());
      onChange();
      void qc.invalidateQueries({ queryKey: ['update-targets'] });
    },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/admin/api/releases/${release.id}`, { method: 'DELETE' }),
    onSuccess: onChange,
    onError: (e) => setError(errorText(e)),
  });

  const upload = async (files: FileList | null) => {
    setError(null);
    for (const f of Array.from(files ?? [])) {
      try {
        setProgress((p) => ({ ...p, [f.name]: 0 }));
        await uploadFile(release, f, chunkBytes, (x) => setProgress((p) => ({ ...p, [f.name]: x })));
      } catch (e) {
        setError(`${f.name}: ${errorText(e)}`);
      } finally {
        setProgress((p) => {
          const n = { ...p };
          delete n[f.name];
          return n;
        });
        onChange();
      }
    }
  };
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Card>
      <CardHeader title={`Sürüm ${release.version}`} description={release.notes || 'Not yok'} />
      <div className="flex flex-col gap-4 p-4 text-sm">
        {error && <Callout tone="danger">{error}</Callout>}
        {release.manifest && <Button variant="secondary" onClick={() => { const url = URL.createObjectURL(new Blob([release.manifest!], { type: 'text/plain' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `muhasebe-erp-${release.version}.manifest`; anchor.click(); URL.revokeObjectURL(url); }}>Çevrimdışı güncelleme için imzalı manifestoyu indir</Button>}
        {release.sourceCommit && <div className="rounded-xl border border-border bg-surface-2 p-3"><p className="text-muted">Kaynak commit</p><p className="break-all font-mono text-xs">{release.sourceCommit}</p><p className="mt-2">{release.testsPassed ? 'CI testleri geçti' : 'CI test kanıtı yok'} · Çalıştırma {release.ciRun ?? '—'}</p></div>}
        {release.installerFile && <div className="rounded-xl border border-border p-3"><p>Windows görsel kurulum · {mb(release.installerFile.size)}</p><p className="my-2 break-all font-mono text-xs text-muted">SHA-256: {release.installerFile.sha256}</p>{release.status === 'published' && <Button variant="secondary" loading={share.isPending} onClick={() => share.mutate()}>24 saatlik müşteri indirme bağlantısı oluştur</Button>}{installerLink && <a href={installerLink} className="mt-2 block break-all link">{installerLink}</a>}{release.installerSignature && <details className="mt-2"><summary>Satıcı imzası</summary><p className="break-all font-mono text-xs">{release.installerSignature}</p></details>}</div>}
        <ul className="flex flex-col gap-2">
          {(['linux-x64', 'win-x64'] as const).map((t) => {
            const f = release.files.find((x) => x.target === t);
            const name = fileName(release.version, t);
            return (
              <li key={t} className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-muted">{t === 'win-x64' ? 'Windows' : 'Linux/WSL'}</span>
                {f ? (
                  <>
                    <span className="font-mono text-[13px]">{f.name}</span>
                    <span className="text-muted">{mb(f.size)}</span>
                    <code className="text-xs text-muted" title={f.sha256}>
                      {f.sha256.slice(0, 12)}…
                    </code>
                  </>
                ) : progress[name] !== undefined ? (
                  <span>yükleniyor… %{Math.round((progress[name] ?? 0) * 100)}</span>
                ) : (
                  <span className="text-muted">yüklenmedi ({name})</span>
                )}
              </li>
            );
          })}
        </ul>

        {release.status === 'draft' && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 hover:bg-surface-2">
              <Upload className="size-4" aria-hidden />
              Kit arşivi seç
              <input type="file" className="sr-only" accept=".zip,.gz" multiple onChange={(e) => void upload(e.target.files)} aria-label="Kit arşivi" />
            </label>
            <Button variant="primary" loading={act.isPending} disabled={release.files.length === 0} onClick={() => act.mutate({ path: `/admin/api/releases/${release.id}/publish` })}>
              Yayımla (imzala)
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Taslağı sil
            </Button>
          </div>
        )}

        {release.status === 'published' && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={act.isPending} disabled={picked.size === 0} onClick={() => act.mutate({ path: `/admin/api/releases/${release.id}/send`, body: { licenseIds: [...picked] } })}>
                Seçilenlere gönder ({picked.size})
              </Button>
              <Button loading={act.isPending} onClick={() => act.mutate({ path: `/admin/api/releases/${release.id}/send`, body: { all: true } })}>
                Tüm etkin lisanslara gönder
              </Button>
              <Button disabled={picked.size === 0} onClick={() => act.mutate({ path: '/admin/api/update-targets/cancel', body: { licenseIds: [...picked] } })}>
                Seçilenlerden geri al
              </Button>
              <Button variant="danger" onClick={() => act.mutate({ path: `/admin/api/releases/${release.id}/withdraw` })}>
                Sürümü geri çek
              </Button>
            </div>
            {targets.isPending ? (
              <PageLoading />
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-10" />
                      <Th>Müşteri</Th>
                      <Th>Lisans</Th>
                      <Th>Kurulumlar (sürüm, platform)</Th>
                      <Th>Gönderilen</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(targets.data?.licenses ?? []).map((l) => (
                      <Tr key={l.id} clickable onClick={() => toggle(l.id)}>
                        <Td>
                          <input type="checkbox" className="size-4" checked={picked.has(l.id)} onChange={() => toggle(l.id)} onClick={(e) => e.stopPropagation()} aria-label={l.customer} />
                        </Td>
                        <Td>{l.customer}</Td>
                        <Td className="font-mono text-[13px] text-muted">{l.codePrefix}…</Td>
                        <Td className="text-muted">
                          {l.installations.length === 0 ? '—' : l.installations.map((i) => `${i.appVersion ?? '?'} (${i.platform ?? 'elle kurulum'})`).join(', ')}
                        </Td>
                        <Td>{l.updateVersion ? <Badge tone={l.updateVersion === release.version ? 'success' : 'neutral'}>{l.updateVersion}</Badge> : '—'}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
            <p className="text-xs text-muted">Kurulum bir sonraki kalp atışında (en geç ~12 saat; müşteri "Güncellemeleri denetle" ile hemen alabilir) teklifi görür. "Elle kurulum" platformu bildirmeyen eski/elle kurulumlardır; onlara teklif gitmez.</p>
          </>
        )}
      </div>
    </Card>
  );
}
