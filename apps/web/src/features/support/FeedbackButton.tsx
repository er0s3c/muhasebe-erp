import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ImagePlus, MessageSquarePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Callout } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';
import { api, ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useSession } from '../../lib/session';

const IMAGE_LIMIT = 5 * 1024 * 1024;
const blank = { pagePath: '', pageTitle: '', message: '', steps: '', expected: '' };
type Receipt = { id: string; reference: string; status: string; createdAt: string };

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) reject(new Error('Görsel okunamadı. Lütfen yeniden seçin.'));
      else resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Görsel okunamadı. Lütfen yeniden seçin.'));
    reader.readAsDataURL(file);
  });
}

/** Geri bildirim taslağı kapanınca korunur; gönderim yalnız merkezi destek kutusu kabul ettiğinde başarılı sayılır. */
export function FeedbackButton() {
  const { activeCompany, user } = useSession();
  if (!activeCompany || !user) return null;
  return <FeedbackForm key={activeCompany.id} companyId={activeCompany.id} companyName={activeCompany.name} reporterName={user.fullName} />;
}

function FeedbackForm({ companyId, companyName, reporterName }: { companyId: string; companyName: string; reporterName: string }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const availability = useQuery({
    queryKey: ['feedback-availability'],
    queryFn: () => api<{ available: boolean; reason?: string }>('/api/feedback/availability'),
    enabled: open && !receipt,
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const start = () => {
    if (!form.pagePath) setForm({ ...blank, pagePath: location.pathname, pageTitle: location.pathname === '/' ? 'Genel bakış' : document.querySelector('main h1')?.textContent?.trim().slice(0, 200) ?? '' });
    setOpen(true);
  };
  const choose = (candidate: File | null) => {
    if (!candidate || busy) return;
    if (!['image/png', 'image/jpeg'].includes(candidate.type)) {
      setError('PNG veya JPG biçiminde bir ekran görüntüsü seçin.');
      return;
    }
    if (!candidate.size || candidate.size > IMAGE_LIMIT) {
      setError('Ekran görüntüsü boş olmamalı ve 5 MB sınırını aşmamalı.');
      return;
    }
    setError(null);
    setFile(candidate);
  };
  const paste = (event: ClipboardEvent) => {
    const image = Array.from(event.clipboardData.items).find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (image) {
      event.preventDefault();
      choose(image.getAsFile());
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0] ?? null);
  };
  const ready = !!availability.data?.available && (!!form.message.trim() || !!file);
  const submit = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const screenshot = file ? { name: file.name, mime: file.type, base64: await fileBase64(file) } : undefined;
      const response = await api<{ feedback: Receipt }>(`/api/companies/${companyId}/feedback`, {
        method: 'POST',
        companyId,
        body: { requestId, ...form, screenshot },
      });
      setReceipt(response.feedback);
      setForm(blank);
      setFile(null);
      setPreview(null);
      setRequestId(crypto.randomUUID());
      if (inputRef.current) inputRef.current.value = '';
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'FEEDBACK_REQUEST_CONFLICT') {
        setRequestId(crypto.randomUUID());
        setError('Önceki gönderiminiz alınmış. Değiştirdiğiniz bilgileri yeni bir bildirim olarak göndermek için Gönder düğmesine tekrar basın.');
      } else setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return <>
    <Button size="sm" variant="ghost" className="shrink-0 px-2" onClick={start} aria-label="Geri bildirim gönder" title="Geri bildirim gönder">
      <MessageSquarePlus className="size-[18px]" aria-hidden />
      <span className="hidden xl:inline">Geri bildirim</span>
    </Button>
    <Sheet open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); if (!next && receipt) setReceipt(null); } }}
      title={receipt ? 'Geri bildiriminiz alındı' : 'Geri bildirim gönder'}
      description={receipt ? 'Bildiriminiz destek ekibinin kutusuna ulaştı.' : 'Bir sorunla mı karşılaştınız? Kısaca anlatın veya ekran görüntüsü ekleyin.'}
      footer={receipt ? <Button variant="primary" onClick={() => { setOpen(false); setReceipt(null); }}>Tamam</Button> : <>
        <Button disabled={busy} onClick={() => setOpen(false)}>Daha sonra</Button>
        <Button type="submit" form="customer-feedback" variant="primary" loading={busy} disabled={!ready}>Gönder</Button>
      </>}>
      {receipt ? <div className="space-y-4 py-5">
        <CheckCircle2 className="size-10 text-success" aria-hidden />
        <p className="text-base">Sorunu anlamamız için paylaştığınız bilgiler kaydedildi.</p>
        <div className="rounded-lg border border-border bg-surface-2 p-4">
          <p className="text-xs text-muted">Bildirim numarası</p>
          <p className="mt-1 break-words text-lg">{receipt.reference}</p>
        </div>
      </div> : <form id="customer-feedback" className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(); }} onPaste={paste}>
        {error && <Callout tone="danger">{error}</Callout>}
        {availability.error && <Callout tone="danger">{errorMessage(availability.error)}<Button size="sm" className="mt-2" onClick={() => void availability.refetch()}>Tekrar kontrol et</Button></Callout>}
        {availability.data && !availability.data.available && <Callout>{availability.data.reason ?? 'Geri bildirim hizmeti bu kurulumda henüz açılmamış. Kurulum yöneticinizle iletişime geçin.'}</Callout>}
        <Field label="Sorunla hangi ekranda karşılaştınız?" hint="Bulunduğunuz ekranı ekledik; gerekirse adını değiştirebilirsiniz.">{id => <Input id={id} maxLength={200} value={form.pageTitle} disabled={busy} onChange={event => setForm({ ...form, pageTitle: event.target.value })} />}</Field>
        <Field label="Ne oldu?" hint="Örneğin: Kaydet düğmesine bastım, hata çıktı ve kayıt oluşmadı.">{id => <Textarea id={id} rows={4} maxLength={4000} placeholder="Karşılaştığınız sorunu anlatın…" disabled={busy} value={form.message} onChange={event => setForm({ ...form, message: event.target.value })} />}</Field>
        <div className="space-y-2">
          <p className="text-[13px]">Ekran görüntüsü <span className="text-muted">(isteğe bağlı)</span></p>
          <div className={`rounded-xl border border-dashed p-4 ${dragging ? 'border-text bg-surface-2' : 'border-border-strong'}`}
            onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
            <input ref={inputRef} type="file" accept="image/png,image/jpeg" className="sr-only" aria-label="Ekran görüntüsü yükle" disabled={busy} onChange={event => { choose(event.target.files?.[0] ?? null); event.target.value = ''; }} />
            {file ? <div className="space-y-3">
              {preview && <img src={preview} alt="Göndereceğiniz ekran görüntüsü" className="max-h-52 w-full rounded-lg border border-border object-contain" />}
              <div className="flex min-w-0 items-center justify-between gap-2">
                <p className="min-w-0 break-all text-xs text-muted">{file.name} · {(file.size / 1024 / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB</p>
                <Button size="sm" variant="ghost" disabled={busy} aria-label="Ekran görüntüsünü kaldır" onClick={() => { setFile(null); setPreview(null); }}><Trash2 className="size-4" />Kaldır</Button>
              </div>
            </div> : <div className="flex flex-col items-center gap-2 text-center">
              <ImagePlus className="size-6 text-muted" aria-hidden />
              <Button size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>Ekran görüntüsü seç</Button>
              <p className="text-xs text-muted">PNG veya JPG, en fazla 5 MB. Sürükleyebilir veya kopyaladığınız görseli yapıştırabilirsiniz.</p>
            </div>}
          </div>
          <p className="text-xs text-muted">Açıklama veya ekran görüntüsünden biri yeterli; ikisini birlikte de gönderebilirsiniz.</p>
        </div>
        <details className="rounded-lg border border-border p-3.5">
          <summary className="cursor-pointer text-sm">Biraz daha ayrıntı ekle <span className="text-muted">(isteğe bağlı)</span></summary>
          <div className="mt-4 space-y-4">
            <Field label="Sorundan hemen önce ne yapıyordunuz?" hint="Hangi düğmeye bastınız, hangi bilgiyi girdiniz?">{id => <Textarea id={id} rows={3} maxLength={2000} disabled={busy} value={form.steps} onChange={event => setForm({ ...form, steps: event.target.value })} />}</Field>
            <Field label="Ne olmasını bekliyordunuz?">{id => <Textarea id={id} rows={2} maxLength={2000} disabled={busy} value={form.expected} onChange={event => setForm({ ...form, expected: event.target.value })} />}</Field>
          </div>
        </details>
        <p className="break-words text-xs text-muted">{reporterName} · {companyName}<br />Adınız, şirketiniz ve ekran bilgisi bildirime eklenir.</p>
      </form>}
    </Sheet>
  </>;
}
