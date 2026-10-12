import { Copy, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Callout } from '../../components/ui/Feedback';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCanOperation } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { InvoiceDetail } from '../../lib/types';

export function InvoiceShareButton({ data }: { data: InvoiceDetail }) {
  const company = useCompany();
  const canExport = useCanOperation()('core.invoices', 'export');
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = phone.replace(/[+\s()-]/g, '');
  const validPhone = !digits || /^\d{10,15}$/.test(digits);
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(message);
      setCopied(true); setError(null);
    } catch { setError('Mesaj kopyalanamadı. Metni seçerek kopyalayabilirsiniz.'); }
  };
  const inv = data.invoice;
  if (!canExport || inv.status !== 'posted') return null;
  const start = () => {
    const sender = inv.documentMetadata?.company?.name ?? company.name;
    const customer = inv.documentMetadata?.party?.name ?? inv.partyName;
    setMessage(`${customer},\n\n${sender} adına düzenlenen ${inv.invoiceNo ?? 'fatura'} bilgileri:\nTarih: ${formatDateTR(inv.invoiceDate)}\nToplam: ${moneyIn(inv.grossTotal, inv.currencyCode)}${inv.taxTotalsSnapshot ? `\nNet ödenecek: ${moneyIn(inv.taxTotalsSnapshot.payableToSeller, inv.currencyCode)}` : ''}\n\nİyi günler dileriz.`);
    setCopied(false); setError(null); setOpen(true);
  };
  return <>
    <Button onClick={start}><MessageCircle className="size-4" aria-hidden />WhatsApp ile paylaş</Button>
    <Modal open={open} onOpenChange={setOpen} title="WhatsApp paylaşımı" description="Mesajı inceleyin; WhatsApp'ta alıcıyı seçip gönderin. Fatura PDF'sini isterseniz mesaja ayrıca ekleyebilirsiniz." footer={<>
      <Button onClick={() => setOpen(false)}>Kapat</Button>
      <Button disabled={!message.trim()} onClick={() => void copy()}><Copy className="size-4" aria-hidden />{copied ? 'Kopyalandı' : 'Mesajı kopyala'}</Button>
      {validPhone && message.trim() && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 max-w-full items-center justify-center gap-2 rounded-md bg-brand px-5 py-2 text-center text-sm text-brand-contrast hover:bg-brand-hover"><MessageCircle className="size-4" aria-hidden />WhatsApp'ı aç</a>}
    </>}>
      <div className="space-y-4">
        {error && <Callout tone="warning">{error}</Callout>}
        <Field label="Alıcı telefonu (isteğe bağlı)" hint="Ülke koduyla yazın. Boş bırakırsanız WhatsApp'ta alıcı seçebilirsiniz." error={!validPhone ? 'Telefon ülke koduyla 10–15 rakam olmalı.' : undefined}>{id => <Input id={id} type="tel" inputMode="tel" value={phone} maxLength={24} onChange={event => setPhone(event.target.value)} placeholder="+90…" />}</Field>
        <Field label="Paylaşılacak mesaj">{id => <Textarea id={id} value={message} rows={9} maxLength={2000} onChange={event => { setMessage(event.target.value); setCopied(false); }} />}</Field>
      </div>
    </Modal>
  </>;
}
