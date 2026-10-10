import { zodResolver } from '@hookform/resolvers/zod';
import { BadgeCheck, Percent, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { createTaxRateSchema, parseTR, todayIso, type CreateTaxRateInput } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, formatTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { TaxRate } from '../../lib/types';
import { DocumentTaxRulesSection } from './DocumentTaxRulesSection';

type FormInput = z.input<typeof createTaxRateSchema>;

export function TaxRatesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const canManage = can('settings.manage');
  const { data, isPending } = useCQuery<{ taxRates: TaxRate[] }>(['tax-rates'], '/api/tax-rates');
  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<TaxRate | null>(null);
  const [verifier, setVerifier] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormInput, unknown, CreateTaxRateInput>({
    resolver: zodResolver(createTaxRateSchema),
    defaultValues: { validFrom: todayIso() },
  });

  const add = useCMutation((v: CreateTaxRateInput, call) => call('/api/tax-rates', { method: 'POST', body: v }), [['tax-rates'], ['dashboard']]);
  const verify = useCMutation(
    (v: { id: string; verifiedBy: string; sourceNote?: string }, call) =>
      call(`/api/tax-rates/${v.id}/verify`, { method: 'POST', body: { verifiedBy: v.verifiedBy, sourceNote: v.sourceNote } }),
    [['tax-rates'], ['dashboard']],
  );
  const remove = useCMutation((id: string, call) => call(`/api/tax-rates/${id}`, { method: 'DELETE' }), [['tax-rates'], ['dashboard']]);

  const unverified = data?.taxRates.filter((r) => !r.verifiedAt).length ?? 0;

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    add.mutate(
      { ...values, validTo: values.validTo || null, sourceNote: values.sourceNote || undefined },
      {
        onSuccess: () => {
          toast.success(t('settings.taxRates.added'));
          setAdding(false);
          reset({ validFrom: todayIso() });
        },
        onError: (e) => setFormError(errorMessage(e)),
      },
    );
  });

  return (
    <>
      <PageHeader
        title={t('settings.taxRates.title')}
        description={t('settings.taxRates.subtitle')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              {t('settings.taxRates.add')}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-5">
        {unverified > 0 && (
          <Callout tone="warning" title={t('settings.taxRates.warnTitle')}>
            {t('settings.taxRates.warnBody')}
          </Callout>
        )}

        {isPending ? (
          <PageLoading />
        ) : !data?.taxRates.length ? (
          <EmptyState icon={<Percent className="size-5" />} title={t('settings.taxRates.title')} />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('common.code')}</Th>
                  <Th>{t('common.name')}</Th>
                  <Th num>{t('settings.taxRates.rate')}</Th>
                  <Th>{t('settings.taxRates.validFrom')}</Th>
                  <Th>{t('settings.taxRates.validTo')}</Th>
                  <Th>{t('common.status')}</Th>
                  {canManage && <Th className="w-28" />}
                </tr>
              </thead>
              <tbody>
                {data.taxRates.map((r) => (
                  <Tr key={r.id}>
                    <Td>{r.code}</Td>
                    <Td>{r.name}</Td>
                    <Td num>%{formatTR(r.rate, 2)}</Td>
                    <Td>{formatDateTR(r.validFrom)}</Td>
                    <Td className="text-muted">{r.validTo ? formatDateTR(r.validTo) : t('settings.taxRates.openEnded')}</Td>
                    <Td>
                      {r.verifiedAt ? (
                        <span title={`${r.verifiedBy ?? ''} — ${r.sourceNote ?? ''}`}>
                          <Badge tone="success">{t('common.verified')}</Badge>
                        </span>
                      ) : (
                        <Badge tone="warning">{t('common.unverified')}</Badge>
                      )}
                    </Td>
                    {canManage && (
                      <Td>
                        <div className="flex items-center justify-end gap-1">
                          {!r.verifiedAt && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setVerifying(r);
                                setVerifier('');
                                setNote('');
                              }}
                            >
                              <BadgeCheck className="size-4 text-success" aria-hidden />
                              {t('settings.taxRates.verify')}
                            </Button>
                          )}
                          <button
                            className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                            aria-label={t('common.delete')}
                            onClick={() =>
                              remove.mutate(r.id, {
                                onSuccess: () => toast.success(t('common.deleted')),
                                onError: (e) => toast.error(errorMessage(e)),
                              })
                            }
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>

      <DocumentTaxRulesSection rates={data?.taxRates ?? []} />

      <Sheet
        open={adding}
        onOpenChange={setAdding}
        title={t('settings.taxRates.add')}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={add.isPending} onClick={onSubmit}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
          {formError && <Callout tone="danger">{formError}</Callout>}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t('common.code')} error={errors.code?.message} required>
              {(id) => <Input id={id} placeholder="KDV-16" {...register('code')} />}
            </Field>
            <Field label={t('settings.taxRates.rate')} error={errors.rate?.message} required>
              {(id) => <Input id={id} inputMode="decimal" placeholder="16" {...register('rate', { setValueAs: (v: string) => (typeof v === 'string' ? (parseTR(v) ?? v) : v) })} />}
            </Field>
          </div>
          <Field label={t('common.name')} error={errors.name?.message} required>
            {(id) => <Input id={id} {...register('name')} />}
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t('settings.taxRates.validFrom')} error={errors.validFrom?.message} required>
              {(id) => <Input id={id} type="date" {...register('validFrom')} />}
            </Field>
            <Field label={t('settings.taxRates.validTo')} hint={t('common.optional')}>
              {(id) => <Input id={id} type="date" {...register('validTo')} />}
            </Field>
          </div>
          <Field label={t('settings.taxRates.sourceNote')} hint={t('settings.taxRates.sourceNoteHint')}>
            {(id) => <Input id={id} {...register('sourceNote')} />}
          </Field>
        </form>
      </Sheet>

      <Modal
        open={verifying !== null}
        onOpenChange={(o) => !o && setVerifying(null)}
        title={t('settings.taxRates.verifyTitle')}
        description={t('settings.taxRates.verifyDesc')}
        footer={
          <>
            <Button onClick={() => setVerifying(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={verifier.trim().length < 2}
              loading={verify.isPending}
              onClick={() =>
                verifying &&
                verify.mutate(
                  { id: verifying.id, verifiedBy: verifier.trim(), sourceNote: note.trim() || undefined },
                  {
                    onSuccess: () => {
                      toast.success(t('settings.taxRates.verifiedMsg'));
                      setVerifying(null);
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  },
                )
              }
            >
              {t('settings.taxRates.verify')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            <span>{verifying?.code}</span> — %{formatTR(verifying?.rate ?? '0', 2)}
          </p>
          <Field label={t('settings.taxRates.verifiedBy')} required>
            {(id) => <Input id={id} value={verifier} onChange={(e) => setVerifier(e.target.value)} autoFocus />}
          </Field>
          <Field label={t('settings.taxRates.sourceNote')} hint={t('settings.taxRates.sourceNoteHint')}>
            {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </Modal>
    </>
  );
}
