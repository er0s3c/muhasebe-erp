import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery, useNavigation } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { MODULE_LABEL_KEYS } from '../../lib/types';

interface CompanyRow {
  id: string;
  name: string;
  sector: 'CONSTRUCTION' | 'RETAIL_MARKET' | 'COMMERCE';
  baseCurrency: string;
  reportingCurrency: string | null;
  taxNumber: string | null;
  taxOffice: string | null;
  allowNegativeStock: boolean;
}

export function CompanyPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const { reload } = useSession();
  const { data: nav } = useNavigation();
  const { data, isPending } = useCQuery<{ company: CompanyRow }>(['company'], '/api/company');
  const [name, setName] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [taxOffice, setTaxOffice] = useState('');
  const [allowNegativeStock, setAllowNegativeStock] = useState(false);
  const editable = can('company.manage');

  useEffect(() => {
    if (data) {
      setName(data.company.name);
      setTaxNumber(data.company.taxNumber ?? '');
      setTaxOffice(data.company.taxOffice ?? '');
      setAllowNegativeStock(data.company.allowNegativeStock);
    }
  }, [data]);

  const save = useCMutation(
    (_: void, call) =>
      call('/api/company', {
        method: 'PATCH',
        body: { name, taxNumber: taxNumber || null, taxOffice: taxOffice || null, allowNegativeStock },
      }),
    [['company'], ['navigation']],
  );

  if (isPending || !data) return <PageLoading />;
  const c = data.company;

  return (
    <>
      <PageHeader title={t('settings.company.title')} description={t('settings.company.subtitle')} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title={t('settings.company.title')} />
          <form
            className="flex flex-col gap-5 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(undefined, {
                onSuccess: () => {
                  toast.success(t('common.saved'));
                  void reload();
                },
                onError: (err) => toast.error(errorMessage(err)),
              });
            }}
          >
            {!editable && <Callout>{t('settings.company.readOnly')}</Callout>}
            <Field label={t('onboarding.companyName')}>
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />}
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={t('settings.company.taxNumber')}>
                {(id) => <Input id={id} value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} disabled={!editable} inputMode="numeric" />}
              </Field>
              <Field label={t('settings.company.taxOffice')}>
                {(id) => <Input id={id} value={taxOffice} onChange={(e) => setTaxOffice(e.target.value)} disabled={!editable} />}
              </Field>
            </div>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={allowNegativeStock}
                disabled={!editable}
                onChange={(e) => setAllowNegativeStock(e.target.checked)}
              />
              <span>
                <span className="block">{t('settings.company.allowNegativeStock')}</span>
                <span className="block text-[13px] text-muted">{t('settings.company.allowNegativeStockHint')}</span>
              </span>
            </label>
            {editable && (
              <div>
                <Button type="submit" variant="primary" loading={save.isPending} disabled={name.trim().length < 2}>
                  {t('common.save')}
                </Button>
              </div>
            )}
          </form>
        </Card>

        <Card>
          <CardHeader title={t('settings.company.enabledModules')} />
          <dl className="flex flex-col gap-4 p-5 text-sm">
            <div>
              <dt className="text-muted">{t('settings.company.sector')}</dt>
              <dd className="mt-0.5">{t(`sectors.${c.sector}`)}</dd>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-muted">{t('settings.company.baseCurrency')}</dt>
                <dd className="mt-0.5">{c.baseCurrency}</dd>
              </div>
              <div>
                <dt className="text-muted">{t('settings.company.reportingCurrency')}</dt>
                <dd className="mt-0.5">{c.reportingCurrency ?? '—'}</dd>
              </div>
            </div>
            <div>
              <dt className="mb-2 text-muted">{t('settings.company.enabledModules')}</dt>
              <dd className="flex flex-wrap gap-1.5">
                {nav?.modules.map((m) => (
                  <Badge key={m} tone="brand">
                    {t((MODULE_LABEL_KEYS[m as keyof typeof MODULE_LABEL_KEYS] ?? 'modules.dashboard') as never)}
                  </Badge>
                ))}
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
