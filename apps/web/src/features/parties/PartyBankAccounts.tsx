import { AlertTriangle, Copy, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { markFormSaved } from '../../components/ui/UnsavedChanges';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/license';
import { useCan, useCMutation, useCompanyApi, useCQuery } from '../../lib/queries';

type Status = 'pending' | 'verified' | 'rejected' | 'revoked';
interface BankAccount {
  id: string; ibanMasked: string; bankName: string | null; holderName: string; status: Status;
  requestedByName: string; requestedAt: string; requestNote: string | null; decidedByName: string | null; decidedAt: string | null;
  verificationMethod: string | null; decisionNote: string | null; ownRequest: boolean; alsoUsedBy: { partyId: string; partyName: string }[];
}
const STATUS: Record<Status, { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }> = {
  pending: { label: 'Doğrulama bekliyor', tone: 'warning' }, verified: { label: 'Doğrulandı', tone: 'success' },
  rejected: { label: 'Reddedildi', tone: 'danger' }, revoked: { label: 'Kaldırıldı', tone: 'neutral' },
};
const METHODS = { phone_callback: 'Bilinen numaradan geri arama', signed_document: 'İmzalı belge', bank_letter: 'Banka yazısı', other: 'Diğer' } as const;

/**
 * Cari banka hesapları (öneri 53). Yeni ya da değişen IBAN doğrulanana kadar ödeme için kullanılmaz; doğrulamayı hesabı
 * girenden farklı bir kasa/banka yetkilisi bağımsız teyitle yapar.
 */
export function PartyBankAccounts({ partyId }: { partyId: string }) {
  const can = useCan();
  const toast = useToast();
  const { call } = useCompanyApi();
  const path = `/api/parties/${partyId}/bank-accounts`;
  const key = [['parties', partyId, 'bank-accounts']];
  const query = useCQuery<{ accounts: BankAccount[] }>(key[0]!, path);
  const [adding, setAdding] = useState(false);
  const [deciding, setDeciding] = useState<{ account: BankAccount; outcome: 'verify' | 'reject' } | null>(null);
  const [form, setForm] = useState({ iban: '', holderName: '', bankName: '', note: '' });
  const [decision, setDecision] = useState({ method: 'phone_callback', note: '' });
  const [error, setError] = useState<unknown>(null);
  const add = useCMutation((_: void, c) => c(path, { method: 'POST', body: form }), key);
  const decide = useCMutation((v: { id: string; outcome: 'verify' | 'reject' }, c) => c(`${path}/${v.id}/${v.outcome}`, { method: 'POST', body: v.outcome === 'verify' ? decision : { note: decision.note } }), key);
  const revoke = useCMutation((id: string, c) => c(`${path}/${id}/revoke`, { method: 'POST', body: {} }), key);
  const accounts = query.data?.accounts ?? [];
  const canFinance = can('treasury.manage');

  const copyIban = async (id: string) => {
    try {
      const { iban } = await call<{ iban: string }>(`${path}/${id}/iban`);
      await navigator.clipboard.writeText(iban);
      toast.success('IBAN kopyalandı');
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <Card className="mt-5 p-5">
      <section aria-label="Banka hesapları" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Banka hesapları</h2>
            <p className="text-xs text-muted">Yeni ya da değişen IBAN, girenden farklı bir yetkili bağımsız teyit edene kadar ödemede kullanılmaz. IBAN değişikliği bildirimlerini her zaman kayıtlı bir numaradan arayarak doğrulayın.</p>
          </div>
          {can('parties.manage') && <Button onClick={() => { setForm({ iban: '', holderName: '', bankName: '', note: '' }); setError(null); setAdding(true); }}>Banka hesabı ekle</Button>}
        </div>
        {query.error ? <ErrorCallout error={query.error} /> : accounts.length === 0 ? <p className="text-sm text-muted">Kayıtlı banka hesabı yok.</p> : accounts.map((a) => (
          <div key={a.id} className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3 text-sm">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2"><span className="num">{a.ibanMasked}</span><Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge></p>
              <p className="text-xs text-muted">{a.holderName}{a.bankName ? ` · ${a.bankName}` : ''} · {a.requestedByName} girdi, {fmtDateTime(a.requestedAt)}{a.requestNote ? ` · ${a.requestNote}` : ''}</p>
              {a.decidedByName && <p className="text-xs text-muted">{a.status === 'rejected' ? 'Reddeden' : 'Doğrulayan'}: {a.decidedByName} · {a.verificationMethod ? METHODS[a.verificationMethod as keyof typeof METHODS] : ''} · {a.decisionNote}</p>}
              {a.alsoUsedBy.length > 0 && <p className="mt-1 flex items-start gap-1.5 text-xs text-danger"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />Bu IBAN başka cari kartında da kayıtlı: {a.alsoUsedBy.map((p) => p.partyName).join(', ')}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap gap-1">
              {a.status === 'pending' && canFinance && !a.ownRequest && <>
                <Button size="sm" onClick={() => { setDecision({ method: 'phone_callback', note: '' }); setError(null); setDeciding({ account: a, outcome: 'verify' }); }}><ShieldCheck className="size-3.5" aria-hidden />Doğrula</Button>
                <Button size="sm" variant="ghost" onClick={() => { setDecision({ method: 'phone_callback', note: '' }); setError(null); setDeciding({ account: a, outcome: 'reject' }); }}>Reddet</Button>
              </>}
              {a.status === 'pending' && a.ownRequest && <span className="text-xs text-muted">Başka bir yetkili doğrulamalı</span>}
              {a.status === 'verified' && can('treasury.read') && <Button size="sm" variant="ghost" onClick={() => void copyIban(a.id)}><Copy className="size-3.5" aria-hidden />IBAN'ı kopyala</Button>}
              {a.status === 'verified' && can('parties.manage') && <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === a.id} onClick={() => revoke.mutate(a.id, { onError: (e) => toast.error(errorMessage(e)) })}>Kaldır</Button>}
            </div>
          </div>
        ))}
      </section>

      <Modal open={adding} onOpenChange={setAdding} title="Banka hesabı ekle" description="Hesap doğrulama bekler; ödeme için kullanılabilmesi için başka bir yetkilinin teyidi gerekir."
        footer={<><Button onClick={() => setAdding(false)}>Vazgeç</Button><Button variant="primary" loading={add.isPending} disabled={!form.iban.trim() || form.holderName.trim().length < 2} onClick={(e) => {
          const button = e.currentTarget; setError(null);
          add.mutate(undefined, { onSuccess: () => { markFormSaved(button); setAdding(false); toast.success('Banka hesabı doğrulamaya gönderildi'); }, onError: setError });
        }}>Kaydet</Button></>}>
        <div className="flex flex-col gap-4">
          {error != null && <ErrorCallout error={error} />}
          <Field label="IBAN" required>{(id) => <Input id={id} value={form.iban} maxLength={42} autoComplete="off" onChange={(e) => setForm({ ...form, iban: e.target.value })} />}</Field>
          <Field label="Hesap sahibi" required>{(id) => <Input id={id} value={form.holderName} maxLength={140} onChange={(e) => setForm({ ...form, holderName: e.target.value })} />}</Field>
          <Field label="Banka">{(id) => <Input id={id} value={form.bankName} maxLength={120} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />}</Field>
          <Field label="Bildirim kaynağı" hint="Ör. tedarikçinin e-postası, imzalı yazı.">{(id) => <Input id={id} value={form.note} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
        </div>
      </Modal>

      <Modal open={!!deciding} onOpenChange={(o) => !o && setDeciding(null)} title={deciding?.outcome === 'verify' ? 'Banka hesabını doğrula' : 'Banka hesabını reddet'}
        description={deciding ? `${deciding.account.ibanMasked} · ${deciding.account.holderName}` : undefined}
        footer={<><Button onClick={() => setDeciding(null)}>Vazgeç</Button><Button variant={deciding?.outcome === 'verify' ? 'primary' : 'danger'} loading={decide.isPending} disabled={decision.note.trim().length < 3} onClick={(e) => {
          if (!deciding) return;
          const button = e.currentTarget; setError(null);
          decide.mutate({ id: deciding.account.id, outcome: deciding.outcome }, { onSuccess: () => { markFormSaved(button); setDeciding(null); toast.success(deciding.outcome === 'verify' ? 'Banka hesabı doğrulandı' : 'Banka hesabı reddedildi'); }, onError: setError });
        }}>{deciding?.outcome === 'verify' ? 'Doğrula' : 'Reddet'}</Button></>}>
        <div className="flex flex-col gap-4">
          {error != null && <ErrorCallout error={error} />}
          {deciding?.outcome === 'verify' && <Field label="Teyit yöntemi" required>{(id) => <Select id={id} value={decision.method} onChange={(e) => setDecision({ ...decision, method: e.target.value })}>
            {Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>}</Field>}
          <Field label={deciding?.outcome === 'verify' ? 'Teyit notu' : 'Ret gerekçesi'} required hint={deciding?.outcome === 'verify' ? 'Kiminle, hangi numaradan, ne zaman teyit edildi.' : undefined}>
            {(id) => <Input id={id} value={decision.note} maxLength={500} onChange={(e) => setDecision({ ...decision, note: e.target.value })} />}
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
