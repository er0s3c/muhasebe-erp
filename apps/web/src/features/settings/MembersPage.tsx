import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, ShieldOff, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ROLES, addMemberSchema, type AddMemberInput } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { useConfirmation } from '../../components/ui/useConfirmation';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCQuery, useNavigation } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { Member } from '../../lib/types';
import { MemberAccessSheet } from './MemberAccessSheet';
import { CompanyRolesCard, type CompanyRolesResponse } from './CompanyRolesCard';

type FormInput = z.input<typeof addMemberSchema>;

export function MembersPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { confirm, dialog } = useConfirmation();
  const { user } = useSession();
  const callerRole = useNavigation().data?.role;
  const [accessFor, setAccessFor] = useState<Member | null>(null);
  // Rütbe kuralları (sunucu da denetler): kimse kendi erişimini, kimse sahibin erişimini değiştiremez; yöneticininkini yalnızca sahip
  const canEditAccess = (m: Member) => m.userId !== user?.id && m.role !== 'owner' && (callerRole === 'owner' || m.role !== 'admin');
  const { data, isPending, error: MembersPageQueryError, refetch: MembersPageQueryRetry, isFetching: MembersPageQueryFetching } = useCQuery<{ members: Member[] }>(['members'], '/api/company/members');
  const roles = useCQuery<CompanyRolesResponse>(['company-roles'], '/api/company/roles');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormInput, unknown, AddMemberInput>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { role: 'accountant' },
  });
  const role = watch('role');

  const add = useCMutation((v: AddMemberInput, call) => call('/api/company/members', { method: 'POST', body: v }), [['members']]);
  const changeRole = useCMutation(
    (v: { userId: string; role: string }, call) => call(`/api/company/members/${v.userId}`, { method: 'PATCH', body: { role: v.role } }),
    [['members']],
  );
  const assignRole = useCMutation((v: { userId: string; roleId: string | null }, call) => call(`/api/company/members/${v.userId}/custom-role`, { method: 'PUT', body: { roleId: v.roleId } }), [['members'], ['module-access'], ['navigation'], ['export-access']]);
  const resetMfa = useCMutation((userId: string, call) => call(`/api/company/members/${userId}/mfa`, { method: 'DELETE' }), [['members']]);
  const remove = useCMutation((userId: string, call) => call(`/api/company/members/${userId}`, { method: 'DELETE' }), [['members']]);

  const onSubmit = handleSubmit((values) => {
    if (add.isPending) return;
    setFormError(null);
    add.mutate(
      { ...values, password: values.password || undefined },
      {
        onSuccess: () => {
          toast.success(t('settings.members.added'));
          setAdding(false);
          reset({ role: 'accountant' });
        },
        onError: (e) => setFormError(errorMessage(e)),
      },
    );
  });

  if (MembersPageQueryError && !data) return <ErrorState error={MembersPageQueryError} onRetry={() => void MembersPageQueryRetry()} retrying={MembersPageQueryFetching} />;
  return (
    <>
      {dialog}
      <PageHeader
        title={t('settings.members.title')}
        description={t('settings.members.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            {t('settings.members.add')}
          </Button>
        }
      />

      <CompanyRolesCard />

      {isPending ? (
        <PageLoading />
      ) : !data?.members.length ? (
        <EmptyState icon={<Users className="size-5" />} title={t('settings.members.title')} />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('settings.members.fullName')}</Th>
                <Th>{t('settings.members.email')}</Th>
                <Th>{t('settings.members.role')}</Th>
                <Th className="w-28">{t('settings.members.mfa')}</Th>
                <Th className="w-28" />
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <Tr key={m.userId}>
                  <Td>
                    <span>{m.fullName}</span>
                    {m.userId === user?.id && <Badge tone="brand" className="ml-2">{t('settings.members.you')}</Badge>}
                    {m.customAccessCount > 0 && (
                      <span className="ml-2" data-testid={`custom-access-${m.userId}`} title={t('settings.members.access.customBadgeHint', { count: m.customAccessCount })}>
                        <Badge tone="warning">{t('settings.members.access.customBadge')}</Badge>
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted">{m.email}</Td>
                  <Td>
                    <Select
                      className="h-8 w-44"
                      value={m.role}
                      disabled={assignRole.isPending || changeRole.isPending || (m.role === 'owner' && callerRole !== 'owner')}
                      aria-label={t('settings.members.role')}
                      onChange={(e) =>
                        changeRole.mutate(
                          { userId: m.userId, role: e.target.value },
                          {
                            onSuccess: (res) => {
                              const cleared = (res as { clearedModuleAccess?: number } | undefined)?.clearedModuleAccess ?? 0;
                              toast.success(cleared > 0 ? t('settings.members.access.clearedOnRole', { count: cleared }) : t('settings.members.roleUpdated'));
                            },
                            onError: (err) => toast.error(errorMessage(err)),
                          },
                        )
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {t(`roles.${r}`)}
                        </option>
                      ))}
                    </Select>
                    {m.customRoleName && <p className="mt-1 text-xs text-muted">Özel rol: {m.customRoleName}</p>}
                    {canEditAccess(m) && m.role !== 'admin' && <Select className="mt-2 h-8 w-44" value={m.customRoleId ?? ''} aria-label={`${m.fullName}: özel şirket rolü`} disabled={assignRole.isPending} onChange={e => {
                      const roleId = e.target.value || null;
                      confirm({ title: 'Şirket rolünü uygula', description: 'Rol ataması kişiye özel erişim seçimlerini temizler. Seçilen rolü uygulamak istiyor musunuz?', confirmLabel: 'Rolü uygula', onConfirm: async () => { await assignRole.mutateAsync({ userId: m.userId, roleId }); toast.success('Şirket rolü uygulandı'); } });
                    }}><option value="">Standart kullanıcı rolü</option>{roles.data?.roles.filter(role => role.isActive).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</Select>}
                  </Td>
                  <Td>
                    {m.mfaEnabled ? (
                      <span className="flex items-center gap-1">
                        <Badge tone="success">{t('settings.members.mfaOn')}</Badge>
                        <button
                          className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                          onClick={() => {
                            confirm({ title: t('settings.members.mfaResetAction'), description: t('settings.members.mfaResetConfirm', { name: m.fullName }), danger: true, onConfirm: async () => { await resetMfa.mutateAsync(m.userId); toast.success(t('settings.members.mfaReset')); } });
                          }}
                          aria-label={t('settings.members.mfaResetAction')}
                          title={t('settings.members.mfaResetAction')}
                        >
                          <ShieldOff className="size-4" />
                        </button>
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td>
                    {canEditAccess(m) && (
                      <button
                        className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
                        onClick={() => setAccessFor(m)}
                        aria-label={`${t('settings.members.access.action')}: ${m.fullName}`}
                        title={t('settings.members.access.action')}
                        data-testid={`member-access-${m.userId}`}
                      >
                        <SlidersHorizontal className="size-4" />
                      </button>
                    )}
                    <button
                      className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                      onClick={() => setRemoving(m)}
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <MemberAccessSheet member={accessFor} onClose={() => setAccessFor(null)} />

      <Sheet
        open={adding}
        onOpenChange={setAdding}
        title={t('settings.members.add')}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={add.isPending} onClick={onSubmit}>
              {t('common.add')}
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
          {formError && <Callout tone="danger">{formError}</Callout>}
          <Field label={t('settings.members.fullName')} error={errors.fullName?.message} required>
            {(id) => <Input id={id} {...register('fullName')} />}
          </Field>
          <Field label={t('settings.members.email')} error={errors.email?.message} required>
            {(id) => <Input id={id} type="email" {...register('email')} />}
          </Field>
          <Field label={t('settings.members.role')} hint={t(`settings.members.roleHelp.${role}`)}>
            {(id) => (
              <Select id={id} {...register('role')}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`roles.${r}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('settings.members.initialPassword')} hint={t('settings.members.initialPasswordHint')} error={errors.password?.message}>
            {(id) => <Input id={id} type="text" autoComplete="off" {...register('password')} />}
          </Field>
        </form>
      </Sheet>

      <Modal
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('common.delete')}
        description={t('settings.members.removeConfirm')}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(removing.userId, {
                  onSuccess: () => {
                    toast.success(t('settings.members.removed'));
                    setRemoving(null);
                  },
                  onError: (e) => {
                    toast.error(errorMessage(e));
                    setRemoving(null);
                  },
                })
              }
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm">{removing?.fullName}</p>
      </Modal>
    </>
  );
}
