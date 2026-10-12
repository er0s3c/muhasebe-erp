import { useState } from 'react';
import { Download, Plus, ShieldCheck, Send, X } from 'lucide-react';
import { addDaysIso, dec, todayIso, type PaymentBatchStatus } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany, useSession } from '../../lib/session';
import type { TreasuryAccount } from '../../lib/types';

interface Batch {
  id: string;
  batchNo: string;
  accountName: string;
  paymentDate: string;
  status: PaymentBatchStatus;
  currency: string;
  total: string;
  note: string;
  createdBy: string;
  createdByName: string;
  approvedByName: string | null;
  cancelReason: string | null;
}
interface Line {
  id: string;
  partyName: string;
  ibanLast4: string;
  holderName: string;
  bankStatus: string;
  amount: string;
  items: unknown[];
  treasuryTransactionId: string | null;
}
interface Suggestion {
  partyId: string;
  partyName: string;
  total: string;
  oldestDue: string;
  bankAccount: { id: string; ibanLast4: string; holderName: string } | null;
  items: { lineId: string; remaining: string }[];
}
const STATUS: Record<PaymentBatchStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
  draft: { label: 'Taslak', tone: 'neutral' },
  approved: { label: 'Onaylı', tone: 'info' },
  posted: { label: 'Kaydedildi', tone: 'success' },
  cancelled: { label: 'İptal', tone: 'danger' },
};
const invalidate = [['payment-batches'], ['treasury'], ['parties'], ['cash-forecast']];

/**
 * Toplu ödeme (öneri 54): vadesi gelen tedarikçi borçlarından liste hazırlanır; yalnız doğrulanmış IBAN kullanılır,
 * hazırlayandan farklı bir yetkili onaylar, banka dosyası alınır ve kayıtta her satır açık kalemleri kapatan ödeme olur.
 */
export function PaymentBatchesPage() {
  const can = useCan();
  const q = useCQuery<{ batches: Batch[] }>(['payment-batches'], '/api/payment-batches');
  const [creating, setCreating] = useState(false),
    [open, setOpen] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader
        title="Toplu ödeme listeleri"
        description="Hazırla → başka bir yetkili onaylasın → banka dosyasını al → kaydet. Doğrulanmamış IBAN listeye girmez."
        action={
          can('treasury.manage') && (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Yeni liste
            </Button>
          )
        }
      />
      {q.isPending ? (
        <PageLoading />
      ) : q.error ? (
        <Callout tone="danger">{errorMessage(q.error)}</Callout>
      ) : !q.data?.batches.length ? (
        <EmptyState title="Henüz ödeme listesi yok" description="Vadesi gelen tedarikçi borçlarından liste hazırlayın." />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Liste</Th>
                <Th>Banka hesabı</Th>
                <Th>Ödeme günü</Th>
                <Th num>Toplam</Th>
                <Th>Durum</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.batches.map((b) => (
                <Tr key={b.id} onClick={() => setOpen(b.id)} className="cursor-pointer">
                  <Td className="font-mono text-xs">{b.batchNo}</Td>
                  <Td>{b.accountName}</Td>
                  <Td>{formatDateTR(b.paymentDate)}</Td>
                  <Td num>
                    {money(b.total)} {b.currency}
                  </Td>
                  <Td>
                    <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {creating && <CreateBatch onClose={() => setCreating(false)} onCreated={(id) => setOpen(id)} />}
      {open && <BatchDetail id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function CreateBatch({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const accounts = useCQuery<{ accounts: TreasuryAccount[] }>(['treasury', 'accounts'], '/api/treasury/accounts');
  const banks = (accounts.data?.accounts ?? []).filter((a) => a.kind === 'bank' && a.isActive);
  const [accountId, setAccountId] = useState(''),
    [paymentDate, setPaymentDate] = useState(todayIso()),
    [dueUntil, setDueUntil] = useState(addDaysIso(todayIso(), 7)),
    [picked, setPicked] = useState<Record<string, boolean>>({}),
    [error, setError] = useState<string | null>(null);
  const account = accountId || banks[0]?.id || '';
  const sug = useCQuery<{ currency: string; parties: Suggestion[] }>(
    ['payment-batches', 'suggestions', account, dueUntil],
    `/api/payment-batches/suggestions?accountId=${account}&dueUntil=${dueUntil}`,
    { enabled: !!account && !!dueUntil },
  );
  const chosen = (sug.data?.parties ?? []).filter((p) => p.bankAccount && picked[p.partyId]);
  const total = chosen.reduce((s, p) => s.plus(p.total), dec(0)).toFixed(2);
  const save = useCMutation(
    (_: void, call) =>
      call<{ batch: { id: string } }>('/api/payment-batches', {
        method: 'POST',
        body: {
          accountId: account,
          paymentDate,
          lines: chosen.map((p) => ({
            partyId: p.partyId,
            bankAccountId: p.bankAccount!.id,
            amount: p.total,
            items: p.items.map((i) => ({ lineId: i.lineId, amount: i.remaining, settleAmount: i.remaining })),
          })),
        },
      }),
    invalidate,
  );
  return (
    <Sheet
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title="Yeni ödeme listesi"
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button
            variant="primary"
            disabled={!chosen.length}
            loading={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: (r) => {
                  toast.success('Ödeme listesi hazırlandı; onaya gönderin.');
                  onClose();
                  onCreated(r.batch.id);
                },
                onError: (e) => setError(errorMessage(e)),
              })
            }
          >
            Listeyi hazırla ({money(total)} {sug.data?.currency ?? ''})
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Banka hesabı">
            {(id) => (
              <Select id={id} value={account} onChange={(e) => setAccountId(e.target.value)}>
                {banks.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.currencyCode}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Ödeme günü">{(id) => <Input id={id} type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />}</Field>
          <Field label="Bu tarihe kadar vadesi gelenler">{(id) => <Input id={id} type="date" value={dueUntil} onChange={(e) => setDueUntil(e.target.value)} />}</Field>
        </div>
        {!banks.length && <Callout>Toplu ödeme için önce bir banka hesabı tanımlayın.</Callout>}
        {sug.isPending && account ? (
          <PageLoading />
        ) : !sug.data?.parties.length ? (
          <p className="text-sm text-muted">Bu tarihe kadar vadesi gelen, hesap para biriminde açık tedarikçi borcu yok.</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-10" />
                  <Th>Tedarikçi</Th>
                  <Th>En eski vade</Th>
                  <Th>IBAN</Th>
                  <Th num>Tutar</Th>
                </tr>
              </thead>
              <tbody>
                {sug.data.parties.map((p) => (
                  <Tr key={p.partyId}>
                    <Td>
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`${p.partyName} öde`}
                        disabled={!p.bankAccount}
                        checked={!!picked[p.partyId] && !!p.bankAccount}
                        onChange={(e) => setPicked((x) => ({ ...x, [p.partyId]: e.target.checked }))}
                      />
                    </Td>
                    <Td>{p.partyName}</Td>
                    <Td>{formatDateTR(p.oldestDue)}</Td>
                    <Td className="text-xs">
                      {p.bankAccount ? (
                        `•••• ${p.bankAccount.ibanLast4} · ${p.bankAccount.holderName}`
                      ) : (
                        <span className="text-danger">Doğrulanmış IBAN yok</span>
                      )}
                    </Td>
                    <Td num>{money(p.total)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>
    </Sheet>
  );
}

function BatchDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast(),
    can = useCan(),
    company = useCompany(),
    me = useSession().user?.id;
  const q = useCQuery<{ batch: Batch; lines: Line[] }>(['payment-batches', id], `/api/payment-batches/${id}`);
  const [cancel, setCancel] = useState(false),
    [reason, setReason] = useState('');
  const act = useCMutation(
    (v: { action: 'approve' | 'post' | 'cancel' }, call) =>
      call(`/api/payment-batches/${id}/${v.action}`, { method: 'POST', body: v.action === 'cancel' ? { reason } : {} }),
    invalidate,
  );
  const run = (action: 'approve' | 'post' | 'cancel', done: string) =>
    act.mutate({ action }, { onSuccess: () => toast.success(done), onError: (e) => toast.error(errorMessage(e)) });
  const download = async (b: Batch) => {
    try {
      const { blob, filename } = await apiBlob(`/api/payment-batches/${id}/bank-file`, { companyId: company.id });
      saveBlob(blob, filename ?? `${b.batchNo}.csv`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const b = q.data?.batch;
  return (
    <Sheet open wide onOpenChange={(o) => !o && onClose()} title={b ? `Ödeme listesi ${b.batchNo}` : 'Ödeme listesi'}>
      {q.isPending ? (
        <PageLoading />
      ) : q.error ? (
        <Callout tone="danger">{errorMessage(q.error)}</Callout>
      ) : (
        b && (
          <div className="space-y-4">
            <p className="text-sm">
              <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge> {b.accountName} · {formatDateTR(b.paymentDate)} · {money(b.total)} {b.currency}
              <span className="block text-xs text-muted">
                Hazırlayan {b.createdByName}
                {b.approvedByName ? ` · onaylayan ${b.approvedByName}` : ''}
                {b.cancelReason ? ` · iptal: ${b.cancelReason}` : ''}
              </span>
            </p>
            {b.status === 'draft' && b.createdBy === me && <Callout>Bu listeyi siz hazırladınız; başka bir yetkili onaylamalı (tek kullanıcılı şirket hariç).</Callout>}
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Tedarikçi</Th>
                    <Th>IBAN</Th>
                    <Th num>Tutar</Th>
                    <Th>Ödeme</Th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.lines.map((l) => (
                    <Tr key={l.id}>
                      <Td>{l.partyName}</Td>
                      <Td className="text-xs">
                        •••• {l.ibanLast4} · {l.holderName}
                        {l.bankStatus !== 'verified' && <span className="block text-danger">Doğrulanmamış</span>}
                      </Td>
                      <Td num>{money(l.amount)}</Td>
                      <Td className="text-xs">{l.treasuryTransactionId ? 'Kaydedildi' : `${l.items.length} kalem`}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <div className="flex flex-wrap gap-2">
              {b.status === 'draft' && can('treasury.post') && (
                <Button variant="primary" loading={act.isPending} onClick={() => run('approve', 'Liste onaylandı.')}>
                  <ShieldCheck className="size-4" aria-hidden />
                  Onayla
                </Button>
              )}
              {['approved', 'posted'].includes(b.status) && can('treasury.post') && (
                <Button onClick={() => void download(b)}>
                  <Download className="size-4" aria-hidden />
                  Banka dosyası (CSV)
                </Button>
              )}
              {b.status === 'approved' && can('treasury.post') && (
                <Button variant="primary" loading={act.isPending} onClick={() => run('post', 'Ödemeler kaydedildi; açık kalemler kapandı.')}>
                  <Send className="size-4" aria-hidden />
                  Ödemeleri kaydet
                </Button>
              )}
              {['draft', 'approved'].includes(b.status) && can('treasury.manage') && (
                <Button variant="ghost" onClick={() => setCancel(true)}>
                  <X className="size-4" aria-hidden />
                  İptal et
                </Button>
              )}
            </div>
          </div>
        )
      )}
      <Modal
        open={cancel}
        onOpenChange={setCancel}
        title="Ödeme listesini iptal et"
        footer={
          <>
            <Button onClick={() => setCancel(false)}>Vazgeç</Button>
            <Button
              variant="primary"
              disabled={reason.trim().length < 3}
              loading={act.isPending}
              onClick={() =>
                act.mutate(
                  { action: 'cancel' },
                  {
                    onSuccess: () => {
                      toast.success('Liste iptal edildi.');
                      setCancel(false);
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            >
              İptal et
            </Button>
          </>
        }
      >
        <Field label="İptal nedeni">{(fid) => <Input id={fid} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Modal>
    </Sheet>
  );
}
