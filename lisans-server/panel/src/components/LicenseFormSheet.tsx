import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@ui/Button';
import { Callout, ErrorState } from '@ui/Feedback';
import { Field, Input, Select, Textarea } from '@ui/Field';
import { Sheet } from '@ui/Sheet';
import { useToast } from '@ui/Toast';
import { markFormSaved } from '@ui/UnsavedChanges';
import { api, errorText, type Customer, type License, type Sector } from '../api';
import { KIND_LABELS, SECTOR_LABELS, toDateInput } from '../format';
import { focusValidationError, validationErrors } from '../validation';

const SECTORS: Sector[] = ['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE', 'LEATHER_FASHION', 'MANUFACTURING_WHOLESALE'];

interface FormState {
  customerId: string;
  kind: License['kind'];
  sectors: Sector[];
  deviceLimit: string;
  companyLimit: string;
  validUntil: string;
  leaseDays: string;
  validityMode: 'lease' | 'subscription';
  graceDays: string;
  deviceIdleDays: string;
  maxActivations: string;
  offlineAllowed: boolean;
  notes: string;
}

const inOneYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

const fromLicense = (l: License): FormState => ({
  customerId: l.customerId,
  kind: l.kind,
  sectors: l.sectors,
  deviceLimit: String(l.deviceLimit),
  companyLimit: String(l.companyLimit),
  validUntil: toDateInput(l.validUntil),
  leaseDays: String(l.leaseDays),
  validityMode: l.validityMode,
  graceDays: String(l.graceDays),
  deviceIdleDays: String(l.deviceIdleDays),
  maxActivations: String(l.maxActivations),
  offlineAllowed: l.offlineAllowed,
  notes: l.notes ?? '',
});

const empty = (customerId = ''): FormState => ({
  customerId,
  kind: 'commercial',
  sectors: [],
  deviceLimit: '3',
  companyLimit: '1',
  validUntil: inOneYear(),
  leaseDays: '7',
  graceDays: '15',
  validityMode: 'subscription',
  deviceIdleDays: '30',
  maxActivations: '1',
  offlineAllowed: false,
  notes: '',
});

/** Lisans oluşturma/düzenleme formu. Oluşturunca sunucunun döndürdüğü etkinleştirme kodu `onCreated` ile iletilir. */
export function LicenseFormSheet({
  open,
  onOpenChange,
  license,
  presetCustomerId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  license?: License;
  presetCustomerId?: string;
  onCreated?: (code: string, license: License) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = license !== undefined;
  const [form, setForm] = useState<FormState>(() => (license ? fromLicense(license) : empty(presetCustomerId)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const customers = useQuery({ queryKey: ['customers', ''], queryFn: () => api<{ customers: Customer[] }>('/admin/api/customers'), enabled: open && !editing });

  useEffect(() => {
    if (open) {
      setForm(license ? fromLicense(license) : empty(presetCustomerId));
      setError(null);
      setFieldErrors({});
    }
  }, [open, license, presetCustomerId]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleSector = (s: Sector) => set('sectors', form.sectors.includes(s) ? form.sectors.filter((x) => x !== s) : [...form.sectors, s]);
  const num = (v: string) => Number(v);

  const submit = async () => {
    if (pending.current) return;
    setError(null);
    const errors: Record<string, string> = {};
    if (!editing && !form.customerId) errors.customerId = 'Müşteri seçin.';
    if (form.sectors.length === 0) errors.sectors = 'En az bir sektör seçin.';
    setFieldErrors(errors);
    if (Object.keys(errors).length) { focusValidationError(formRef.current); return; }
    if (formRef.current && !formRef.current.reportValidity()) return;
    const body = {
      ...(editing ? {} : { customerId: form.customerId }),
      kind: form.kind,
      sectors: form.sectors,
      deviceLimit: num(form.deviceLimit),
      companyLimit: num(form.companyLimit),
      validUntil: form.validUntil,
      leaseDays: num(form.leaseDays),
      validityMode: form.validityMode,
      graceDays: num(form.graceDays),
      deviceIdleDays: num(form.deviceIdleDays),
      maxActivations: num(form.maxActivations),
      offlineAllowed: form.offlineAllowed,
      notes: form.notes.trim() || null,
    };
    pending.current = true;
    setBusy(true);
    try {
      if (editing) {
        await api(`/admin/api/licenses/${license.id}`, { method: 'PATCH', body });
        toast.success('Lisans güncellendi.');
      } else {
        const res = await api<{ license: License; activationCode: string }>('/admin/api/licenses', { method: 'POST', body });
        onCreated?.(res.activationCode, res.license);
      }
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['licenses'] }), queryClient.invalidateQueries({ queryKey: ['license'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })]);
      markFormSaved(formRef.current);
      onOpenChange(false);
    } catch (e) {
      setFieldErrors(validationErrors(e));
      focusValidationError(formRef.current);
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => { if (!busy) onOpenChange(next); }}
      title={editing ? 'Lisansı düzenle' : 'Yeni lisans'}
      description={editing ? 'Değişiklikler müşterinin bir sonraki kalp atışında (en geç ~12 saat) uygulanır.' : 'Sektörü, cihaz ve şirket kotasını ve süreyi siz belirlersiniz.'}
      footer={
        <>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>Vazgeç</Button>
          <Button variant="primary" loading={busy} disabled={customers.isPending && !editing || !!customers.error && !editing} onClick={() => void submit()}>
            {editing ? 'Kaydet' : 'Lisansı ver'}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <Callout tone="danger">{error}</Callout>}
        {!editing && customers.error && <ErrorState title="Müşteriler yüklenemedi" description={errorText(customers.error)} onRetry={() => void customers.refetch()} retrying={customers.isFetching} />}
        {!editing && (
          <Field label="Müşteri" required error={fieldErrors.customerId}>
            {(id) => (
              <Select id={id} required aria-invalid={!!fieldErrors.customerId} value={form.customerId} onChange={(e) => set('customerId', e.target.value)}>
                <option value="">Seçin…</option>
                {customers.data?.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px]">
            Sektörler <span className="text-danger" aria-hidden>*</span>
          </legend>
          {SECTORS.map((s) => (
            <label key={s} className="flex items-center gap-2.5 text-sm">
              <input type="checkbox" aria-invalid={!!fieldErrors.sectors} checked={form.sectors.includes(s)} onChange={() => toggleSector(s)} />
              {SECTOR_LABELS[s]}
            </label>
          ))}
          <p className="text-xs text-muted">Müşteri yalnızca seçtiğiniz sektörlerde şirket açabilir.</p>
          {fieldErrors.sectors && <p role="alert" className="text-xs text-danger">{fieldErrors.sectors}</p>}
        </fieldset>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Tür" error={fieldErrors.kind}>
            {(id) => (
              <Select id={id} value={form.kind} onChange={(e) => set('kind', e.target.value as License['kind'])}>
                {Object.entries(KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Abonelik bitişi" hint="O günün sonuna kadar geçerli" error={fieldErrors.validUntil}>
            {(id) => <Input id={id} type="date" value={form.validUntil} onChange={(e) => set('validUntil', e.target.value)} />}
          </Field>
          <Field label="Cihaz kotası" hint="Kayıtlı tarayıcı/bilgisayar sayısı" error={fieldErrors.deviceLimit}>
            {(id) => <Input id={id} type="number" min={1} max={10000} value={form.deviceLimit} onChange={(e) => set('deviceLimit', e.target.value)} />}
          </Field>
          <Field label="Şirket sınırı" error={fieldErrors.companyLimit}>
            {(id) => <Input id={id} type="number" min={1} max={10000} value={form.companyLimit} onChange={(e) => set('companyLimit', e.target.value)} />}
          </Field>
          <Field label="Sunucu (etkinleştirme) sayısı" hint="Aynı anda etkin kurulum" error={fieldErrors.maxActivations}>
            {(id) => <Input id={id} type="number" min={1} max={20} value={form.maxActivations} onChange={(e) => set('maxActivations', e.target.value)} />}
          </Field>
          <Field label="Boşta cihaz süresi (gün)" hint="Bu kadar süre görülmeyen cihaz kotadan düşer" error={fieldErrors.deviceIdleDays}>
            {(id) => <Input id={id} type="number" min={1} max={365} value={form.deviceIdleDays} onChange={(e) => set('deviceIdleDays', e.target.value)} />}
          </Field>
          <Field label="Lisans doğrulama biçimi" hint="Eski istemciler kısa kira biçimini kullanmaya devam eder." error={fieldErrors.validityMode}>
            {(id) => <Select id={id} value={form.validityMode} onChange={(e) => set('validityMode', e.target.value as FormState['validityMode'])}><option value="subscription">Abonelik bitişine kadar çevrimdışı</option><option value="lease">Düzenli çevrimiçi doğrulama</option></Select>}
          </Field>
          {!editing && <Field label="Süre şablonu" hint="Şablon bitiş ve ek süreyi doldurur; aşağıdan değiştirebilirsiniz.">
            {(id) => <Select id={id} defaultValue="custom" onChange={(e) => { const d = new Date(); const term = e.target.value; if (term === 'custom') return; const month = d.getUTCMonth(); const day = d.getUTCDate(); const months = term === 'monthly' ? 1 : term === 'annual' ? 12 : 24; d.setUTCDate(1); d.setUTCMonth(month + months); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); setForm((f) => ({ ...f, validUntil: d.toISOString().slice(0, 10), graceDays: term === 'monthly' ? '7' : '15' })); }}><option value="custom">Özel</option><option value="monthly">Aylık · 7 gün ek süre</option><option value="annual">Yıllık · 15 gün ek süre</option><option value="biennial">İki yıllık · 15 gün ek süre</option></Select>}
          </Field>}
          <Field label="Kira süresi (gün)" hint="Yalnızca düzenli doğrulama ve eski istemciler için" error={fieldErrors.leaseDays}>
            {(id) => <Input id={id} type="number" min={1} max={60} value={form.leaseDays} onChange={(e) => set('leaseDays', e.target.value)} />}
          </Field>
          <Field label="Ek süre (gün)" hint="Abonelik/kira bitişinden sonra; yeniden başlatmayla sıfırlanmaz" error={fieldErrors.graceDays}>
            {(id) => <Input id={id} type="number" min={0} max={90} value={form.graceDays} onChange={(e) => set('graceDays', e.target.value)} />}
          </Field>
        </div>
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" className="mt-1" checked={form.offlineAllowed} onChange={(e) => set('offlineAllowed', e.target.checked)} />
          <span>
            Çevrimdışı etkinleştirmeye izin ver
            <span className="block text-xs text-muted">İnternet erişimi olmayan sunucular için istek koduyla lisans imzalanır. Çevrimdışı bir kurulum iptal bilgisini ancak yeniden bağlandığında alır.</span>
          </span>
        </label>
        <Field label="Notlar (yalnızca siz görürsünüz)" error={fieldErrors.notes}>
          {(id) => <Textarea id={id} rows={3} maxLength={2000} value={form.notes} onChange={(e) => set('notes', e.target.value)} />}
        </Field>
      </form>
    </Sheet>
  );
}
