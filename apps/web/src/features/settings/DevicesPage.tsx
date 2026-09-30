import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime, useLicense, type DeviceList, type DeviceRow } from '../../lib/license';
import { useSession } from '../../lib/session';

const tone = { active: 'success', idle: 'neutral', revoked: 'danger' } as const;

export function DevicesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { logout } = useSession();
  const license = useLicense();
  const { data, isPending } = useQuery<DeviceList>({ queryKey: ['devices'], queryFn: () => api<DeviceList>('/api/devices') });
  const [renaming, setRenaming] = useState<DeviceRow | null>(null);
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<DeviceRow | null>(null);

  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['devices'] }), queryClient.invalidateQueries({ queryKey: ['license'] })]);
  };

  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api(`/api/devices/${v.id}`, { method: 'PATCH', body: { name: v.name } }),
    onSuccess: async () => {
      toast.success(t('devices.renamed'));
      setRenaming(null);
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; current: boolean }>(`/api/devices/${id}`, { method: 'DELETE' }),
    onSuccess: async (res) => {
      toast.success(t('devices.revoked'));
      setRevoking(null);
      // Kendi cihazını kaldıran kullanıcının oturumu kapanır
      if (res.current) await logout();
      else await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isPending || !data) return <PageLoading />;
  if (!data.enforced) {
    return (
      <>
        <PageHeader title={t('devices.title')} description={t('devices.subtitle')} />
        <Callout>{t('devices.notEnforced')}</Callout>
      </>
    );
  }

  const idleDays = license.data?.license?.deviceIdleDays ?? 30;

  return (
    <>
      <PageHeader
        title={t('devices.title')}
        description={t('devices.subtitle')}
        actions={
          <div className="text-sm text-muted" data-testid="device-seats">
            {t('devices.seats')}: <span className="text-text">{data.limit ? t('devices.seatsOf', { active: data.active, limit: data.limit }) : data.active}</span>
          </div>
        }
      />
      <div className="mb-4">
        <Callout>{t('devices.info', { days: idleDays })}</Callout>
      </div>

      {data.devices.length === 0 ? (
        <TableWrap>
          <EmptyState title={t('devices.empty')} />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('devices.name')}</Th>
                <Th>{t('devices.user')}</Th>
                <Th>{t('devices.lastSeen')}</Th>
                <Th>{t('devices.statusCol')}</Th>
                <Th className="text-right">{t('devices.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.devices.map((d) => (
                <Tr key={d.id} data-testid={`device-${d.id}`}>
                  <Td>
                    <span className="block">{d.name}</span>
                    {d.userAgent && <span className="block max-w-[240px] truncate text-xs text-muted" title={d.userAgent}>{d.userAgent}</span>}
                  </Td>
                  <Td>
                    <span className="block" title={d.lastUser?.email}>{d.lastUser ? d.lastUser.fullName : t('devices.unknownUser')}</span>
                    {d.ip && <span className="block text-xs text-muted">{t('devices.ip')}: {d.ip}</span>}
                  </Td>
                  <Td className="whitespace-nowrap">{fmtDateTime(d.lastSeenAt)}</Td>
                  <Td>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={tone[d.status]}>{t(`devices.status.${d.status}`)}</Badge>
                      {d.current && <Badge tone="brand">{t('devices.current')}</Badge>}
                    </span>
                  </Td>
                  <Td className="text-right">
                    {d.status !== 'revoked' && (
                      <span className="inline-flex flex-wrap justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => { setRenaming(d); setName(d.name); }}>{t('devices.rename')}</Button>
                        <Button size="sm" variant="danger" onClick={() => setRevoking(d)}>{t('devices.revoke')}</Button>
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <Modal
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        title={t('devices.renameTitle')}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={rename.isPending} disabled={name.trim().length === 0} onClick={() => renaming && rename.mutate({ id: renaming.id, name: name.trim() })}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => { e.preventDefault(); if (renaming && name.trim()) rename.mutate({ id: renaming.id, name: name.trim() }); }}>
          <Field label={t('devices.name')}>
            {(id) => <Input id={id} autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        </form>
      </Modal>

      <Modal
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t('devices.revokeTitle')}
        description={revoking ? t('devices.revokeBody', { name: revoking.name }) : undefined}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={revoke.isPending} onClick={() => revoking && revoke.mutate(revoking.id)}>{t('devices.revoke')}</Button>
          </>
        }
      >
        {revoking?.current && <Callout tone="warning">{t('devices.revokeCurrent')}</Callout>}
      </Modal>
    </>
  );
}
