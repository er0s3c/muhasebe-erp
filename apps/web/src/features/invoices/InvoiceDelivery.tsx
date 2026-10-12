import { Mail, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { BlockedHint, ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { markFormSaved } from '../../components/ui/UnsavedChanges';
import { fmtDateTime } from '../../lib/license';
import { useCanOperation, useCMutation, useCQuery, useIdempotencyKey, usePublicConfig } from '../../lib/queries';
import type { InvoiceDetail } from '../../lib/types';

type DeliveryStatus = 'pending' | 'sending' | 'delivered' | 'dead_letter' | 'cancelled';
interface DeliveryRow {
  id: string;
  recipient: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
  document: { version: string; status: string } | null;
}
interface DeliveriesData { currentVersion: string; partyEmail: string | null; deliveries: DeliveryRow[] }

const STATUS: Record<DeliveryStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  pending: { label: 'Kuyrukta', tone: 'info' },
  sending: { label: 'Gönderiliyor', tone: 'info' },
  delivered: { label: 'Posta sunucusuna teslim edildi', tone: 'success' },
  dead_letter: { label: 'Teslim edilemedi', tone: 'danger' },
  cancelled: { label: 'İptal edildi', tone: 'neutral' },
};

/**
 * Fatura belgesinin e-postayla gönderimi ve gönderim geçmişi (öneri 7). İleti sunucuda kalıcı kuyruğa yazılır; "teslim edildi"
 * posta sunucusunun iletiyi kabul ettiğini gösterir. Gönderilen belge sürümü güncel sürümden farklıysa belge sonradan değişmiştir.
 */
export function InvoiceDelivery({ data }: { data: InvoiceDetail }) {
  const inv = data.invoice;
  const toast = useToast();
  const canExport = useCanOperation()('core.invoices', 'export');
  const mailEnabled = usePublicConfig().data?.mailEnabled ?? false;
  const sendable = inv.status === 'posted' && (inv.type === 'sales' || inv.type === 'sales_return');
  const path = `/api/invoices/${inv.id}/deliveries`;
  const [polling, setPolling] = useState(false);
  const deliveries = useCQuery<DeliveriesData>(['invoices', inv.id, 'deliveries'], path, { refetchInterval: polling ? 10_000 : undefined });
  const rows = deliveries.data?.deliveries ?? [];
  const waiting = rows.some((row) => row.status === 'pending' || row.status === 'sending');
  if (waiting !== polling) setPolling(waiting);

  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const command = useIdempotencyKey();
  const send = useCMutation(
    (body: { to: string; note: string }, call) => call<{ delivery: DeliveryRow }>(path, { method: 'POST', body, idempotencyKey: command.key }),
    [['invoices', inv.id, 'deliveries']],
  );
  const retry = useCMutation(
    (id: string, call) => call<{ delivery: DeliveryRow }>(`${path}/${id}/retry`, { method: 'POST', body: {} }),
    [['invoices', inv.id, 'deliveries']],
  );

  if (!canExport || (!sendable && rows.length === 0)) return null;
  const validTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());

  return (
    <Card className="p-5 print:hidden">
      <section aria-label="E-posta gönderimleri" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">E-posta gönderimleri</h2>
            <p className="text-xs text-muted">Gönderim kuyruktan yapılır; sunucu yeniden başlasa da kaybolmaz, hata olursa yeniden denenir.</p>
          </div>
          {sendable && (
            <div className="flex flex-col items-end gap-1">
              <Button disabled={!mailEnabled} aria-describedby={mailEnabled ? undefined : 'invoice-mail-blocked'} onClick={() => {
                setTo(deliveries.data?.partyEmail ?? ''); setNote(''); setError(null); command.renew(); setOpen(true);
              }}>
                <Mail className="size-4" aria-hidden />E-postayla gönder
              </Button>
              {!mailEnabled && <BlockedHint id="invoice-mail-blocked" blocker={{ reason: 'Bu kurulumda giden e-posta yapılandırılmamış.', ask: 'Sistem yöneticinize başvurun.' }} />}
            </div>
          )}
        </div>
        {deliveries.error ? <ErrorCallout error={deliveries.error} /> : rows.length === 0 ? (
          <p className="text-sm text-muted">Bu fatura henüz e-postayla gönderilmedi.</p>
        ) : (
          <TableWrap>
            <Table>
              <thead><Tr><Th>Alıcı</Th><Th>Durum</Th><Th>Belge sürümü</Th><Th>Kuyruğa alındı</Th><Th /></Tr></thead>
              <tbody>
                {rows.map((row) => {
                  const changed = row.document && row.document.version !== deliveries.data?.currentVersion;
                  return <Tr key={row.id}>
                    <Td className="break-all">{row.recipient}</Td>
                    <Td>
                      <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                      <span className="mt-1 block text-xs text-muted">
                        {row.status === 'delivered' && row.deliveredAt ? fmtDateTime(row.deliveredAt) : `Deneme ${row.attempts}/${row.maxAttempts}`}
                        {row.status === 'pending' && row.attempts > 0 && ` · sonraki deneme ${fmtDateTime(row.nextAttemptAt)}`}
                      </span>
                      {row.lastError && row.status !== 'delivered' && <span className="block text-xs text-danger">{row.lastError}</span>}
                    </Td>
                    <Td>
                      <span className="num text-xs">{row.document?.version ?? '—'}</span>
                      {changed && <span className="block text-xs text-warning">Belge gönderimden sonra değişti</span>}
                    </Td>
                    <Td className="text-xs">{fmtDateTime(row.createdAt)}</Td>
                    <Td className="text-right">
                      {row.status === 'dead_letter' && (
                        <Button size="sm" variant="ghost" loading={retry.isPending && retry.variables === row.id} onClick={() => retry.mutate(row.id, {
                          onSuccess: () => toast.success('Gönderim yeniden denenecek'),
                          onError: (e) => toast.error(e.message),
                        })}>
                          <RotateCcw className="size-3.5" aria-hidden />Yeniden dene
                        </Button>
                      )}
                    </Td>
                  </Tr>;
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </section>

      <Modal open={open} onOpenChange={setOpen} title="Faturayı e-postayla gönder"
        description={`${inv.invoiceNo ?? 'Fatura'} müşteriye satırlar ve tutarlarla birlikte gönderilir. İletinin altında belge sürümü yer alır.`}
        footer={<>
          <Button onClick={() => setOpen(false)}>Vazgeç</Button>
          <Button variant="primary" loading={send.isPending} disabled={!validTo} onClick={(event) => {
            const form = event.currentTarget;
            setError(null);
            send.mutate({ to: to.trim(), note: note.trim() }, {
              onSuccess: () => { markFormSaved(form); command.renew(); setOpen(false); toast.success('Gönderim kuyruğa alındı'); },
              onError: (e) => setError(e),
            });
          }}>Gönder</Button>
        </>}>
        <div className="flex flex-col gap-4">
          {error != null && <ErrorCallout error={error} title="Gönderim kuyruğa alınamadı" discardDraft onNavigate={() => setOpen(false)} />}
          <Field label="Alıcı e-posta adresi" required hint={deliveries.data?.partyEmail ? undefined : 'Cari kartında e-posta yok; adresi elle girin.'}>
            {(id) => <Input id={id} type="email" value={to} maxLength={254} onChange={(e) => setTo(e.target.value)} />}
          </Field>
          <Field label="İleti notu">
            {(id) => <Textarea id={id} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Ör. Ödeme bilgileri için bizimle iletişime geçebilirsiniz." />}
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
