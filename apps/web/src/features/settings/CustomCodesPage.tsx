import { Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CUSTOM_CODE_SCOPES } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Input } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { SegmentedTabs, TabPanel } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { CustomCode } from '../../lib/types';

type Scope = (typeof CUSTOM_CODE_SCOPES)[number];

export function CustomCodesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('settings.manage');
  const [scope, setScope] = useState<Scope>('account');
  const { data, isPending, error: CustomCodesPageQueryError, refetch: CustomCodesPageQueryRetry, isFetching: CustomCodesPageQueryFetching } = useCQuery<{ customCodes: CustomCode[] }>(['custom-codes', scope], `/api/custom-codes?scope=${scope}`);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const add = useCMutation((v: { code: string; name: string }, call) => call('/api/custom-codes', { method: 'POST', body: { scope, ...v } }), [['custom-codes']]);
  const remove = useCMutation((id: string, call) => call(`/api/custom-codes/${id}`, { method: 'DELETE' }), [['custom-codes']]);

  const submit = () =>
    add.mutate(
      { code: code.trim(), name: name.trim() },
      {
        onSuccess: () => {
          toast.success(t('settings.customCodes.added'));
          setCode('');
          setName('');
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  if (CustomCodesPageQueryError && !data) return <ErrorState error={CustomCodesPageQueryError} onRetry={() => void CustomCodesPageQueryRetry()} retrying={CustomCodesPageQueryFetching} />;
  return (
    <>
      <PageHeader title={t('settings.customCodes.title')} description={t('settings.customCodes.subtitle')} />

      <SegmentedTabs id="settings-CustomCodesPage-0" panelId={() => 'settings-CustomCodesPage-0-panel'}
        className="mb-5"
        value={scope}
        onChange={setScope}
        items={CUSTOM_CODE_SCOPES.map((s) => ({ key: s, label: t(`settings.customCodes.scopes.${s}`) }))}
      />

      <TabPanel id="settings-CustomCodesPage-0-panel" labelledBy={"settings-CustomCodesPage-0-" + (scope)}>
{canManage && (
        <Card className="mb-5 p-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim() && name.trim()) submit();
            }}
          >
            <div className="w-32">
              <label className="mb-1.5 block text-[13px]" htmlFor="cc-code">
                {t('common.code')}
              </label>
              <Input id="cc-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={30} />
            </div>
            <div className="min-w-56 flex-1">
              <label className="mb-1.5 block text-[13px]" htmlFor="cc-name">
                {t('common.name')}
              </label>
              <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </div>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!code.trim() || !name.trim()}>
              {t('common.add')}
            </Button>
          </form>
        </Card>
      )}

      {isPending ? (
        <PageLoading />
      ) : !data?.customCodes.length ? (
        <Card>
          <EmptyState icon={<Tags className="size-5" />} title={t('settings.customCodes.empty')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-40">{t('common.code')}</Th>
                <Th>{t('common.name')}</Th>
                {canManage && <Th className="w-14" />}
              </tr>
            </thead>
            <tbody>
              {data.customCodes.map((c) => (
                <Tr key={c.id}>
                  <Td>{c.code}</Td>
                  <Td>{c.name}</Td>
                  {canManage && (
                    <Td>
                      <button
                        className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                        aria-label={t('common.delete')}
                        onClick={() =>
                          remove.mutate(c.id, {
                            onSuccess: () => toast.success(t('common.deleted')),
                            onError: (e) => toast.error(errorMessage(e)),
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
</TabPanel>
    </>
  );
}
