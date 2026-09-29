import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ROLES, addMemberSchema, type AddMemberInput } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCQuery } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { Member } from '../../lib/types';

type FormInput = z.input<typeof addMemberSchema>;

export function MembersPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { user } = useSession();
  const { data, isPending } = useCQuery<{ members: Member[] }>(['members'], '/api/company/members');
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
  const remove = useCMutation((userId: string, call) => call(`/api/company/members/${userId}`, { method: 'DELETE' }), [['members']]);

  const onSubmit = handleSubmit((values) => {
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

  return (
    <>
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
                <Th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <Tr key={m.userId}>
                  <Td>
                    <span>{m.fullName}</span>
                    {m.userId === user?.id && <Badge tone="brand" className="ml-2">{t('settings.members.you')}</Badge>}
                  </Td>
                  <Td className="text-muted">{m.email}</Td>
                  <Td>
                    <Select
                      className="h-8 w-44"
                      value={m.role}
                      aria-label={t('settings.members.role')}
                      onChange={(e) =>
                        changeRole.mutate(
                          { userId: m.userId, role: e.target.value },
                          {
                            onSuccess: () => toast.success(t('settings.members.roleUpdated')),
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
                  </Td>
                  <Td>
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
