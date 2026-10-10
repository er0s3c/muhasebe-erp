import { useState } from 'react';
import { FileText, Hash } from 'lucide-react';
import { DOCUMENT_SERIES, INVOICE_PRINT_TEMPLATES, INVOICE_PRINT_TEMPLATE_LABELS, documentNumberPreview, documentSeriesOption, documentSeriesSchema, isoYear, todayIso, type DocumentSeriesKey, type InvoicePrintTemplate, type OperationsSettings } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';

export function DocumentSettingsSection({ settings, edit, onChange }: {
  settings: OperationsSettings;
  edit: boolean;
  onChange: (patch: Pick<OperationsSettings, 'documentSeries' | 'invoicePrintTemplate'>) => void;
}) {
  const [selected, setSelected] = useState<DocumentSeriesKey>('INV:sales');
  const definition = DOCUMENT_SERIES.find(row => row.key === selected)!;
  const series = settings.documentSeries ?? {};
  const template = settings.invoicePrintTemplate ?? 'detailed';
  const option = documentSeriesOption(series, selected, definition.prefix);
  const validation = documentSeriesSchema.safeParse(series);
  const update = (value: typeof option) => onChange({ documentSeries: { ...series, [selected]: value }, invoicePrintTemplate: template });
  return (
    <>
      <Card className="lg:col-span-2">
        <CardHeader title="Belge numara serileri" description="Belge türü ve yıl için mevcut sıra sayacı devam eder." action={<Hash className="size-4 text-muted" />} />
        <div className="space-y-4 p-5">
          <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Numaralandırılacak belge" className="min-w-0 lg:col-span-2">{id => <Select id={id} value={selected} onChange={event => setSelected(event.target.value as DocumentSeriesKey)}>{DOCUMENT_SERIES.map(row => <option key={row.key} value={row.key}>{row.label}</option>)}</Select>}</Field>
            <Field label="Belge öneki" hint="A–Z, 0–9; en fazla 16 karakter.">{id => <Input id={id} value={option.prefix} required maxLength={16} pattern="[A-Za-z0-9]+([-_][A-Za-z0-9]+)*" disabled={!edit} onChange={event => update({ ...option, prefix: event.target.value.toUpperCase() })} />}</Field>
            <Field label="Sıra numarası basamak sayısı" hint="1–10; başına sıfır eklenir.">{id => <Input id={id} type="number" min={1} max={10} required value={option.padding} disabled={!edit} onChange={event => update({ ...option, padding: Number(event.target.value) })} />}</Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-4">
            <div className="min-w-0"><p className="text-xs text-muted">Örnek numara · sıra 1</p><p className="mt-1 break-all font-mono text-base" aria-live="polite" data-testid="document-number-preview">{documentNumberPreview(option, isoYear(todayIso()))}</p></div>
            {edit && <Button size="sm" disabled={!series[selected]} onClick={() => { const restored = { ...series }; delete restored[selected]; onChange({ documentSeries: restored, invoicePrintTemplate: template }); }}>Bu seriyi varsayılana döndür</Button>}
          </div>
          {!validation.success && <Callout tone="danger">{validation.error.issues[0]?.message}</Callout>}
          <p className="text-sm text-muted">Ayarlar kaydedildikten sonra yeni kesinleşen belgelere uygulanır. Önceden verilmiş numaralar değişmez; sıra sayacı sıfırlanmaz. Basamak sayısı aşılırsa numara kesilmeden büyür. Aynı belge grubunda önekler farklı olmalıdır.</p>
          {Object.keys(series).length > 0 && <p className="text-xs text-muted">Özel ayar yapılan seriler: {DOCUMENT_SERIES.filter(row => series[row.key]).map(row => row.label).join(', ')}</p>}
        </div>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title="Fatura çıktı şablonu" description="Yazdırma ve tarayıcıdan PDF kaydetme için şirket varsayılanı." action={<FileText className="size-4 text-muted" />} />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Varsayılan fatura şablonu">{id => <Select id={id} value={template} disabled={!edit} onChange={event => onChange({ documentSeries: series, invoicePrintTemplate: event.target.value as InvoicePrintTemplate })}>{INVOICE_PRINT_TEMPLATES.map(value => <option key={value} value={value}>{INVOICE_PRINT_TEMPLATE_LABELS[value]}</option>)}</Select>}</Field>
          <p className="text-sm text-muted">Basit şablon kalemleri, vergileri ve toplamları gösterir. Ayrıntılı şablon bunlara indirim, seri numarası, kur kaynağı ve belge bağlantılarını ekler. Her fatura için yazdırmadan önce seçim değiştirilebilir.</p>
        </div>
      </Card>
    </>
  );
}
