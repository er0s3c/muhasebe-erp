import { ListTree, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currencySymbol } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { Account } from '../../lib/types';

const norm = (s: string) => s.toLocaleLowerCase('tr-TR');

/** Kodun hiyerarşi derinliği: 1 hane=0, 2 hane=1, 3 hane=2, her nokta +1 */
const levelOf = (code: string) => (code.includes('.') ? 2 + code.split('.').length - 1 : code.length - 1);

function parentCodeOf(code: string): string | null {
  const dot = code.lastIndexOf('.');
  if (dot >= 0) return code.slice(0, dot);
  return code.length > 1 ? code.slice(0, code.length === 3 ? 2 : 1) : null;
}

export function AccountsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('accounts.manage');
  const { data, isPending, error: AccountsPageQueryError, refetch: AccountsPageQueryRetry, isFetching: AccountsPageQueryFetching } = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts');
  const [query, setQuery] = useState('');
  const [onlyPostable, setOnlyPostable] = useState(false);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const add = useCMutation(
    (v: { code: string; name: string; currencyCode: string | null }, call) => call('/api/accounts', { method: 'POST', body: v }),
    [['accounts']],
  );
  const toggle = useCMutation(
    (v: { id: string; isActive: boolean }, call) => call(`/api/accounts/${v.id}`, { method: 'PATCH', body: { isActive: v.isActive } }),
    [['accounts']],
  );

  const rows = useMemo(() => {
    const q = norm(query.trim());
    return (data?.accounts ?? []).filter((a) => (!onlyPostable || a.isPostable) && (!q || norm(`${a.code} ${a.name}`).includes(q)));
  }, [data, query, onlyPostable]);

  const parent = useMemo(() => {
    const pc = parentCodeOf(code.trim());
    return pc ? (data?.accounts.find((a) => a.code === pc) ?? null) : null;
  }, [code, data]);

  const submit = () => {
    setFormError(null);
    add.mutate(
      { code: code.trim(), name: name.trim(), currencyCode: currency || null },
      {
        onSuccess: () => {
          toast.success(t('ledger.accounts.added'));
          setAdding(false);
          setCode('');
          setName('');
          setCurrency('');
        },
        onError: (e) => setFormError(errorMessage(e)),
      },
    );
  };

  if (AccountsPageQueryError && !data) return <ErrorState error={AccountsPageQueryError} onRetry={() => void AccountsPageQueryRetry()} retrying={AccountsPageQueryFetching} />;
  return (
    <>
      <PageHeader
        title={t('ledger.accounts.title')}
        description={t('ledger.accounts.subtitle')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              {t('ledger.accounts.add')}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-5">
        <Callout tone="warning">{t('ledger.accounts.templateWarn')}</Callout>

        <div className="flex flex-wrap items-center gap-4">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" aria-hidden />
            <Input className="pl-9" placeholder={t('ledger.accounts.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('common.search')} />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={onlyPostable} onChange={(e) => setOnlyPostable(e.target.checked)} />
            {t('ledger.accounts.onlyPostable')}
          </label>
        </div>

        {isPending ? (
          <PageLoading />
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState icon={<ListTree className="size-5" />} title={t('common.noResults')} />
          </Card>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-40">{t('common.code')}</Th>
                  <Th>{t('common.name')}</Th>
                  <Th>{t('common.status')}</Th>
                  {canManage && <Th className="w-28" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const level = levelOf(a.code);
                  return (
                    <Tr key={a.id} className={cn(!a.isPostable && 'bg-surface-2/50', !a.isActive && 'opacity-55')}>
                      <Td className="font-mono text-[13px]" style={{ paddingLeft: `${1 + level * 1.1}rem` }}>
                        <span className={cn(!a.isPostable && 'uppercase tracking-[0.03em]')}>{a.code}</span>
                      </Td>
                      <Td className={cn(!a.isPostable && 'text-[13px] uppercase tracking-[0.03em]')}>{a.name}</Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={a.isPostable ? 'brand' : 'neutral'}>{a.isPostable ? t('ledger.accounts.postable') : t('ledger.accounts.group')}</Badge>
                          <Badge>{t(`ledger.accounts.types.${a.type}`)}</Badge>
                          {a.currencyCode && <Badge tone="warning">{currencySymbol(a.currencyCode)}</Badge>}
                          {!a.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
                        </div>
                      </Td>
                      {canManage && (
                        <Td>
                          {a.isPostable && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                toggle.mutate(
                                  { id: a.id, isActive: !a.isActive },
                                  { onSuccess: () => toast.success(t('ledger.accounts.updated')), onError: (e) => toast.error(errorMessage(e)) },
                                )
                              }
                            >
                              {a.isActive ? t('ledger.accounts.deactivate') : t('ledger.accounts.activate')}
                            </Button>
                          )}
                        </Td>
                      )}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>

      <Sheet
        open={adding}
        onOpenChange={setAdding}
        title={t('ledger.accounts.add')}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={add.isPending} disabled={!code.trim() || name.trim().length < 2} onClick={submit}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim() && name.trim().length >= 2) submit();
          }}
        >
          {formError && <Callout tone="danger">{formError}</Callout>}
          <Field
            label={t('common.code')}
            hint={parent ? `${parent.code} — ${parent.name}` : t('ledger.accounts.codeHint')}
            required
          >
            {(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} placeholder="120.001" autoFocus />}
          </Field>
          <Field label={t('common.name')} required>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label={t('ledger.accounts.currencyLimit')}>
            {(id) => (
              <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="">{t('ledger.accounts.noLimit')}</option>
                <CurrencyOptions wide />
              </Select>
            )}
          </Field>
        </form>
      </Sheet>
    </>
  );
}
