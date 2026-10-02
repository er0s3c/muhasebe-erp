import { Plus, Tags } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { money } from '../../lib/format';
import { useCan, useCMutation } from '../../lib/queries';
import type { ExpenseCard } from '../../lib/types';
import { useLineAccountOptions, useTaxRates } from '../invoices/common';
import { ProjectWbsFields } from '../projects/common';
import { EXPENSE_INVALIDATE, useExpenseCards } from './common';

interface Form {
  id: string | null;
  code: string;
  name: string;
  accountId: string;
  taxCode: string;
  withholdingRate: string;
  projectId: string;
  wbsId: string;
  notes: string;
  isActive: boolean;
}

const empty: Form = { id: null, code: '', name: '', accountId: '', taxCode: '', withholdingRate: '', projectId: '', wbsId: '', notes: '', isActive: true };

/** Gider kartları: gider türü kataloğu (varsayılan hesap, KDV kodu, stopaj yüzdesi, proje). KDV/stopaj kullanıcı verisidir. */
export function ExpenseCardsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('treasury.manage');
  const [showInactive, setShowInactive] = useState(false);
  const { data, isPending } = useExpenseCards(showInactive);
  const accountOptions = useLineAccountOptions('purchases');
  const { data: rates } = useTaxRates();
  const taxCodes = useMemo(() => [...new Set((rates?.taxRates ?? []).map((r) => r.code))].sort(), [rates]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useCMutation(
    (f: Form, call) => {
      const body = {
        code: f.code.trim(),
        name: f.name.trim(),
        accountId: f.accountId,
        taxCode: f.taxCode || null,
        withholdingRate: f.withholdingRate || null,
        projectId: f.projectId || null,
        wbsId: f.projectId ? f.wbsId || null : null,
        notes: f.notes.trim() || null,
        ...(f.id ? { isActive: f.isActive } : {}),
      };
      return f.id ? call(`/api/expense-cards/${f.id}`, { method: 'PATCH', body }) : call('/api/expense-cards', { method: 'POST', body });
    },
    EXPENSE_INVALIDATE,
  );
  const remove = useCMutation((id: string, call) => call(`/api/expense-cards/${id}`, { method: 'DELETE' }), EXPENSE_INVALIDATE);

  const edit = (c: ExpenseCard) =>
    setForm({ id: c.id, code: c.code, name: c.name, accountId: c.accountId, taxCode: c.taxCode ?? '', withholdingRate: c.withholdingRate ?? '', projectId: c.projectId ?? '', wbsId: c.wbsId ?? '', notes: c.notes ?? '', isActive: c.isActive });

  const submit = () => {
    if (!form) return;
    setError(null);
    save.mutate(form, {
      onSuccess: () => {
        toast.success(t('expenses.cards.saved'));
        setForm(null);
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };

  return (
    <>
      <PageHeader
        title={t('expenses.cards.title')}
        description={t('expenses.cards.subtitle')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => { setError(null); setForm(empty); }}>
              <Plus className="size-4" aria-hidden />
              {t('expenses.cards.add')}
            </Button>
          )
        }
      />
      <div className="mb-4">
        <Callout tone="warning">{t('expenses.notice')}</Callout>
      </div>
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        {t('expenses.cards.showInactive')}
      </label>
      {isPending ? (
        <PageLoading />
      ) : !data?.cards.length ? (
        <Card>
          <EmptyState icon={<Tags className="size-5" />} title={t('expenses.cards.empty')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('expenses.cards.code')}</Th>
                <Th>{t('expenses.cards.name')}</Th>
                <Th>{t('expenses.cards.account')}</Th>
                <Th>{t('expenses.cards.taxCode')}</Th>
                <Th num>{t('expenses.cards.withholding')}</Th>
                <Th>{t('expenses.cards.project')}</Th>
                <Th num>{t('expenses.cards.entries')}</Th>
                {canManage && <Th className="w-28" />}
              </tr>
            </thead>
            <tbody>
              {data.cards.map((c) => (
                <Tr key={c.id} className={c.isActive ? undefined : 'opacity-60'}>
                  <Td className="font-mono text-[13px]">{c.code}</Td>
                  <Td>
                    {c.name}
                    {!c.isActive && <Badge tone="danger" className="ml-2">{t('common.inactive')}</Badge>}
                  </Td>
                  <Td>
                    <span className="font-mono text-xs text-muted">{c.accountCode}</span> {c.accountName}
                  </Td>
                  <Td>{c.taxCode ?? <span className="text-muted">{t('expenses.cards.noTax')}</span>}</Td>
                  <Td num>{c.withholdingRate ? `%${money(c.withholdingRate, 2)}` : ''}</Td>
                  <Td>{c.projectCode}</Td>
                  <Td num>{c.entryCount}</Td>
                  {canManage && (
                    <Td className="space-x-2 text-right">
                      <Button size="sm" onClick={() => { setError(null); edit(c); }}>{t('common.edit')}</Button>
                      {c.entryCount === 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => window.confirm(t('expenses.cards.confirmDelete')) && remove.mutate(c.id, { onSuccess: () => toast.success(t('expenses.cards.deleted')), onError: (e) => toast.error(errorMessage(e)) })}
                        >
                          {t('common.delete')}
                        </Button>
                      )}
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
        title={form?.id ? t('expenses.cards.edit') : t('expenses.cards.add')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={save.isPending} disabled={!form || !form.code.trim() || !form.name.trim() || !form.accountId} onClick={submit}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {form && (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('expenses.cards.code')} required>{(id) => <Input id={id} value={form.code} maxLength={20} onChange={(e) => setForm({ ...form, code: e.target.value })} autoFocus />}</Field>
              <Field label={t('expenses.cards.name')} required className="sm:col-span-2">{(id) => <Input id={id} value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            </div>
            <Field label={t('expenses.cards.account')} required>
              {(id) => <Combobox id={id} options={accountOptions} value={form.accountId || null} placeholder={t('expenses.cards.pickAccount')} onChange={(v) => setForm({ ...form, accountId: v })} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('expenses.cards.taxCode')}>
                {(id) => (
                  <Select id={id} value={form.taxCode} onChange={(e) => setForm({ ...form, taxCode: e.target.value })}>
                    <option value="">{t('expenses.cards.noTax')}</option>
                    {taxCodes.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('expenses.cards.withholding')}>
                {(id) => <MoneyInput id={id} value={form.withholdingRate} decimals={0} maxDecimals={4} onChange={(v) => setForm({ ...form, withholdingRate: v })} />}
              </Field>
            </div>
            <ProjectWbsFields projectId={form.projectId} wbsId={form.wbsId} onChange={(n) => setForm({ ...form, projectId: n.projectId, wbsId: n.wbsId })} label={t('expenses.cards.project')} />
            <Field label={t('expenses.cards.notes')}>{(id) => <Input id={id} value={form.notes} maxLength={300} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}</Field>
            {form.id && (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                {t('expenses.cards.active')}
              </label>
            )}
          </form>
        )}
      </Modal>
    </>
  );
}
