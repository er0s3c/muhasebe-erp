import { zodResolver } from '@hookform/resolvers/zod';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { z } from 'zod';
import { CURRENCY_CODES, SECTORS, createCompanySchema, type CreateCompanyInput } from '@erp/shared';
import { BrandMark } from '../../components/layout/Brand';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { errorMessage } from '../../lib/errors';
import { useSession } from '../../lib/session';

type FormInput = z.input<typeof createCompanySchema>;

export function CreateCompanyPage() {
  const { t } = useTranslation();
  const { createCompany, companies } = useSession();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: { sector: 'CONSTRUCTION', baseCurrency: 'TRY', reportingCurrency: 'GBP' },
  });

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
        <div className="mb-8 flex items-center gap-3">
          <BrandMark />
          <span className="text-lg font-semibold tracking-tight">{t('app.name')}</span>
        </div>
        <div className="grid gap-6 md:grid-cols-[1fr_280px]">
          <Card className="p-6 sm:p-8">
            <h1 className="text-2xl font-semibold tracking-tight">{t('onboarding.title')}</h1>
            <p className="mt-1.5 text-sm text-muted">{t('onboarding.subtitle')}</p>

            <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-5" noValidate>
              {error && <Callout tone="danger">{error}</Callout>}
              <Field label={t('onboarding.companyName')} error={errors.name?.message} required>
                {(id) => <Input id={id} autoFocus autoComplete="organization" {...register('name')} />}
              </Field>
              <Field label={t('onboarding.sector')} hint={t('onboarding.sectorHint')} required>
                {(id) => (
                  <Select id={id} {...register('sector')}>
                    {SECTORS.map((s) => (
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
                      {CURRENCY_CODES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
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
                      {CURRENCY_CODES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
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
                <Button type="submit" variant="primary" loading={isSubmitting}>
                  {t('onboarding.create')}
                </Button>
                {companies.length > 0 && (
                  <Button onClick={() => navigate('/')}>{t('common.cancel')}</Button>
                )}
              </div>
            </form>
          </Card>

          <aside className="rounded-xl border border-border bg-brand-soft/60 p-6">
            <h2 className="text-sm font-semibold">{t('onboarding.whatHappens')}</h2>
            <ul className="mt-4 flex flex-col gap-3">
              {items.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-brand text-brand-contrast">
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
