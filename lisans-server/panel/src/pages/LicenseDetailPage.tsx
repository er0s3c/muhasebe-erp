import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '@ui/Badge';
import { Button } from '@ui/Button';
import { Card, CardHeader, PageHeader } from '@ui/Card';
import { Callout, EmptyState, ErrorState, PageLoading } from '@ui/Feedback';
import { Field, Input, Textarea } from '@ui/Field';
import { Modal } from '@ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '@ui/Table';
import { useToast } from '@ui/Toast';
import { markFormSaved } from '@ui/UnsavedChanges';
import { api, errorText, type Activation, type License } from '../api';
import { CodeModal } from '../components/CodeModal';
import { LicenseFormSheet } from '../components/LicenseFormSheet';
import { KIND_LABELS, SECTOR_LABELS, STATUS_LABELS, STATUS_TONES, fmtDate, fmtDateTime, fmtDay, toDateInput } from '../format';

interface Detail {
  license: License;
  activations: Activation[];
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border px-5 py-3 last:border-b-0 sm:grid-cols-[220px_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

type Confirm =
  | { kind: 'status'; action: 'suspend' | 'resume' | 'revoke' }
  | { kind: 'code' }
  | { kind: 'deactivate'; activation: Activation }
  | null;

const CONFIRM_COPY = {
  suspend: { title: 'Lisans askıya alınsın mı?', body: 'Müşterinin kurulumları bir sonraki kalp atışında (en geç ~12 saat) salt-okunur moda geçer. Devam ettirerek geri alabilirsiniz.', action: 'Askıya al', danger: false },
  resume: { title: 'Lisans devam ettirilsin mi?', body: 'Kurulumlar bir sonraki kalp atışında yeniden tam işlevli olur.', action: 'Devam ettir', danger: false },
  revoke: { title: 'Lisans iptal edilsin mi?', body: 'Müşterinin kurulumları bir sonraki kalp atışında salt-okunur moda geçer ve yeni etkinleştirme yapılamaz.', action: 'İptal et', danger: true },
} as const;

export function LicenseDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isPending, error, refetch, isFetching } = useQuery({ queryKey: ['license', id], queryFn: () => api<Detail>(`/admin/api/licenses/${id}`) });
  const [editOpen, setEditOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendTo, setExtendTo] = useState('');
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // çevrimdışı imzalama
  const [requestCode, setRequestCode] = useState('');
  const [days, setDays] = useState('90');
  const [lease, setLease] = useState<{ token: string; until: string } | null>(null);
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const pending = useRef(false);
  const extendInput = useRef<HTMLInputElement>(null);
  const offlineInput = useRef<HTMLTextAreaElement>(null);

  if (isPending) return <PageLoading />;
  if (error || !data) return <><PageHeader title="Lisans ayrıntısı" /><ErrorState description={error ? errorText(error) : 'Lisans bulunamadı.'} onRetry={() => void refetch()} retrying={isFetching} /></>;
  const { license: l, activations } = data;

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['license', id] }),
      queryClient.invalidateQueries({ queryKey: ['licenses'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);

  const run = async (fn: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const doConfirm = () =>
    run(async () => {
      if (!confirm) return;
      if (confirm.kind === 'status') {
        await api(`/admin/api/licenses/${id}/${confirm.action}`, { method: 'POST' });
        toast.success('Lisans durumu güncellendi.');
      } else if (confirm.kind === 'code') {
        const res = await api<{ activationCode: string }>(`/admin/api/licenses/${id}/regenerate-code`, { method: 'POST' });
        setCode(res.activationCode);
      } else {
        await api(`/admin/api/activations/${confirm.activation.id}/deactivate`, { method: 'POST' });
        toast.success('Kurulum devre dışı bırakıldı.');
      }
      setConfirm(null);
    });

  const extend = () =>
    run(async () => {
      await api(`/admin/api/licenses/${id}/extend`, { method: 'POST', body: { validUntil: extendTo } });
      markFormSaved(extendInput.current);
      toast.success('Süre uzatıldı.');
      setExtendOpen(false);
    });

  const clearFlag = (a: Activation) =>
    run(async () => {
      await api(`/admin/api/activations/${a.id}/clear-flag`, { method: 'POST' });
      toast.success('Bayrak kaldırıldı.');
    });

  const signOffline = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setOfflineError(null);
    setLease(null);
    try {
      const res = await api<{ lease: string; leaseUntil: string }>(`/admin/api/licenses/${id}/offline-lease`, {
        method: 'POST',
        body: { requestCode: requestCode.trim(), days: Number(days) },
      });
      setLease({ token: res.lease, until: res.leaseUntil });
      markFormSaved(offlineInput.current);
      await refresh();
    } catch (e) {
      setOfflineError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const copyLease = async () => {
    if (!lease) return;
    try {
      await navigator.clipboard.writeText(lease.token);
      toast.success('Kopyalandı.');
    } catch {
      /* pano izni yok */
    }
  };

  const copy = confirm?.kind === 'status' ? CONFIRM_COPY[confirm.action] : null;

  return (
    <>
      <PageHeader
        title={l.customer ?? 'Lisans'}
        description={`${KIND_LABELS[l.kind]} lisans · kod ${l.codePrefix}…`}
        actions={
          <>
            <Link to="/licenses" className="link mr-2 text-sm">← Tüm lisanslar</Link>
            <Button disabled={busy} onClick={() => setEditOpen(true)}>Düzenle</Button>
            <Button disabled={busy} onClick={() => { setExtendTo(toDateInput(l.validUntil)); setExtendOpen(true); }}>Süreyi uzat</Button>
          </>
        }
      />

      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-6">
        <Card>
          <CardHeader
            title="Lisans"
            action={
              <span className="flex flex-wrap gap-2">
                {l.status === 'active' && <Button size="sm" onClick={() => setConfirm({ kind: 'status', action: 'suspend' })}>Askıya al</Button>}
                {l.status !== 'active' && <Button size="sm" onClick={() => setConfirm({ kind: 'status', action: 'resume' })}>Devam ettir</Button>}
                {l.status !== 'revoked' && <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: 'status', action: 'revoke' })}>İptal et</Button>}
                <Button size="sm" onClick={() => setConfirm({ kind: 'code' })}>Yeni kod üret</Button>
              </span>
            }
          />
          <dl>
            <Row label="Durum"><Badge tone={STATUS_TONES[l.status]}>{STATUS_LABELS[l.status]}</Badge></Row>
            <Row label="Sektörler">
              <span className="flex flex-wrap gap-1.5">{l.sectors.map((s) => <Badge key={s} tone="brand">{SECTOR_LABELS[s]}</Badge>)}</span>
            </Row>
            <Row label="Abonelik bitişi">{fmtDay(l.validUntil)}</Row>
            <Row label="Cihaz kotası">{l.deviceLimit} (boşta {l.deviceIdleDays} gün sonra koltuktan düşer)</Row>
            <Row label="Şirket sınırı">{l.companyLimit}</Row>
            <Row label="Sunucu (etkinleştirme) sayısı">{l.maxActivations} · taşıma kullanımı: {l.transfersUsed}</Row>
            <Row label="Kira / tolerans">{l.leaseDays} gün / {l.graceDays} gün</Row>
            <Row label="Çevrimdışı etkinleştirme">{l.offlineAllowed ? 'İzinli' : 'Kapalı'}</Row>
            {l.notes && <Row label="Notlar"><span className="whitespace-pre-wrap">{l.notes}</span></Row>}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Etkinleştirmeler" />
          {activations.length === 0 ? (
            <EmptyState title="Henüz etkinleştirme yok" description="Müşteri kodu girince kurulum burada görünür." />
          ) : (
            <TableWrap className="rounded-none border-0">
              <Table>
                <thead>
                  <tr>
                    <Th>Kurulum</Th>
                    <Th>Sürüm</Th>
                    <Th>Durum</Th>
                    <Th>Son görülme</Th>
                    <Th>Kullanım</Th>
                    <Th className="text-right">İşlemler</Th>
                  </tr>
                </thead>
                <tbody>
                  {activations.map((a) => (
                    <Tr key={a.id} data-testid={`activation-${a.installationId}`}>
                      <Td>
                        <code className="text-xs" title={a.installationId}>{a.installationId.slice(0, 13)}…</code>
                        <span className="block text-xs text-muted">parmak izi {a.fingerprintPrefix}{a.fingerprintChanges > 0 ? ` · ${a.fingerprintChanges} değişim` : ''}</span>
                      </Td>
                      <Td>{a.appVersion}</Td>
                      <Td>
                        <span className="flex flex-wrap gap-1.5">
                          <Badge tone={a.status === 'active' ? 'success' : 'neutral'}>{a.status === 'active' ? 'Etkin' : 'Devre dışı'}</Badge>
                          {a.offline && <Badge>Çevrimdışı</Badge>}
                          {a.flagged && <Badge tone="danger"><span title={a.flagReason ?? undefined}>Klon şüphesi</span></Badge>}
                        </span>
                        {a.flagReason && <span className="mt-1 block max-w-[260px] text-xs text-danger">{a.flagReason}</span>}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {fmtDateTime(a.lastSeenAt)}
                        <span className="block text-xs text-muted">{a.lastIp ?? '—'}</span>
                      </Td>
                      <Td className="whitespace-nowrap">{a.reportedDevices} cihaz · {a.reportedCompanies} şirket</Td>
                      <Td className="text-right">
                        <span className="inline-flex flex-wrap justify-end gap-1.5">
                          {a.flagged && <Button size="sm" variant="ghost" onClick={() => void clearFlag(a)}>Bayrağı kaldır</Button>}
                          {a.status === 'active' && <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: 'deactivate', activation: a })}>Devre dışı bırak</Button>}
                        </span>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>

        <Card>
          <CardHeader title="Çevrimdışı lisans imzala" description="İnternet erişimi olmayan bir sunucu için: müşterinin uygulamasından aldığı istek kodunu yapıştırın." />
          <div className="flex flex-col gap-4 px-5 py-4">
            {!l.offlineAllowed && <Callout tone="warning">Bu lisans çevrimdışı etkinleştirmeye izin vermiyor; önce “Düzenle” ile izin verin.</Callout>}
            {offlineError && <Callout tone="danger">{offlineError}</Callout>}
            <Field label="İstek kodu">
              {(fid) => <Textarea ref={offlineInput} id={fid} rows={4} className="font-mono text-xs" spellCheck={false} value={requestCode} onChange={(e) => setRequestCode(e.target.value)} />}
            </Field>
            <Field label="Geçerlilik (gün)" hint="Bu süre sonunda yeni istek kodu gerekir; abonelik bitişini aşamaz." className="max-w-xs">
              {(fid) => <Input id={fid} type="number" min={1} max={400} value={days} onChange={(e) => setDays(e.target.value)} />}
            </Field>
            <div>
              <Button variant="primary" loading={busy} disabled={requestCode.trim().length < 20 || !l.offlineAllowed} onClick={() => void signOffline()}>
                İmzala
              </Button>
            </div>
            {lease && (
              <div className="flex flex-col gap-2" data-testid="offline-lease">
                <Callout>Müşteriye iletin; kira {fmtDate(lease.until)} tarihine kadar geçerlidir.</Callout>
                <Textarea readOnly rows={5} className="font-mono text-xs" aria-label="İmzalı lisans" value={lease.token} onFocus={(e) => e.currentTarget.select()} />
                <div>
                  <Button size="sm" onClick={() => void copyLease()}>Kopyala</Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      </fieldset>

      <LicenseFormSheet open={editOpen} onOpenChange={setEditOpen} license={l} />
      <CodeModal code={code} onClose={() => setCode(null)} />

      <Modal
        open={extendOpen}
        onOpenChange={(next) => { if (!busy) setExtendOpen(next); }}
        title="Süreyi uzat"
        description="Yeni abonelik bitiş tarihi. Müşteri bir sonraki kalp atışında görür."
        footer={
          <>
            <Button disabled={busy} onClick={() => setExtendOpen(false)}>Vazgeç</Button>
            <Button variant="primary" loading={busy} disabled={!extendTo} onClick={() => void extend()}>Uzat</Button>
          </>
        }
      >
        <Field label="Yeni bitiş tarihi">{(fid) => <Input ref={extendInput} id={fid} type="date" value={extendTo} onChange={(e) => setExtendTo(e.target.value)} />}</Field>
      </Modal>

      <Modal
        open={confirm !== null}
        onOpenChange={(o) => !o && !busy && setConfirm(null)}
        title={copy?.title ?? (confirm?.kind === 'code' ? 'Yeni etkinleştirme kodu üretilsin mi?' : 'Kurulum devre dışı bırakılsın mı?')}
        description={
          copy?.body ??
          (confirm?.kind === 'code'
            ? 'Eski kod geçersiz olur; etkin kurulumlar etkilenmez. Yeni kod yalnızca bir kez gösterilir.'
            : 'Kurulum kotadan düşer (sunucu taşıma). Sunucu bir sonraki kalp atışında lisanssız kalmaz ama yeni etkinleştirme yuvası boşalır; müşteri yeni sunucuda aynı kodla etkinleştirebilir.')
        }
        footer={
          <>
            <Button disabled={busy} onClick={() => setConfirm(null)}>Vazgeç</Button>
            <Button variant={copy?.danger || confirm?.kind === 'deactivate' ? 'danger' : 'primary'} loading={busy} onClick={() => void doConfirm()}>
              {copy?.action ?? (confirm?.kind === 'code' ? 'Kodu üret' : 'Devre dışı bırak')}
            </Button>
          </>
        }
      >
        {confirm?.kind === 'deactivate' && <p className="text-sm text-muted">Kurulum: <code className="text-xs">{confirm.activation.installationId}</code></p>}
      </Modal>
    </>
  );
}
