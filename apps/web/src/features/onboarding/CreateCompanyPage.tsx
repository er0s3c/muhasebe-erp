import { zodResolver } from '@hookform/resolvers/zod';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { z } from 'zod';
import { JURISDICTION_PROFILES, LEGAL_ENTITY_TYPES, SECTORS, createCompanySchema, type CreateCompanyInput } from '@erp/shared';
import { legalEntityLabels } from '../settings/CompanyProfileSection';
import { BrandLogo } from '../../components/layout/Brand';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { errorMessage } from '../../lib/errors';
import { useLicense } from '../../lib/license';
import { useSession } from '../../lib/session';

type FormInput = z.input<typeof createCompanySchema>;

export function CreateCompanyPage() {
  const { t } = useTranslation();
  const { createCompany, companies } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // Lisans sektörleri satıcı tarafından belirlenir: seçim yalnızca lisanslı sektörlerle sınırlıdır (sunucu da doğrular).
  const license = useLicense().data;
  const locked = license?.enforced && license.license ? license.license : null;
  const sectors: readonly (typeof SECTORS)[number][] = locked ? locked.sectors : SECTORS;
  const limitReached = locked !== null && (license?.usage.companies ?? 0) >= locked.companyLimit;
  // Salt-okunur modda şirket açılamaz (sunucu 402 verir); baştan söyle
  const restricted = license?.enforced === true && license.state === 'restricted';
  // Yeni şirketi yalnızca bir şirkette sahip/yönetici olan açar (ilk şirket hariç; sunucu da denetler)
  const notAllowed = companies.length > 0 && !companies.some((c) => c.role === 'owner' || c.role === 'admin');
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: { sector: 'CONSTRUCTION', baseCurrency: 'TRY', reportingCurrency: 'GBP', legalEntityType: 'company', vatRegistered: true },
  });

  const sectorKey = sectors.join(',');
  const jurisdiction = watch('jurisdiction');
  useEffect(() => {
    if (!sectors.includes(getValues('sector'))) setValue('sector', sectors[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectorKey]);

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await createCompany({
        ...values,
        taxNumber: values.taxNumber || undefined,
        taxOffice: values.taxOffice || undefined,
      });
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  const items = t('onboarding.items', { returnObjects: true }) as string[];

  return (
    <div className="min-h-full bg-bg px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <BrandLogo className="h-10" />
        </div>
        <div className="grid gap-6 md:grid-cols-[1fr_280px]">
          <Card className="p-6 sm:p-8">
            <h1 className="text-heading">{t('onboarding.title')}</h1>
            <p className="mt-1.5 text-sm text-muted">{t('onboarding.subtitle')}</p>

            <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-5" noValidate>
              {error && <Callout tone="danger">{error}</Callout>}
              {restricted && <Callout tone="danger" title={t('license.banner.restrictedTitle')}>{license?.message}</Callout>}
              {notAllowed && <Callout tone="warning">{t('onboarding.notAllowed')}</Callout>}
              {limitReached && locked && <Callout tone="warning">{t('license.sectorLock.limit', { limit: locked.companyLimit })}</Callout>}
              <Field label={t('onboarding.companyName')} error={errors.name?.message} required>
                {(id) => <Input id={id} autoFocus autoComplete="organization" {...register('name')} />}
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Şirketin ülkesi" required error={errors.jurisdiction ? 'Şirketin ülkesini seçin.' : undefined}>
                  {id => <Select id={id} {...register('jurisdiction')}><option value="">Ülke seçin</option><option value="TR">Türkiye</option><option value="KKTC">KKTC</option></Select>}
                </Field>
                <Field label="Şirket türü">{id => <Select id={id} {...register('legalEntityType')}>{LEGAL_ENTITY_TYPES.map(type => <option key={type} value={type}>{legalEntityLabels[type]}</option>)}</Select>}</Field>
              </div>
              {jurisdiction && JURISDICTION_PROFILES[jurisdiction] && <Callout>{jurisdiction === 'TR' ? 'Türkiye vergileri ve TCMB kur kaynağı' : 'KKTC vergileri ve KKTC Merkez Bankası kur kaynağı'} kullanılacak. Vergi sınıfları ve bordro parametreleri şirket kurulumundan sonra doğrulanır.</Callout>}
              <Field label="Faaliyet kodu" error={errors.activityCode?.message}>{id => <Input id={id} maxLength={40} {...register('activityCode')} />}</Field>
              <label className="flex items-center gap-3 text-sm"><input className="size-4" type="checkbox" {...register('vatRegistered')} />KDV mükellefi</label>
              <Field
                label={t('onboarding.sector')}
                hint={
                  locked
                    ? sectors.length === 1
                      ? t('license.sectorLock.single', { sector: t(`sectors.${sectors[0]!}`) })
                      : t('license.sectorLock.multi', { sectors: sectors.map((s) => t(`sectors.${s}`)).join(', ') })
                    : t('onboarding.sectorHint')
                }
                required
              >
                {(id) => (
                  <Select id={id} {...register('sector')}>
                    {sectors.map((s) => (
                      <option key={s} value={s}>
                        {t(`sectors.${s}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={t('onboarding.baseCurrency')} hint={t('onboarding.baseCurrencyHint')}>
                  {(id) => (
                    <Select id={id} {...register('baseCurrency')}>
                      <CurrencyOptions wide />
                    </Select>
                  )}
                </Field>
                <Field label={t('onboarding.reportingCurrency')} hint={t('onboarding.reportingHint')}>
                  {(id) => (
                    <Select
                      id={id}
                      {...register('reportingCurrency', { setValueAs: (v: string) => (v === '' ? null : v) })}
                    >
                      <option value="">{t('onboarding.reportingNone')}</option>
                      <CurrencyOptions wide />
                    </Select>
                  )}
                </Field>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={t('onboarding.taxNumber')} error={errors.taxNumber?.message}>
                  {(id) => <Input id={id} inputMode="numeric" {...register('taxNumber')} />}
                </Field>
                <Field label={t('onboarding.taxOffice')} error={errors.taxOffice?.message}>
                  {(id) => <Input id={id} {...register('taxOffice')} />}
                </Field>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Button type="submit" variant="primary" loading={isSubmitting} disabled={limitReached || restricted || notAllowed}>
                  {t('onboarding.create')}
                </Button>
                {companies.length > 0 && (
                  <Button onClick={() => navigate('/')}>{t('common.cancel')}</Button>
                )}
              </div>
            </form>
          </Card>

          <aside className="rounded-2xl border border-border bg-surface-2 p-6">
            <h2 className="text-sm">{t('onboarding.whatHappens')}</h2>
            <ul className="mt-4 flex flex-col gap-3">
              {items.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-md border border-border-strong text-text">
                    <Check className="size-3" aria-hidden />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </div>
  );
}
