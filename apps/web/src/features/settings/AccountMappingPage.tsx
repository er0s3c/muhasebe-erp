import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { Account, AccountMapping } from '../../lib/types';

/**
 * Hesap eşlemesi: fatura ve stok belgeleri otomatik yevmiye yazarken kullanılan hesaplar.
 * Varsayılanlar genel Tekdüzen yapıya dayanır ve mali müşavirce doğrulanmamıştır.
 */
export function AccountMappingPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const canEdit = useCan()('accounts.manage');
  const { data, isPending } = useCQuery<{ mappings: AccountMapping[] }>(['account-mappings'], '/api/account-mappings');
  const { data: accData } = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts');
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.mappings.map((m) => [m.key, m.accountId ?? ''])));
  }, [data]);

  const save = useCMutation(
    (mappings: Record<string, string>, call) => call<{ mappings: AccountMapping[] }>('/api/account-mappings', { method: 'PUT', body: { mappings } }),
    [['account-mappings']],
  );

  if (isPending || !data || !accData) return <PageLoading />;

  // Cari kontrol hesabı gerektiren eşlemeler ayrı, diğerleri kontrol hesabı olmayanlardan seçilir
  const options = (key: string) =>
    accData.accounts
      .filter((a) => a.isPostable && a.isActive && !a.currencyCode)
      .filter((a) => (key === 'receivable' ? a.partyControl === 'receivable' : key === 'payable' ? a.partyControl === 'payable' : !a.partyControl))
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}`, keywords: a.code }));

  const dirty = data.mappings.some((m) => (draft[m.key] ?? '') !== (m.accountId ?? ''));
  const missing = data.mappings.filter((m) => !m.accountId);

  return (
    <>
      <PageHeader title={t('mappings.title')} description={t('mappings.subtitle')} />
      <div className="mb-5">
        <Callout tone="warning">{t('mappings.unverified')}</Callout>
      </div>
      {missing.length > 0 && (
        <div className="mb-5">
          <Callout tone="danger">{t('mappings.missing', { names: missing.map((m) => m.label).join(', ') })}</Callout>
        </div>
      )}
      <Card>
        <CardHeader title={t('mappings.cardTitle')} description={t('mappings.cardDesc')} />
        <ul>
          {data.mappings.map((m) => (
            <li key={m.key} className="grid items-center gap-2 border-b border-border px-5 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div>
                <p className="text-sm">{t(`mappings.keys.${m.key}` as never, { defaultValue: m.label })}</p>
                <p className="text-[13px] text-muted">{t(`mappings.hints.${m.key}` as never, { defaultValue: '' })}</p>
              </div>
              <Combobox
                options={options(m.key)}
                value={draft[m.key] || null}
                disabled={!canEdit}
                placeholder={t('mappings.pick')}
                aria-label={m.label}
                onChange={(v) => setDraft((d) => ({ ...d, [m.key]: v }))}
              />
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <Link to="/accounting/accounts" className="text-sm link">
            {t('nav.accounts')}
          </Link>
          {canEdit && (
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => {
                const changed = Object.fromEntries(data.mappings.filter((m) => (draft[m.key] ?? '') !== (m.accountId ?? '') && draft[m.key]).map((m) => [m.key, draft[m.key]!]));
                save.mutate(changed, {
                  onSuccess: () => toast.success(t('mappings.saved')),
                  onError: (e) => toast.error(errorMessage(e)),
                });
              }}
            >
              {t('common.save')}
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}
