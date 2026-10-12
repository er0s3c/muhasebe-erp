import { useState } from 'react';
import { JURISDICTION_PROFILES, LEGAL_ENTITY_TYPES, todayIso, type CompanyProfileInput, type Jurisdiction, type LegalEntityType } from '@erp/shared';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useSession } from '../../lib/session';

interface ProfileCompany {
  id: string;
  jurisdiction: Jurisdiction | null;
  profileVersionId: string | null;
  legalEntityType: LegalEntityType | null;
  vatRegistered: boolean | null;
  activityCode: string | null;
  timeZone: string;
  taxSetupStatus: string;
}
interface ProfileData { company: ProfileCompany; profiles: { id: string; effectiveFrom: string; jurisdiction: Jurisdiction; rulePackVersion: string }[] }
interface Preview {
  canActivate: boolean;
  blockers: { code: string; message: string }[];
  warnings: string[];
  finalizedRecordCount: number;
  draftCounts: Record<string, number>;
  taxRatesToSeed: { code: string; rate: string | number }[];
  revision: string;
}
export const legalEntityLabels: Record<LegalEntityType, string> = {
  sole_proprietor: 'Şahıs işletmesi', company: 'Şirket', nonprofit: 'Kâr amacı gütmeyen kuruluş', other: 'Diğer',
};

export function CompanyProfileSection() {
  const query = useCQuery<ProfileData>(['company-profile'], '/api/company/profile');
  if (query.isPending) return <Card><PageLoading /></Card>;
  if (query.error) return <Callout tone="danger">{errorMessage(query.error)}</Callout>;
  if (!query.data) return null;
  return <ProfileEditor key={`${query.data.company.id}:${query.data.company.profileVersionId ?? 'legacy'}`} data={query.data} />;
}

function ProfileEditor({ data }: { data: ProfileData }) {
  const company = data.company;
  const editable = useCan()('company.manage');
  const toast = useToast();
  const { reload } = useSession();
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction | ''>(company.jurisdiction ?? '');
  const [legalEntityType, setLegalEntityType] = useState<LegalEntityType>(company.legalEntityType ?? 'company');
  const [vatRegistered, setVatRegistered] = useState(company.vatRegistered ?? true);
  const [activityCode, setActivityCode] = useState(company.activityCode ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const selected = jurisdiction ? JURISDICTION_PROFILES[jurisdiction] : null;
  const input: CompanyProfileInput | null = jurisdiction ? { jurisdiction, legalEntityType, vatRegistered, activityCode: activityCode.trim() || null, effectiveFrom } : null;
  const preview = useCMutation((body: CompanyProfileInput, call) => call<Preview>('/api/company/profile/preview', { method: 'POST', body }));
  const activate = useCMutation((body: CompanyProfileInput & { revision: string }, call) => call('/api/company/profile/activate', { method: 'POST', body }),
    [['company'], ['company-profile'], ['navigation'], ['tax-rates']]);
  const currentPreview = preview.data && JSON.stringify(preview.variables) === JSON.stringify(input) ? preview.data : null;
  const busy = preview.isPending || activate.isPending;
  const change = (fn: () => void) => { fn(); preview.reset(); activate.reset(); };

  return <Card>
    <CardHeader title="Ülke ve mevzuat" description="Şirketin vergi, bordro ve resmî kur kaynağını belirleyin." />
    <div className="flex flex-col gap-5 p-5">
      {!company.jurisdiction && <Callout tone="warning" title="Ülke kurulumu tamamlanmadı">Mevcut kayıtlar ve hesaplanan tutarlar korunur. Ülke seçimi etkinleştirme tarihinden başlayan işlemlere uygulanır.</Callout>}
      {company.jurisdiction && <Callout title={`${JURISDICTION_PROFILES[company.jurisdiction].label} profili etkin`}>
        {company.taxSetupStatus === 'ready' ? 'Mevzuat ayarları doğrulandı.' : 'Vergi sınıfları ve bordro parametreleri için kurulum ve doğrulama gereklidir.'} Resmî elektronik belge bağlantısı ayrıca kurulacaktır.
      </Callout>}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Şirketin ülkesi" required hint="Müşterinin veya tedarikçinin adres ülkesinden bağımsızdır.">
          {id => <Select id={id} value={jurisdiction} disabled={!editable || busy} onChange={e => change(() => setJurisdiction(e.target.value as Jurisdiction | ''))}>
            <option value="">Ülke seçin</option><option value="TR">Türkiye</option><option value="KKTC">KKTC</option>
          </Select>}
        </Field>
        <Field label="Şirket türü">{id => <Select id={id} value={legalEntityType} disabled={!editable || busy} onChange={e => change(() => setLegalEntityType(e.target.value as LegalEntityType))}>
          {LEGAL_ENTITY_TYPES.map(type => <option key={type} value={type}>{legalEntityLabels[type]}</option>)}
        </Select>}</Field>
        <Field label="Etkinleştirme tarihi" required>{id => <Input id={id} type="date" value={effectiveFrom} max={todayIso()} disabled={!editable || busy} onChange={e => change(() => setEffectiveFrom(e.target.value))} />}</Field>
        <Field label="Faaliyet kodu" hint="Varsa şirketin resmî faaliyet kodunu girin.">{id => <Input id={id} value={activityCode} maxLength={40} disabled={!editable || busy} onChange={e => change(() => setActivityCode(e.target.value))} />}</Field>
      </div>
      <label className="flex items-center gap-3 text-sm"><input className="size-4" type="checkbox" checked={vatRegistered} disabled={!editable || busy} onChange={e => change(() => setVatRegistered(e.target.checked))} />KDV mükellefi</label>
      {selected && <dl className="grid gap-4 rounded-xl border border-border bg-surface-2 p-4 text-sm sm:grid-cols-3">
        <div><dt className="text-muted">Resmî kur kaynağı</dt><dd className="mt-1">{selected.fxProvider === 'tcmb' ? 'Türkiye Cumhuriyet Merkez Bankası' : 'KKTC Merkez Bankası'}</dd></div>
        <div><dt className="text-muted">Saat dilimi</dt><dd className="mt-1">{jurisdiction === 'TR' ? 'Türkiye yerel saati' : 'KKTC yerel saati'}</dd></div>
        <div><dt className="text-muted">Mevzuat kaynağı</dt><dd className="mt-1"><a className="link" href={selected.vatSourceUrl} target="_blank" rel="noreferrer">{jurisdiction === 'TR' ? 'Gelir İdaresi Başkanlığı' : 'KKTC Gelir ve Vergi Dairesi'}</a></dd></div>
      </dl>}
      {editable && <div><Button loading={preview.isPending} disabled={!input || !effectiveFrom || activate.isPending} onClick={() => { if (input) preview.mutate(input); }}>Değişiklikleri önizle</Button></div>}
      {preview.error && <Callout tone="danger">{errorMessage(preview.error)}</Callout>}
      {currentPreview && <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
        <p className="text-sm">Geçmişte kesinleşmiş {currentPreview.finalizedRecordCount} kayıt korunacak. {Object.values(currentPreview.draftCounts).reduce((a, b) => a + b, 0)} taslak kayıt için mevcut vergi seçimlerini kontrol edin.</p>
        {currentPreview.taxRatesToSeed.length > 0 && <p className="text-sm text-muted">Eklenecek vergi oranları: {currentPreview.taxRatesToSeed.map(rate => `%${Number(rate.rate)}`).join(', ')}. İşleme uygun vergi sınıfı ayrıca seçilir.</p>}
        {currentPreview.warnings.map(message => <Callout key={message} tone="warning">{message}</Callout>)}
        {currentPreview.blockers.map(blocker => <Callout key={blocker.code} tone="danger">{blocker.message}</Callout>)}
        {editable && currentPreview.canActivate && <div><Button variant="primary" loading={activate.isPending} disabled={busy} onClick={() => {
          if (input) activate.mutate({ ...input, revision: currentPreview.revision }, { onSuccess: () => { toast.success('Ülke profili etkinleştirildi.'); void reload(); } });
        }}>Önizlenen ülke profilini etkinleştir</Button></div>}
      </div>}
      {activate.error && <Callout tone="danger">{errorMessage(activate.error)}</Callout>}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm"><Link className="link" to="/settings/tax-rates">Vergi oranları</Link><Link className="link" to="/settings/currencies">Döviz kurları</Link></div>
    </div>
  </Card>;
}
