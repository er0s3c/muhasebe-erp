import { computeCountryPayroll, countryPayrollConfigSchema, turkeyPayroll2026, todayIso, type CountryPayrollConfig, type PayrollTaxProfile, type CountryPayrollResult } from '@erp/shared';
import { useMemo, useState } from 'react';
import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Callout, ErrorState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { Modal } from '../../components/ui/Sheet';
import { useCMutation, useCQuery, useCan } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import type { EmployeeRow } from '../../lib/types';
import { PAYROLL_INVALIDATE } from './payroll-common';

interface ConfigRow { id: string; jurisdiction: 'TR' | 'KKTC'; effectiveFrom: string; config: CountryPayrollConfig; sourceNote: string; enabled: boolean; verifiedAt: string | null; verifiedBy: string | null }
interface ProfileRow { id: string; employeeId: string; employeeCode: string; employeeName: string; effectiveFrom: string; profile: PayrollTaxProfile }

const KKTC_TAX_SOURCE = 'https://www.vergi.gov.ct.tr/sites/default/files/2026%20YILINA%20A%C4%B0T%20MATRAH%20VE%20MUAF%C4%B0YET%20TABLOSU_0.pdf';
const suggestion = (jurisdiction: 'TR' | 'KKTC'): CountryPayrollConfig => jurisdiction === 'TR' ? turkeyPayroll2026() : {
  jurisdiction: 'KKTC', taxYear: 2026, rulePackVersion: 'KKTC-WAGE-2026-configured-v1', regime: '', sourceRefs: [KKTC_TAX_SOURCE],
  incomeTaxBands: [{ upTo: '45000', ratePct: '10' }, { upTo: '90000', ratePct: '20' }, { upTo: '210000', ratePct: '25' }, { upTo: '400000', ratePct: '30' }, { upTo: null, ratePct: '37' }],
  salaryPeriods: 12, personalAnnualAllowance: '655000', specialAllowancePct: '10', employeeDeductibleLimitPct: '13',
  employeeInsurancePct: '', employerInsurancePct: '', occupationalRiskPct: '', employeeProvidentPct: '', employerProvidentPct: '', employerLocalEmploymentPct: '', socialFloorMonthly: '', socialCapMonthly: null,
};
const trFields = [
  ['minimumGrossMonthly', 'Aylık brüt asgari ücret'], ['socialFloorDaily', 'Günlük prim tabanı'], ['socialCapDaily', 'Günlük prim tavanı'],
  ['employeeSocialPct', 'SGK işçi (%)'], ['employeeUnemploymentPct', 'İşsizlik işçi (%)'], ['employerSocialPct', 'SGK işveren (%)'], ['employerUnemploymentPct', 'İşsizlik işveren (%)'], ['stampPct', 'Damga vergisi (%)'],
];
const kkFields = [
  ['personalAnnualAllowance', 'Yıllık kişisel indirim'], ['specialAllowancePct', 'Özel indirim (%)'], ['employeeDeductibleLimitPct', 'İndirilebilir çalışan katkısı üst sınırı (%)'],
  ['employeeInsurancePct', 'Sigorta işçi (%)'], ['employerInsurancePct', 'Sigorta işveren (%)'], ['occupationalRiskPct', 'İş kazası ve meslek hastalığı (%)'],
  ['employeeProvidentPct', 'İhtiyat işçi (%)'], ['employerProvidentPct', 'İhtiyat işveren (%)'], ['employerLocalEmploymentPct', 'Yerel istihdam katkısı işveren (%)'], ['socialFloorMonthly', 'Aylık sigorta tabanı'],
];

export function CountryPayrollSettings() {
  const company = useCompany();
  const manage = useCan()('hr.payroll_manage');
  const initialCountry = company.jurisdiction ?? 'TR';
  const { data , error: queryError, isPending: loadingQuery, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ configs: ConfigRow[] }>(['payroll', 'country-configs'], '/api/payroll/country-configs');
  const [config, setConfig] = useState<CountryPayrollConfig>(() => suggestion(initialCountry));
  const [from, setFrom] = useState('2026-01-01');
  const [sourceNote, setSourceNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [verifying, setVerifying] = useState<ConfigRow | null>(null);
  const [checked, setChecked] = useState(false);
  const [gross, setGross] = useState('33030');
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [socialDays, setSocialDays] = useState(30);
  const [cumulative, setCumulative] = useState('0');
  const [exemptCumulative, setExemptCumulative] = useState('0');
  const [minimumExemption, setMinimumExemption] = useState(true);
  const [additionalAllowance, setAdditionalAllowance] = useState('0');
  const [taxCreditPct, setTaxCreditPct] = useState('0');
  const add = useCMutation((_: void, call) => call('/api/payroll/country-configs', { method: 'POST', body: { effectiveFrom: from, config, sourceNote } }), PAYROLL_INVALIDATE);
  const verify = useCMutation((id: string, call) => call(`/api/payroll/country-configs/${id}/verify`, { method: 'POST', body: {} }), PAYROLL_INVALIDATE);
  const toggle = useCMutation((row: ConfigRow, call) => call(`/api/payroll/country-configs/${row.id}`, { method: 'PATCH', body: { enabled: !row.enabled } }), PAYROLL_INVALIDATE);
  const valid = countryPayrollConfigSchema.safeParse(config).success;
  const update = (key: string, value: string) => setConfig((current) => ({ ...current, [key]: value }));
  const preview = useMemo((): { result: CountryPayrollResult | null; error: string | null } => {
    if (!valid) return { result: null, error: 'Kural alanlarını tamamlayın. KKTC sosyal prim oranları ve rejimi ayrıca girilmeli.' };
    try {
      return { result: computeCountryPayroll({
        config, profile: { jurisdiction: config.jurisdiction, regime: config.regime, openingBalancesAsOf: month, openingTaxBase: cumulative, openingExemptionBase: exemptCumulative, minimumWageExemption: minimumExemption, additionalAnnualAllowance: additionalAllowance, taxCreditPct },
        month, basis: 'monthly', rate: gross, socialDays, cumulativeTaxBase: cumulative, cumulativeExemptionBase: exemptCumulative,
        params: {}, items: [], attendance: { normalHours: '0', overtimeHours: '0', hourDays: 0, annualLeaveDays: 0, sickLeaveDays: 0, unpaidLeaveDays: 0, absentDays: 0 },
      }), error: null };
    } catch (err) { return { result: null, error: err instanceof Error ? err.message : 'Hesaplanamadı' }; }
  }, [config, valid, month, gross, socialDays, cumulative, exemptCumulative, minimumExemption, additionalAllowance, taxCreditPct]);

  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (loadingQuery) return <PageLoading />;
  return <>
    <Card>
      <CardHeader title="Ülkeye göre bordro kuralları" description="Tarihli tarife, prim ve istisna paketi. Kaydedilen yeni paket önce doğrulanır, sonra etkinleştirilir." />
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="info">Şirketin ülke profili: {company.jurisdiction === 'TR' ? 'Türkiye' : company.jurisdiction === 'KKTC' ? 'KKTC' : 'Henüz seçilmedi — eski manuel hesap'}. Ülke profili başlayan tarihten sonraki yeni bordrolar bu kuralları kullanır. Eski bordroların kayıtlı hesabı korunur.</Callout>
        <Callout tone="warning">Türkiye paketi standart 4/a çalışanı ve teşviksiz işveren primi içindir. Emekli, özel istisna ve teşvik rejimleri için kullanmayın. KKTC’de sosyal sigorta rejimi, ihtiyat kapsamı ve risk oranı çalışan statüsüne göre ayrıca doğrulanmalıdır; otomatik sosyal prim önerisi yoktur. Aynı dönem paketinin rejimi tüm personel profilleriyle uyuşmalıdır.</Callout>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {(data?.configs.length ?? 0) > 0 && <TableWrap><Table aria-label="Ülke bordro kural sürümleri"><thead><tr><Th>Ülke / rejim</Th><Th>Başlangıç</Th><Th>Kaynak ve sürüm</Th><Th>Durum</Th><Th>İşlemler</Th></tr></thead><tbody>
          {data!.configs.map((row) => <Tr key={row.id}><Td>{row.jurisdiction === 'TR' ? 'Türkiye / standart 4/a' : `KKTC / ${row.config.regime}`}</Td><Td>{formatDateTR(row.effectiveFrom)}</Td><Td><div>{row.config.rulePackVersion}</div><div className="mt-1 text-xs text-muted">{row.sourceNote}</div></Td><Td><div className="flex flex-wrap gap-1"><Badge tone={row.verifiedAt ? 'success' : 'warning'}>{row.verifiedAt ? 'Doğrulandı' : 'Doğrulanmadı'}</Badge><Badge tone={row.enabled ? 'brand' : 'neutral'}>{row.enabled ? 'Etkin' : 'Kapalı'}</Badge></div></Td><Td><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { setConfig(row.config); setFrom(row.effectiveFrom); setSourceNote(row.sourceNote); }}>İncele</Button>{manage && <><Button size="sm" onClick={() => { setVerifying(row); setChecked(false); }}>Doğrula</Button><Button size="sm" loading={toggle.isPending} disabled={!row.verifiedAt && !row.enabled} onClick={() => toggle.mutate(row, { onError: setError })}>{row.enabled ? 'Kapat' : 'Etkinleştir'}</Button></>}</div></Td></Tr>)}
        </tbody></Table></TableWrap>}
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); setError(null); add.mutate(undefined, { onError: setError, onSuccess: () => setSourceNote('') }); }}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Ülke">{(id) => <Select id={id} value={config.jurisdiction} disabled={!manage} onChange={(event) => setConfig(suggestion(event.target.value as 'TR' | 'KKTC'))}><option value="TR">Türkiye</option><option value="KKTC">KKTC</option></Select>}</Field>
            <Field label="Yürürlük başlangıcı (ayın ilk günü)">{(id) => <Input id={id} type="date" value={from} disabled={!manage} onChange={(event) => setFrom(event.target.value)} />}</Field>
            <Field label="Vergi yılı">{(id) => <Input id={id} type="number" value={config.taxYear} disabled={!manage} min={2000} max={2100} onChange={(event) => setConfig({ ...config, taxYear: Number(event.target.value) })} />}</Field>
            <Field label="Kural sürümü">{(id) => <Input id={id} value={config.rulePackVersion} disabled={!manage} onChange={(event) => update('rulePackVersion', event.target.value)} />}</Field>
            {config.jurisdiction === 'KKTC' && <><Field label="Sosyal sigorta rejimi / çalışan grubu">{(id) => <Input id={id} value={config.regime} disabled={!manage} placeholder="Resmî bordro tipi ve kapsam" onChange={(event) => update('regime', event.target.value)} />}</Field><Field label="Yıllık maaş adedi">{(id) => <Select id={id} value={config.salaryPeriods} disabled={!manage} onChange={(event) => setConfig({ ...config, salaryPeriods: Number(event.target.value) as 12 | 13 })}><option value={12}>12 maaş</option><option value={13}>13 maaş</option></Select>}</Field></>}
            {(config.jurisdiction === 'TR' ? trFields : kkFields).map(([key, label]) => <Field key={key} label={label!}>{(id) => <Input id={id} inputMode="decimal" disabled={!manage} value={String((config as unknown as Record<string, unknown>)[key!] ?? '')} onChange={(event) => update(key!, event.target.value)} />}</Field>)}
            {config.jurisdiction === 'KKTC' && <Field label="Aylık sigorta tavanı (boş: tavan yok)">{(id) => <Input id={id} inputMode="decimal" disabled={!manage} value={config.socialCapMonthly ?? ''} onChange={(event) => setConfig({ ...config, socialCapMonthly: event.target.value || null })} />}</Field>}
          </div>
          <fieldset className="rounded-md border border-line p-3"><legend className="px-2 text-sm font-medium">Yıllık gelir vergisi tarifesi</legend><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{config.incomeTaxBands.map((band, index) => <div key={index} className="flex flex-col gap-2"><Field label={`${index + 1}. dilim üst sınırı`}>{(id) => <Input id={id} inputMode="decimal" disabled={!manage || band.upTo === null} value={band.upTo ?? ''} placeholder="Sınırsız" onChange={(event) => setConfig({ ...config, incomeTaxBands: config.incomeTaxBands.map((b, n) => n === index ? { ...b, upTo: event.target.value } : b) })} />}</Field><Field label="Vergi oranı (%)">{(id) => <Input id={id} inputMode="decimal" disabled={!manage} value={band.ratePct} onChange={(event) => setConfig({ ...config, incomeTaxBands: config.incomeTaxBands.map((b, n) => n === index ? { ...b, ratePct: event.target.value } : b) })} />}</Field></div>)}</div></fieldset>
          <Field label="Resmî kaynak bağlantıları (her satıra bir bağlantı)">{(id) => <textarea id={id} className="min-h-24 w-full rounded-md border border-line bg-canvas p-3 text-sm" disabled={!manage} value={config.sourceRefs.join('\n')} onChange={(event) => setConfig({ ...config, sourceRefs: event.target.value.split('\n').filter(Boolean) })} />}</Field>
          <div className="flex flex-wrap gap-3 text-sm">{config.sourceRefs.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer" className="text-brand underline">Resmî kaynağı aç</a>)}</div>
          {manage && <><Field label="Kaynak ve uygunluk notu">{(id) => <Input id={id} value={sourceNote} maxLength={2000} placeholder="Kapsam, tarih ve doğrulama dayanağı" onChange={(event) => setSourceNote(event.target.value)} />}</Field><div><Button type="submit" variant="primary" loading={add.isPending} disabled={!valid || sourceNote.trim().length < 3}>Yeni tarihli kuralı kaydet</Button></div></>}
        </form>
        <div className="border-t border-line pt-4"><h3 className="mb-3 font-semibold">Hesap önizlemesi</h3><p className="mb-3 text-sm text-muted">Ekrandaki değerlerle örnek hesap yapılır; doğrulama veya bordro kaydı oluşturmaz.</p><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Önizleme ayı">{(id) => <Input id={id} type="month" value={month} onChange={(event) => setMonth(event.target.value)} />}</Field><Field label="Brüt ücret (TRY)">{(id) => <Input id={id} inputMode="decimal" value={gross} onChange={(event) => setGross(event.target.value)} />}</Field><Field label="Prim günü">{(id) => <Input id={id} type="number" min={0} max={30} value={socialDays} onChange={(event) => setSocialDays(Number(event.target.value))} />}</Field>
          {config.jurisdiction === 'TR' ? <><Field label="Önceki kümülatif vergi matrahı">{(id) => <Input id={id} inputMode="decimal" value={cumulative} onChange={(event) => setCumulative(event.target.value)} />}</Field><Field label="Önceki asgari ücret istisna matrahı">{(id) => <Input id={id} inputMode="decimal" value={exemptCumulative} onChange={(event) => setExemptCumulative(event.target.value)} />}</Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={minimumExemption} onChange={(event) => setMinimumExemption(event.target.checked)} />Asgari ücret istisnası</label></> : <><Field label="Ek yıllık kişisel/aile indirimi">{(id) => <Input id={id} inputMode="decimal" value={additionalAllowance} onChange={(event) => setAdditionalAllowance(event.target.value)} />}</Field><Field label="Vergi üzerinden ek indirim (%)">{(id) => <Input id={id} inputMode="decimal" value={taxCreditPct} onChange={(event) => setTaxCreditPct(event.target.value)} />}</Field></>}
        </div><div className="mt-4">{preview.error ? <Callout tone="info">{preview.error}</Callout> : preview.result && <CountryPayrollBreakdown result={preview.result} />}</div></div>
      </div>
    </Card>
    <PayrollTaxProfiles configs={data?.configs ?? []} />
    <Modal open={!!verifying} onOpenChange={(open) => !open && setVerifying(null)} title="Bordro kuralını doğrula" description="Bu işlem kaynakları ve seçilen çalışan grubuna uygunluğu kontrol ettiğinizi kaydeder.">
      <div className="flex flex-col gap-4"><p className="text-sm">{verifying?.jurisdiction} / {verifying?.config.regime} — {verifying?.config.rulePackVersion}</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={checked} onChange={(event) => setChecked(event.target.checked)} />Yürürlük tarihini, resmî kaynakları, prim oranlarını ve personel rejimine uygunluğunu kontrol ettim.</label><div className="flex flex-wrap justify-end gap-2"><Button onClick={() => setVerifying(null)}>Vazgeç</Button><Button variant="primary" disabled={!checked || !verifying} loading={verify.isPending} onClick={() => verify.mutate(verifying!.id, { onError: setError, onSuccess: () => setVerifying(null) })}>Doğrulamayı kaydet</Button></div></div>
    </Modal>
  </>;
}

export function CountryPayrollBreakdown({ result }: { result: CountryPayrollResult }) {
  const s = result.legalSnapshot;
  const values: [string, string][] = [['Brüt', result.gross], ['Sigorta işçi', s.employeeInsurance], ['İşsizlik işçi', s.employeeUnemployment], ['İhtiyat işçi', s.employeeProvident], ['Vergi matrahı', result.taxBase], ['İstisna/indirim öncesi gelir vergisi', s.incomeTaxBeforeExemption], ['Gelir vergisi istisna/indirimi', s.incomeTaxExemption], ['Gelir vergisi', result.incomeTax], ['Damga vergisi', s.stampTax], ['Net', result.net], ['Sigorta işveren', s.employerInsurance], ['İşsizlik işveren', s.employerUnemployment], ['İhtiyat işveren', s.employerProvident], ['Yerel istihdam katkısı', s.employerLocalEmployment], ['Prim tabanı farkı (işveren)', s.employerFloorTopUp], ['Toplam işveren yükü', result.employerTotal]];
  return <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{values.filter(([, value]) => Number(value) !== 0 || value === result.net || value === result.incomeTax).map(([label, value]) => <div key={label} className="rounded-md bg-canvas p-3"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 font-semibold tabular-nums">{money(value)} TRY</dd></div>)}</dl>;
}

function PayrollTaxProfiles({ configs }: { configs: ConfigRow[] }) {
  const manage = useCan()('hr.payroll_manage');
  const { data , error: queryError, isPending: loadingQuery, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ profiles: ProfileRow[] }>(['payroll', 'tax-profiles'], '/api/payroll/tax-profiles');
  const { data: emps } = useCQuery<{ employees: EmployeeRow[] }>(['employees', 'list', ''], '/api/employees?');
  const [employeeId, setEmployeeId] = useState('');
  const [configId, setConfigId] = useState('');
  const [from, setFrom] = useState(todayIso().slice(0, 8) + '01');
  const [opening, setOpening] = useState('');
  const [exemption, setExemption] = useState('');
  const [minimum, setMinimum] = useState(true);
  const [allowance, setAllowance] = useState('0');
  const [credit, setCredit] = useState('0');
  const [error, setError] = useState<Error | null>(null);
  const selected = configs.find((row) => row.id === configId);
  const add = useCMutation((_: void, call) => call('/api/payroll/tax-profiles', { method: 'POST', body: { employeeId, effectiveFrom: from, profile: { jurisdiction: selected!.jurisdiction, regime: selected!.config.regime, openingBalancesAsOf: from.slice(0, 7), openingTaxBase: opening, openingExemptionBase: exemption, minimumWageExemption: selected!.jurisdiction === 'TR' && minimum, additionalAnnualAllowance: selected!.jurisdiction === 'KKTC' ? allowance : '0', taxCreditPct: selected!.jurisdiction === 'KKTC' ? credit : '0' } } }), PAYROLL_INVALIDATE);
  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (loadingQuery) return <PageLoading />;
  return <Card><CardHeader title="Personel vergi rejimi ve açılış matrahları" description="Türkiye kümülatif matrahı yıl başında sıfırlanır. Yıl ortasında geçişte önceki bordrolardan devreden tutarları açıkça girin." /><div className="flex flex-col gap-4 p-4">
    <Callout tone="info">Açılış tutarları yürürlük ayından önceki dönemlere aittir; aynı dönem için yeniden toplam yazmayın. Çok işverende Türkiye asgari ücret istisnasını yalnız uygun işveren uygular. KKTC aile ve kişisel ek indirimleri resmî belgeye göre yıllık tutar olarak girilir.</Callout>
    {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
    {data?.profiles.length ? <TableWrap><Table aria-label="Personel vergi profilleri"><thead><tr><Th>Personel</Th><Th>Başlangıç</Th><Th>Ülke / rejim</Th><Th num>Açılış vergi matrahı</Th><Th num>Açılış istisna matrahı</Th></tr></thead><tbody>{data.profiles.map((row) => <Tr key={row.id}><Td>{row.employeeCode} — {row.employeeName}</Td><Td>{formatDateTR(row.effectiveFrom)}</Td><Td>{row.profile.jurisdiction === 'TR' ? 'Türkiye / standart 4/a' : `KKTC / ${row.profile.regime}`}</Td><Td num>{money(row.profile.openingTaxBase)}</Td><Td num>{money(row.profile.openingExemptionBase)}</Td></Tr>)}</tbody></Table></TableWrap> : <p className="text-sm text-muted">Henüz personel vergi profili yok.</p>}
    {manage && <form className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => { event.preventDefault(); setError(null); add.mutate(undefined, { onError: setError, onSuccess: () => { setOpening(''); setExemption(''); } }); }}>
      <Field label="Personel">{(id) => <Select id={id} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Seçin</option>{emps?.employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.code} — {emp.fullName}</option>)}</Select>}</Field>
      <Field label="Ülke ve çalışan rejimi">{(id) => <Select id={id} value={configId} onChange={(event) => setConfigId(event.target.value)}><option value="">Kural sürümünü seçin</option>{configs.map((row) => <option key={row.id} value={row.id}>{row.jurisdiction} / {row.config.regime} / {row.effectiveFrom}</option>)}</Select>}</Field>
      <Field label="Profil yürürlük tarihi">{(id) => <Input id={id} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />}</Field><Field label="Devreden vergi matrahı (yoksa 0)">{(id) => <Input id={id} inputMode="decimal" value={opening} onChange={(event) => setOpening(event.target.value)} />}</Field><Field label="Devreden asgari ücret istisna matrahı (yoksa 0)">{(id) => <Input id={id} inputMode="decimal" value={exemption} onChange={(event) => setExemption(event.target.value)} />}</Field>
      {selected?.jurisdiction === 'KKTC' ? <><Field label="Ek yıllık indirim">{(id) => <Input id={id} inputMode="decimal" value={allowance} onChange={(event) => setAllowance(event.target.value)} />}</Field><Field label="Vergi üzerinden ek indirim (%)">{(id) => <Input id={id} inputMode="decimal" value={credit} onChange={(event) => setCredit(event.target.value)} />}</Field></> : <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={minimum} onChange={(event) => setMinimum(event.target.checked)} />Asgari ücret istisnasına uygun</label>}
      <Button type="submit" variant="primary" loading={add.isPending} disabled={!employeeId || !selected || !opening || !exemption}>Tarihli profili kaydet</Button>
    </form>}
  </div></Card>;
}
