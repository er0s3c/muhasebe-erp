import { Pencil, Plus, Power, Star, Trash2, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation } from '../../lib/queries';
import type { WarehouseRow } from '../../lib/types';
import { STOCK_INVALIDATE, useWarehouses } from './common';

export function WarehousesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('inventory.manage');
  const { data, isPending } = useWarehouses();
  const [form, setForm] = useState<{ row: WarehouseRow | null; name: string; code: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WarehouseRow | null>(null);

  const create = useCMutation((v: { name: string; code: string }, call) => call('/api/warehouses', { method: 'POST', body: { name: v.name, ...(v.code ? { code: v.code } : {}) } }), STOCK_INVALIDATE);
  const patch = useCMutation((v: { id: string; body: Record<string, unknown> }, call) => call(`/api/warehouses/${v.id}`, { method: 'PATCH', body: v.body }), STOCK_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/warehouses/${id}`, { method: 'DELETE' }), STOCK_INVALIDATE);

  const done = (msg: string) => ({ onSuccess: () => toast.success(msg), onError: (e: Error) => toast.error(errorMessage(e)) });

  const submit = () => {
    if (!form || form.name.trim().length < 2) return;
    setFormError(null);
    const opts = {
      onSuccess: () => {
        toast.success(t('inventory.warehouses.saved'));
        setForm(null);
      },
      onError: (e: Error) => setFormError(errorMessage(e)),
    };
    if (form.row) patch.mutate({ id: form.row.id, body: { name: form.name.trim() } }, opts);
    else create.mutate({ name: form.name.trim(), code: form.code.trim() }, opts);
  };

  return (
    <>
      <PageHeader
        title={t('inventory.warehouses.title')}
        description={t('inventory.warehouses.subtitle')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setForm({ row: null, name: '', code: '' })}>
              <Plus className="size-4" aria-hidden />
              {t('inventory.warehouses.add')}
            </Button>
          )
        }
      />

      {isPending ? (
        <PageLoading />
      ) : !data?.warehouses.length ? (
        <Card>
          <EmptyState icon={<Warehouse className="size-5" />} title={t('inventory.warehouses.empty')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-32">{t('inventory.warehouses.code')}</Th>
                <Th>{t('inventory.warehouses.name')}</Th>
                <Th num>{t('inventory.warehouses.items')}</Th>
                {canManage && <Th className="w-56" />}
              </tr>
            </thead>
            <tbody>
              {data.warehouses.map((w) => (
                <Tr key={w.id} className={w.isActive ? undefined : 'opacity-60'}>
                  <Td className="font-mono text-[13px]">{w.code}</Td>
                  <Td>
                    <span>{w.name}</span>
                    {w.isDefault && <Badge tone="brand" className="ml-2">{t('inventory.warehouses.default')}</Badge>}
                    {!w.isActive && <Badge tone="danger" className="ml-2">{t('common.inactive')}</Badge>}
                  </Td>
                  <Td num className="text-muted">{w.itemCount}</Td>
                  {canManage && (
                    <Td>
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" aria-label={`${t('inventory.warehouses.rename')}: ${w.name}`} onClick={() => setForm({ row: w, name: w.name, code: w.code })}>
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        {!w.isDefault && w.isActive && (
                          <Button size="sm" variant="ghost" aria-label={`${t('inventory.warehouses.makeDefault')}: ${w.name}`} onClick={() => patch.mutate({ id: w.id, body: { isDefault: true } }, done(t('inventory.warehouses.saved')))}>
                            <Star className="size-3.5" aria-hidden />
                          </Button>
                        )}
                        {!w.isDefault && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`${w.isActive ? t('inventory.warehouses.deactivate') : t('inventory.warehouses.activate')}: ${w.name}`}
                            onClick={() => patch.mutate({ id: w.id, body: { isActive: !w.isActive } }, done(t('inventory.warehouses.saved')))}
                          >
                            <Power className="size-3.5" aria-hidden />
                          </Button>
                        )}
                        {!w.isDefault && (
                          <Button size="sm" variant="ghost" aria-label={`${t('inventory.warehouses.delete')}: ${w.name}`} onClick={() => setDeleting(w)}>
                            <Trash2 className="size-3.5 text-danger" aria-hidden />
                          </Button>
                        )}
                      </div>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <Modal
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={form?.row ? t('inventory.warehouses.editTitle') : t('inventory.warehouses.newTitle')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={create.isPending || patch.isPending} disabled={!form || form.name.trim().length < 2} onClick={submit}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {form && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {formError && <Callout tone="danger">{formError}</Callout>}
            <Field label={t('inventory.warehouses.name')} required>
              {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus maxLength={80} />}
            </Field>
            {!form.row && (
              <Field label={t('inventory.warehouses.code')} hint={t('inventory.warehouses.codeHint')}>
                {(id) => <Input id={id} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} maxLength={12} placeholder="D-001" />}
              </Field>
            )}
          </form>
        )}
      </Modal>

      <Modal
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('inventory.warehouses.delete')}
        description={t('inventory.warehouses.deleteConfirm')}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onSuccess: () => {
                    toast.success(t('inventory.warehouses.deleted'));
                    setDeleting(null);
                  },
                  onError: (e) => {
                    setDeleting(null);
                    toast.error(errorMessage(e));
                  },
                })
              }
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  );
}
