import { BookmarkPlus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { INVOICE_TEMPLATES_MAX, useInvoiceTemplates, type InvoiceTemplate } from '../../lib/personal';

/**
 * Kullanıcıya özel hızlı giriş şablonu (öneri 23): sık kesilen faturanın cari ve satırları tek seçimle forma gelir.
 * Şablon yalnız formu doldurur; fiyat, KDV ve hesap kuralları kayıtta yeniden uygulanır. Şablonlar hesapta saklanır.
 */
export function InvoiceTemplates({ type, current, onApply }: {
  type: string;
  current: () => Omit<InvoiceTemplate, 'id' | 'name' | 'type'>;
  onApply: (template: InvoiceTemplate) => void;
}) {
  const toast = useToast();
  const { value, save, saving } = useInvoiceTemplates();
  const mine = value.filter((t) => t.type === type);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const store = (next: InvoiceTemplate[], ok: string) => save(next).then(() => toast.success(ok), () => toast.error('Şablon kaydedilemedi. Bağlantınızı kontrol edip tekrar deneyin.'));
  return (
    <div className="flex flex-wrap items-center gap-2" data-form-guard="off">
      {mine.length > 0 && (
        <Select className="w-48" value="" aria-label="Şablon uygula" onChange={(e) => {
          const t = mine.find((x) => x.id === e.target.value);
          if (t) onApply(t);
        }}>
          <option value="">Şablondan doldur</option>
          {mine.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      )}
      <Button size="sm" variant="ghost" onClick={() => { setName(''); setOpen(true); }}><BookmarkPlus className="size-4" aria-hidden />Şablon olarak kaydet</Button>
      <Modal open={open} onOpenChange={setOpen} title="Fatura şablonu" description="Cari ve satırlar şablona kaydedilir; tarih, numara ve tutarlar her faturada yeniden hesaplanır."
        footer={<>
          <Button onClick={() => setOpen(false)}>Vazgeç</Button>
          <Button variant="primary" loading={saving} disabled={!name.trim() || value.length >= INVOICE_TEMPLATES_MAX} onClick={() => {
            const template: InvoiceTemplate = { id: crypto.randomUUID(), name: name.trim().slice(0, 40), type, ...current() };
            void store([...value, template], 'Şablon kaydedildi').then(() => setOpen(false));
          }}>Kaydet</Button>
        </>}>
        <div className="flex flex-col gap-3" data-form-guard="off">
          <Field label="Şablon adı" required>{(id) => <Input id={id} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}</Field>
          {value.length >= INVOICE_TEMPLATES_MAX && <p className="text-xs text-muted">En fazla {INVOICE_TEMPLATES_MAX} şablon saklanır; yenisi için eskilerden birini silin.</p>}
          {mine.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 border-t border-border pt-2 text-sm">
              <span>{t.name} <span className="text-xs text-muted">· {t.lines.length} satır</span></span>
              <Button size="sm" variant="ghost" aria-label={`${t.name} şablonunu sil`} onClick={() => void store(value.filter((x) => x.id !== t.id), 'Şablon silindi')}><Trash2 className="size-4" aria-hidden /></Button>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
