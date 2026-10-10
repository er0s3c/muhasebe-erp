import { FileDiff, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { dec } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { fmtDate } from '../../lib/license';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { SubcontractDetail, VariationDetail, VariationReason, VariationRow } from '../../lib/types';
import { cn } from '../../lib/cn';
import { SUBCONTRACT_INVALIDATE, VARIATION_REASONS, VariationStatusBadge } from './common';

/** İşaretli tutar: artış +, azalış − (kırmızı). */
export function DeltaText({ value, currency }: { value: string | null; currency: string }) {
  if (value === null) return <span className="text-muted">—</span>;
  const d = dec(value);
  return <span className={cn(d.isNegative() && 'text-danger')}>{`${d.gt(0) ? '+' : ''}${moneyIn(d.toFixed(2), currency)}`}</span>;
}

/** Değişiklik emirleri tablosu (sözleşme sekmesi ve genel liste). */
export function VariationTable({ rows, showContract }: { rows: VariationRow[]; showContract?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <TableWrap className={showContract ? undefined : 'rounded-none border-0'}>
      <Table>
        <thead>
          <tr>
            <Th className="w-24">{t('variations.cols.code')}</Th>
            <Th>{t('variations.cols.title')}</Th>
            {showContract && <Th>{t('variations.cols.contract')}</Th>}
            <Th className="w-44">{t('variations.cols.reason')}</Th>
            <Th className="w-44">{t('variations.cols.status')}</Th>
            <Th num>{t('variations.cols.delta')}</Th>
            <Th num className="w-28">{t('variations.cols.days')}</Th>
            <Th className="w-28">{t('variations.cols.date')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/variation-orders/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/variation-orders/${r.id}`)}>
              <Td className="font-mono text-[13px] text-muted">{r.code}</Td>
              <Td>{r.title}</Td>
              {showContract && (
                <Td>
                  <div>{r.subcontractCode} — {r.partyName}</div>
                  <div className="text-xs text-muted">{r.projectCode} · {r.direction === 'receivable' ? t('variations.direction.receivable') : t('variations.direction.payable')}</div>
                </Td>
              )}
              <Td className="text-muted">{t(`variations.reasons.${r.reason}`)}</Td>
              <Td><VariationStatusBadge status={r.status} /></Td>
              <Td num><DeltaText value={r.amountDelta} currency={r.currencyCode} /></Td>
              <Td num>{r.timeExtensionDays > 0 ? t('variations.daysValue', { n: r.timeExtensionDays }) : '—'}</Td>
              <Td className="text-muted">{fmtDate(r.appliedAt ?? r.createdAt)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

/** Sözleşme sayfası: bedel özeti (ilk bedel + uygulanan DE = güncel; bekleyen DE ayrı), DE listesi ve yeni DE. */
export function VariationsTab({ detail }: { detail: SubcontractDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const navigate = useNavigate();
  const sc = detail.subcontract;
  const { data, isPending, error: VariationsTabQueryError, refetch: VariationsTabQueryRetry, isFetching: VariationsTabQueryFetching } = useCQuery<{ variations: VariationRow[] }>(['variations', 'contract', sc.id], `/api/subcontracts/${sc.id}/variations`);
  const [open, setOpen] = useState(false);
  const rows = data?.variations ?? [];
  const openDraft = rows.find((r) => r.status === 'draft' || r.status === 'rejected' || r.status === 'submitted' || r.status === 'awaiting_client');
  const canCreate = sc.status === 'active' && can('subcontracts.manage');
  const cur = sc.currencyCode;

  if (VariationsTabQueryError && !data) return <ErrorState error={VariationsTabQueryError} onRetry={() => void VariationsTabQueryRetry()} retrying={VariationsTabQueryFetching} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('variations.summary.original')} sub={t('variations.summary.originalSub')}>{moneyIn(sc.originalAmount, cur)}</Stat>
        <Stat label={t('variations.summary.applied')} sub={t('variations.summary.appliedSub', { days: sc.extensionDays })}>
          <DeltaText value={sc.appliedVariations} currency={cur} />
        </Stat>
        <Stat label={t('variations.summary.current')} sub={sc.endDate ? t('variations.summary.currentSub', { date: formatDateTR(sc.endDate) }) : undefined}>{moneyIn(sc.contractAmount, cur)}</Stat>
        <Stat label={t('variations.summary.pending')} sub={t('variations.summary.pendingSub', { n: sc.pendingCount })}>
          <DeltaText value={sc.pendingVariations} currency={cur} />
        </Stat>
      </div>
      <Card>
        <CardHeader
          title={t('variations.title')}
          description={sc.direction === 'receivable' ? t('variations.descReceivable') : t('variations.descPayable')}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <ExportMenu exportKey="variation-orders" params={{ subcontractId: sc.id }} print={false} disabled={rows.length === 0} />
              {canCreate && (
                <Button variant="primary" onClick={() => (openDraft ? navigate(`/variation-orders/${openDraft.id}`) : setOpen(true))}>
                  <Plus className="size-4" aria-hidden />
                  {openDraft ? t('variations.openExisting', { code: openDraft.code }) : t('variations.add')}
                </Button>
              )}
            </div>
          }
        />
        {isPending ? (
          <PageLoading />
        ) : rows.length === 0 ? (
          <EmptyState icon={<FileDiff className="size-5" />} title={t('variations.empty')} description={sc.status === 'active' ? t('variations.emptyDesc') : t('variations.emptyInactive')} />
        ) : (
          <VariationTable rows={rows} />
        )}
      </Card>
      <CreateVariationModal open={open} onOpenChange={setOpen} subcontractId={sc.id} onCreated={(id) => navigate(`/variation-orders/${id}`)} />
    </div>
  );
}

function CreateVariationModal({ open, onOpenChange, subcontractId, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; subcontractId: string; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState<VariationReason>('client_request');
  const [days, setDays] = useState('0');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const create = useCMutation(
    (_: void, call) =>
      call<VariationDetail>(`/api/subcontracts/${subcontractId}/variations`, {
        method: 'POST',
        body: { title: title.trim(), reason, timeExtensionDays: Number(days || 0), ...(description.trim() ? { description: description.trim() } : {}) },
      }),
    SUBCONTRACT_INVALIDATE,
  );
  const valid = title.trim().length >= 2 && Number.isInteger(Number(days)) && Number(days) >= 0;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('variations.createTitle')}
      description={t('variations.createDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={create.isPending}
            onClick={() => {
              setError(null);
              create.mutate(undefined, { onSuccess: (r) => { onOpenChange(false); onCreated(r.variation.id); }, onError: setError });
            }}
          >
            {t('variations.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('variations.form.title')} required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}</Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('variations.form.reason')} required>
            {(id) => (
              <Select id={id} value={reason} onChange={(e) => setReason(e.target.value as VariationReason)}>
                {VARIATION_REASONS.map((r) => <option key={r} value={r}>{t(`variations.reasons.${r}`)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('variations.form.days')} hint={t('variations.form.daysHint')}>
            {(id) => <Input id={id} inputMode="numeric" className="num text-right" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />}
          </Field>
        </div>
        <Field label={t('variations.form.description')}>{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />}</Field>
      </div>
    </Modal>
  );
}
