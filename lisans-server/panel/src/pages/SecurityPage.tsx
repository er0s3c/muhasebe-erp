import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@ui/Badge';
import { Button } from '@ui/Button';
import { Card, CardHeader, PageHeader } from '@ui/Card';
import { Callout, EmptyState, ErrorState, PageLoading } from '@ui/Feedback';
import { Field, Input } from '@ui/Field';
import { Modal } from '@ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '@ui/Table';
import { useToast } from '@ui/Toast';
import { markFormSaved } from '@ui/UnsavedChanges';
import { api, errorText, type Passkey } from '../api';
import { fmtDateTime } from '../format';
import { addPasskey, passkeyErrorText, passkeysSupported } from '../passkey';

/** Yöneticinin kendi giriş anahtarları (passkey): ekle, listele, sil. TOTP yenileme `cli admin:reset` iledir. */
export function SecurityPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isPending, error: queryError, refetch, isFetching } = useQuery({ queryKey: ['passkeys'], queryFn: () => api<{ passkeys: Passkey[] }>('/admin/api/passkeys') });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('Vaultwarden');
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['passkeys'] });

  const add = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await addPasskey(name);
      markFormSaved(nameRef.current);
      toast.success('Giriş anahtarı eklendi.');
      setAdding(false);
      await refresh();
    } catch (e) {
      setError(passkeyErrorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await api(`/admin/api/passkeys/${removing.id}`, { method: 'DELETE' });
      toast.success('Giriş anahtarı silindi.');
      setRemoving(null);
      await refresh();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Güvenlik" description="Yönetici hesabınızın giriş yöntemleri." />
      <Card>
        <CardHeader
          title="Giriş anahtarları"
          description="Vaultwarden/Bitwarden eklentisi, telefon ya da donanım anahtarında saklanan passkey'ler. Girişte parola ve kodun yerini tutar."
          action={
            passkeysSupported() && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setError(null);
                  setAdding(true);
                }}
              >
                <KeyRound className="size-4" aria-hidden /> Ekle
              </Button>
            )
          }
        />
        {queryError ? <ErrorState description={errorText(queryError)} onRetry={() => void refetch()} retrying={isFetching} /> : isPending || !data ? (
          <PageLoading />
        ) : data.passkeys.length === 0 ? (
          <EmptyState title="Henüz giriş anahtarı yok" description="Bir anahtar ekleyin; sonraki girişler tek tıkla olur." />
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>Ad</Th>
                  <Th>Tür</Th>
                  <Th>Eklenme</Th>
                  <Th>Son kullanım</Th>
                  <Th className="text-right">İşlemler</Th>
                </tr>
              </thead>
              <tbody>
                {data.passkeys.map((p) => (
                  <Tr key={p.id} data-testid={`passkey-${p.name}`}>
                    <Td>{p.name}</Td>
                    <Td>{p.backedUp ? <Badge tone="brand">Eşitlenen (kasa)</Badge> : <Badge>Tek cihaz</Badge>}</Td>
                    <Td className="whitespace-nowrap">{fmtDateTime(p.createdAt)}</Td>
                    <Td className="whitespace-nowrap">{fmtDateTime(p.lastUsedAt)}</Td>
                    <Td className="text-right">
                      <Button size="sm" variant="danger" onClick={() => setRemoving(p)}>
                        Sil
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
      <Card className="mt-6">
        <CardHeader title="Doğrulama uygulaması (TOTP)" description="Parolayla girişte istenen 6 haneli kod. Kaybolursa sunucuda cli admin:reset komutuyla parola ve anahtar yenilenir; giriş anahtarları da silinir." />
      </Card>

      <Modal
        open={adding}
        onOpenChange={setAdding}
        title="Giriş anahtarı ekle"
        description="Devam edince tarayıcı ya da Vaultwarden eklentisi anahtarı nereye kaydedeceğinizi sorar."
        footer={
          <>
            <Button disabled={busy} onClick={() => setAdding(false)}>Vazgeç</Button>
            <Button variant="primary" loading={busy} onClick={() => void add()}>
              Devam
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label="Anahtarın adı" hint="Listede ayırt etmek için (ör. Vaultwarden, iPhone, YubiKey).">
            {(id) => <Input ref={nameRef} id={id} autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        </div>
      </Modal>

      <Modal
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Giriş anahtarını sil"
        description={removing ? `“${removing.name}” artık girişte kullanılamaz.` : undefined}
        footer={
          <>
            <Button disabled={busy} onClick={() => setRemoving(null)}>Vazgeç</Button>
            <Button variant="danger" loading={busy} onClick={() => void remove()}>
              Sil
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">Vaultwarden'daki kayıt kendiliğinden silinmez; isterseniz kasadan da kaldırın.</p>
      </Modal>
    </>
  );
}
