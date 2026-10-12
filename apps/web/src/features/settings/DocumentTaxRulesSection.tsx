import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  createDocumentTaxRuleSchema,
  PARTY_TAX_STATUS_LABELS,
  todayIso,
  type CreateDocumentTaxRuleInput,
} from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useCan, useCMutation, useCompanyApi, useCQuery } from '../../lib/queries';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import type { TaxRate } from '../../lib/types';

export interface DocumentTaxRuleView extends CreateDocumentTaxRuleInput {
  id: string;
  enabled: boolean;
  verifiedAt: string | null;
  verifiedBy: string | null;
}
const treatmentLabels = {
  standard: 'Vergili işlem',
  zero: 'Sıfır oran',
  exempt: 'Vergi istisnası',
};
const transactionLabels = {
  domestic: 'Yurt içi',
  export: 'İhracat',
  import: 'İthalat',
  other: 'Diğer',
};
const baseForm = {
  code: '',
  name: '',
  validFrom: todayIso(),
  validTo: '',
  version: '',
  productClass: '',
  transactionType: 'domestic',
  partyTaxStatus: 'business',
  invoiceType: 'sales',
  taxTreatment: 'standard',
  vatCode: '',
  exemptionCode: '',
  vatNumerator: '',
  vatDenominator: '10',
  incomeRate: '',
  incomeBasis: 'net',
  stampKind: 'none',
  stampAmount: '',
  stampBasis: 'net',
  stampExempt: '0',
  stampCap: '',
  stampLiability: 'company',
  sourceRefs: '',
  sourceNote: '',
};

export function DocumentTaxRulesSection({ rates }: { rates: TaxRate[] }) {
  const { company } = useCompanyApi();
  const canManage = useCan()('settings.manage');
  const { data, isPending, error } = useCQuery<{ rules: DocumentTaxRuleView[] }>(
    ['document-tax-rules'],
    '/api/document-tax-rules',
  );
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState<DocumentTaxRuleView | null>(null);
  const [ending, setEnding] = useState<DocumentTaxRuleView | null>(null);
  const [endDate, setEndDate] = useState(todayIso());
  const [reviewed, setReviewed] = useState(false);
  const [form, setForm] = useState(baseForm);
  const [formError, setFormError] = useState<string | null>(null);
  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const add = useCMutation(
    (input: CreateDocumentTaxRuleInput, call) =>
      call('/api/document-tax-rules', { method: 'POST', body: input }),
    [['document-tax-rules']],
  );
  const verify = useCMutation(
    (id: string, call) =>
      call(`/api/document-tax-rules/${id}/verify`, { method: 'POST', body: { reviewed: true } }),
    [['document-tax-rules']],
  );
  const toggle = useCMutation(
    (rule: DocumentTaxRuleView, call) =>
      call(`/api/document-tax-rules/${rule.id}`, {
        method: 'PATCH',
        body: { enabled: !rule.enabled },
      }),
    [['document-tax-rules']],
  );
  const endRule = useCMutation((input: { id: string; validTo: string }, call) => call(`/api/document-tax-rules/${input.id}`, { method: 'PATCH', body: { validTo: input.validTo } }), [['document-tax-rules']]);
  const save = () => {
    const parsed = createDocumentTaxRuleSchema.safeParse({
      code: form.code,
      name: form.name,
      jurisdiction: company.jurisdiction,
      validFrom: form.validFrom,
      validTo: form.validTo || null,
      version: form.version,
      productClass: form.productClass,
      transactionType: form.transactionType,
      partyTaxStatus: form.partyTaxStatus,
      invoiceType: form.invoiceType,
      config: {
        taxTreatment: form.taxTreatment,
        vatCode: form.taxTreatment === 'exempt' ? null : form.vatCode || null,
        exemptionCode: form.taxTreatment === 'exempt' ? form.exemptionCode || null : null,
        vatWithholding:
          form.vatNumerator && form.taxTreatment === 'standard'
            ? { numerator: Number(form.vatNumerator), denominator: Number(form.vatDenominator) }
            : null,
        incomeWithholding: form.incomeRate
          ? { ratePct: form.incomeRate, basis: form.incomeBasis }
          : null,
        stamp:
          form.stampKind === 'fixed'
            ? { kind: 'fixed', amount: form.stampAmount }
            : form.stampKind === 'percentage'
              ? {
                  kind: 'percentage',
                  ratePct: form.stampAmount,
                  basis: form.stampBasis,
                  exemptAmount: form.stampExempt,
                  capAmount: form.stampCap || null,
                }
              : null,
        stampLiability: form.stampLiability,
        stampScope: 'document',
      },
      sourceRefs: form.sourceRefs
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
      sourceNote: form.sourceNote,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues.map((issue) => issue.message).join(' · '));
      return;
    }
    setFormError(null);
    add.mutate(parsed.data, {
      onSuccess: () => {
        setAdding(false);
        setForm({ ...baseForm, validFrom: todayIso() });
      },
      onError: (e) => setFormError(errorMessage(e)),
    });
  };
  const textField = (key: keyof typeof form, label: string, type = 'text') => (
    <Field label={label}>
      {(id) => (
        <Input id={id} type={type} value={form[key]} onChange={(e) => set(key, e.target.value)} />
      )}
    </Field>
  );
  const selectField = (key: keyof typeof form, label: string, options: Record<string, string>) => (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={form[key]} onChange={(e) => set(key, e.target.value)}>
          {Object.entries(options).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  return (
    <Card className="mt-6 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg">Tarihli işlem vergileri</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            İstisna, tevkifat, stopaj ve damga/pul kurallarını kaynak ve yürürlük tarihiyle
            tanımlayın. Ürün sınıfı, işlem türü ve carinin vergi durumu birlikte denetlenir. Yeni
            sürüm eski belgeleri değiştirmez.
          </p>
        </div>
        {canManage && (
          <Button
            disabled={!company.jurisdiction}
            onClick={() => {
              setAdding(true);
              setFormError(null);
            }}
          >
            <Plus className="size-4" />
            Kural ekle
          </Button>
        )}
      </div>
      {!company.jurisdiction && (
        <Callout tone="warning" title="Ülke kurulumu gerekli">
          Şirket ayarlarından ülke ve mevzuat profilini tamamlayın.
        </Callout>
      )}
      {error && (
        <Callout tone="danger" title="Kurallar yüklenemedi">
          {errorMessage(error)}
        </Callout>
      )}
      {isPending ? (
        <PageLoading />
      ) : data?.rules.length ? (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Kural / sürüm</Th>
                <Th>İşlem koşulları</Th>
                <Th>Vergi türü</Th>
                <Th>Yürürlük</Th>
                <Th>İnceleme</Th>
                {canManage && <Th>İşlem</Th>}
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <Tr key={rule.id}>
                  <Td>
                    {rule.code}
                    <span className="block text-xs text-muted">
                      {rule.name} · {rule.version}
                    </span>
                  </Td>
                  <Td>
                    {rule.productClass}
                    <span className="block text-xs text-muted">
                      {transactionLabels[rule.transactionType]} ·{' '}
                      {PARTY_TAX_STATUS_LABELS[rule.partyTaxStatus]}
                    </span>
                  </Td>
                  <Td>
                    {treatmentLabels[rule.config.taxTreatment]}
                    <span className="block text-xs text-muted">
                      {rule.config.exemptionCode || rule.config.vatCode}
                    </span>
                  </Td>
                  <Td>
                    {formatDateTR(rule.validFrom)}
                    <span className="block text-xs text-muted">
                      {rule.validTo ? formatDateTR(rule.validTo) : 'Bitiş tarihi yok'}
                    </span>
                  </Td>
                  <Td>
                    {rule.verifiedAt ? 'İncelendi' : 'İnceleme bekliyor'}
                    <span className="block text-xs text-muted">
                      {rule.enabled ? 'Etkin' : 'Pasif'}
                    </span>
                  </Td>
                  {canManage && (
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        {!rule.verifiedAt && (
                          <Button
                            size="sm"
                            onClick={() => {
                              setReviewing(rule);
                              setReviewed(false);
                            }}
                          >
                            İncele
                          </Button>
                        )}
                        <Button
                          size="sm"
                          loading={toggle.isPending}
                          onClick={() => toggle.mutate(rule)}
                        >
                          {rule.enabled ? 'Pasifleştir' : 'Etkinleştir'}
                        </Button>
                        {!rule.validTo && <Button size="sm" onClick={() => { setEnding(rule); setEndDate(todayIso()); }}>Bitiş tarihi</Button>}
                      </div>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      ) : (
        <p className="text-sm text-muted">
          Henüz özel işlem kuralı tanımlanmadı. Standart KDV oranları üstteki tarihli oran
          tablosundan kullanılır.
        </p>
      )}
      {toggle.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(toggle.error)}
        </p>
      )}
      <Sheet
        open={adding}
        onOpenChange={setAdding}
        title="Tarihli vergi kuralı"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Vazgeç</Button>
            <Button variant="primary" loading={add.isPending} onClick={save}>
              Kaydet
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && (
            <Callout tone="danger" title="Kural kaydedilemedi">
              {formError}
            </Callout>
          )}
          <p className="text-sm text-muted">
            Oranlar otomatik tahmin edilmez. Tanım mali incelemeden geçtikten sonra faturada
            seçilebilir; değişiklik için yeni tarihli sürüm oluşturun. Damga/pul istisnası ve tavanı
            aynı kurallı satırların belge toplamına bir kez uygulanır.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {textField('code', 'Kural kodu')}
            {textField('name', 'Adı')}
            {textField('version', 'Mevzuat sürümü')}
            {textField('validFrom', 'Yürürlük başlangıcı', 'date')}
            {textField('validTo', 'Bitiş tarihi (isteğe bağlı)', 'date')}
            {textField('productClass', 'Ürün / hizmet sınıfı')}
            {selectField('transactionType', 'İşlem türü', transactionLabels)}
            {selectField('invoiceType', 'Belge türü', {
              sales: 'Satış',
              purchase: 'Alış',
              expense: 'Gider',
            })}
            {selectField(
              'partyTaxStatus',
              'Carinin vergi durumu',
              Object.fromEntries(
                Object.entries(PARTY_TAX_STATUS_LABELS).filter(([key]) => key !== 'unknown'),
              ),
            )}
            {selectField('taxTreatment', 'Vergi uygulaması', treatmentLabels)}
            {form.taxTreatment === 'exempt'
              ? textField('exemptionCode', 'İstisna kodu')
              : selectField('vatCode', 'KDV kodu', {
                  '': 'Seçin',
                  ...Object.fromEntries(rates.map((rate) => [rate.code, rate.name])),
                })}
            {company.jurisdiction === 'TR' && form.taxTreatment === 'standard' && (
              <>
                {textField('vatNumerator', 'KDV tevkifatı payı (isteğe bağlı)', 'number')}
                {textField('vatDenominator', 'KDV tevkifatı paydası', 'number')}
              </>
            )}
            {textField('incomeRate', 'Stopaj yüzdesi (isteğe bağlı)')}
            {selectField('incomeBasis', 'Stopaj matrahı', { net: 'KDV hariç', gross: 'KDV dahil' })}
            {selectField('stampKind', 'Damga / pul', {
              none: 'Uygulanmaz',
              percentage: 'Yüzde',
              fixed: 'Sabit tutar',
            })}
            {form.stampKind !== 'none' && (
              <>
                {textField(
                  'stampAmount',
                  form.stampKind === 'fixed' ? 'Damga / pul tutarı' : 'Damga / pul yüzdesi',
                )}
                {selectField('stampLiability', 'Damga / pul yükümlüsü', {
                  company: 'Bu şirket',
                  counterparty: 'Karşı taraf',
                })}
              </>
            )}
            {form.stampKind === 'percentage' && (
              <>
                {selectField('stampBasis', 'Damga / pul matrahı', {
                  net: 'KDV hariç',
                  gross: 'KDV dahil',
                })}
                {textField('stampExempt', 'İstisna matrahı')}
                {textField('stampCap', 'Azami tutar (isteğe bağlı)')}
              </>
            )}
          </div>
          <Field label="Resmî kaynak bağlantıları (her satıra bir bağlantı)">
            {(id) => (
              <Textarea
                id={id}
                value={form.sourceRefs}
                onChange={(e) => set('sourceRefs', e.target.value)}
                rows={3}
              />
            )}
          </Field>
          <Field label="Kaynak ve kapsam açıklaması">
            {(id) => (
              <Textarea
                id={id}
                value={form.sourceNote}
                onChange={(e) => set('sourceNote', e.target.value)}
                rows={3}
              />
            )}
          </Field>
        </div>
      </Sheet>
      <Modal
        open={!!reviewing}
        onOpenChange={(open) => {
          if (!open) setReviewing(null);
        }}
        title="Vergi kuralını incele"
        footer={
          <>
            <Button onClick={() => setReviewing(null)}>Vazgeç</Button>
            <Button
              variant="primary"
              disabled={!reviewed}
              loading={verify.isPending}
              onClick={() =>
                reviewing && verify.mutate(reviewing.id, { onSuccess: () => setReviewing(null) })
              }
            >
              İncelendi olarak kaydet
            </Button>
          </>
        }
      >
        {reviewing && (
          <div className="space-y-4">
            <p>
              {reviewing.name} · {reviewing.version}
            </p>
            <p className="text-sm">
              {reviewing.productClass} · {transactionLabels[reviewing.transactionType]} ·{' '}
              {PARTY_TAX_STATUS_LABELS[reviewing.partyTaxStatus]} ·{' '}
              {formatDateTR(reviewing.validFrom)}
            </p>
            <p className="text-sm">
              {treatmentLabels[reviewing.config.taxTreatment]} ·{' '}
              {reviewing.config.vatCode || reviewing.config.exemptionCode}
              {reviewing.config.vatWithholding &&
                ` · Tevkifat ${reviewing.config.vatWithholding.numerator}/${reviewing.config.vatWithholding.denominator}`}
              {reviewing.config.incomeWithholding &&
                ` · Stopaj %${reviewing.config.incomeWithholding.ratePct} (${reviewing.config.incomeWithholding.basis === 'net' ? 'KDV hariç' : 'KDV dahil'})`}
              {reviewing.config.stamp &&
                ` · Damga/pul ${reviewing.config.stamp.kind === 'fixed' ? reviewing.config.stamp.amount : `%${reviewing.config.stamp.ratePct}`} (${reviewing.config.stampLiability === 'company' ? 'bu şirket' : 'karşı taraf'})`}
            </p>
            <p className="whitespace-pre-wrap text-sm text-muted">{reviewing.sourceNote}</p>
            {reviewing.config.stamp?.kind === 'percentage' && <p className="text-sm">Damga/pul matrahı: {reviewing.config.stamp.basis === 'net' ? 'KDV hariç' : 'KDV dahil'} · İstisna matrahı: {reviewing.config.stamp.exemptAmount} · Azami tutar: {reviewing.config.stamp.capAmount ?? 'Sınır yok'} · Kapsam: {reviewing.config.stampScope === 'line' ? 'Her satır' : 'Belge toplamı'}</p>}
            <p className="text-sm text-muted">Bitiş tarihi: {reviewing.validTo ? formatDateTR(reviewing.validTo) : 'Bitiş tarihi yok'}</p>
            {reviewing.sourceRefs.map((url) => (
              <a
                className="block break-all text-sm underline"
                href={url}
                target="_blank"
                rel="noreferrer"
                key={url}
              >
                {url}
              </a>
            ))}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
                className="mt-1"
              />
              Yürürlük tarihini, kapsamı ve hesaplama parametrelerini kaynaklarıyla kontrol ettim.
            </label>
            {verify.error && (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(verify.error)}
              </p>
            )}
          </div>
        )}
      </Modal>
      <Modal open={!!ending} onOpenChange={open => { if (!open) setEnding(null); }} title="Kuralın yürürlük bitişi" footer={<><Button onClick={() => setEnding(null)}>Vazgeç</Button><Button variant="primary" disabled={!endDate} loading={endRule.isPending} onClick={() => ending && endRule.mutate({ id: ending.id, validTo: endDate }, { onSuccess: () => setEnding(null) })}>Bitişi kaydet</Button></>}>
        <div className="space-y-4"><p className="text-sm">{ending?.name} için yürürlük aralığını kapatın. Yeni sürüm sonraki tarihten başlayabilir. Kesinleşmiş belgeler değişmez; bitiş, bu kuralı kullanan bir belgenin tarihinden önce olamaz.</p><Field label="Son geçerli gün">{id => <Input id={id} type="date" min={ending?.validFrom} value={endDate} onChange={event => setEndDate(event.target.value)} />}</Field>{endRule.error && <Callout tone="danger" title="Bitiş kaydedilemedi">{errorMessage(endRule.error)}</Callout>}</div>
      </Modal>
    </Card>
  );
}
