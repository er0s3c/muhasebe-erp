import { RETURN_DECISIONS, RETURN_REASONS, dec, type ReturnDecision, type ReturnReason } from '@erp/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/license';
import { useCan, useCMutation, useCQuery, useIdempotencyKey } from '../../lib/queries';
import { qtyText } from '../inventory/common';
import { DELIVERY_INVALIDATE } from './common';

interface InspectionLine {
  lineId: string;
  itemCode: string;
  description: string | null;
  quantity: string;
  decided: string;
  pending: string;
  decisions: { id: string; decision: ReturnDecision; reason: ReturnReason; quantity: string; note: string | null; stockDocumentId: string | null; stockDocumentNo: string | null; decidedAt: string; decidedByName: string | null }[];
}

/** İade kalite kararı (öneri 52): karar bekleyen miktar satışa kapalıdır; satışa aç ya da hurdaya ayır. */
export function ReturnInspectionSection({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const toast = useToast();
  const key = ['return-inspections', noteId];
  const q = useCQuery<{ lines: InspectionLine[] }>(key, `/api/return-inspections?status=all&noteId=${noteId}`);
  const command = useIdempotencyKey();
  const [form, setForm] = useState<{ lineId: string; quantity: string; decision: ReturnDecision; reason: ReturnReason; note: string } | null>(null);
  const decide = useCMutation(
    (body: { noteLineId: string; quantity: string; decision: ReturnDecision; reason: ReturnReason; note?: string }, call) =>
      call<{ lines: InspectionLine[] }>('/api/return-inspections/decide', { method: 'POST', body, idempotencyKey: command.key }),
    [key, ...DELIVERY_INVALIDATE],
  );
  const lines = q.data?.lines ?? [];
  const pendingTotal = lines.reduce((s, l) => s.plus(l.pending), dec(0));

  return (
    <Card className="mt-4 p-4 print:hidden">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{t('deliveries.inspection.title')}</h2>
        {pendingTotal.gt(0) ? (
          <Badge tone="warning" dot>{t('deliveries.inspection.pendingBadge', { qty: qtyText(pendingTotal.toFixed(4)) })}</Badge>
        ) : (
          lines.length > 0 && <Badge tone="success" dot>{t('deliveries.inspection.done')}</Badge>
        )}
      </div>
      <p className="mb-3 text-xs text-muted">{t('deliveries.inspection.hint')}</p>
      {q.error && <Callout tone="danger">{errorMessage(q.error)}</Callout>}
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>{t('deliveries.inspection.item')}</Th>
              <Th num>{t('deliveries.inspection.quantity')}</Th>
              <Th num>{t('deliveries.inspection.pending')}</Th>
              <Th>{t('deliveries.inspection.decisions')}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <Tr key={l.lineId}>
                <Td>
                  <span className="mr-2 font-mono text-xs text-muted">{l.itemCode}</span>
                  {l.description}
                </Td>
                <Td num>{qtyText(l.quantity)}</Td>
                <Td num>{qtyText(l.pending) || '0'}</Td>
                <Td>
                  <ul className="space-y-1 text-xs">
                    {l.decisions.map((d) => (
                      <li key={d.id}>
                        <Badge tone={d.decision === 'scrap' ? 'danger' : 'success'}>{t(`deliveries.inspection.decision.${d.decision}`)}</Badge>{' '}
                        {qtyText(d.quantity)} · {t(`deliveries.inspection.reason.${d.reason}`)}
                        {d.note && <> · {d.note}</>}
                        {d.stockDocumentNo && <span className="ml-1 font-mono text-muted">{d.stockDocumentNo}</span>}
                        <span className="ml-1 text-muted">
                          {fmtDateTime(d.decidedAt)}
                          {d.decidedByName && ` · ${d.decidedByName}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td className="text-right">
                  {dec(l.pending).gt(0) && can('deliveries.post') && (
                    <Button
                      size="sm"
                      onClick={() => {
                        command.renew();
                        setForm({ lineId: l.lineId, quantity: dec(l.pending).toString(), decision: 'restock', reason: 'unwanted', note: '' });
                      }}
                    >
                      {t('deliveries.inspection.decide')}
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {form && (
        <form
          className="mt-3 grid gap-3 rounded-md border border-border p-3 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate(
              { noteLineId: form.lineId, quantity: form.quantity, decision: form.decision, reason: form.reason, note: form.note.trim() || undefined },
              {
                onSuccess: () => {
                  toast.success(t('deliveries.inspection.saved'));
                  command.renew();
                  setForm(null);
                },
                onError: (err) => toast.error(errorMessage(err)),
              },
            );
          }}
        >
          <Field label={t('deliveries.inspection.quantity')} required>
            {(id) => <Input id={id} inputMode="decimal" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />}
          </Field>
          <Field label={t('deliveries.inspection.decisionLabel')} required>
            {(id) => (
              <Select id={id} value={form.decision} onChange={(e) => setForm({ ...form, decision: e.target.value as ReturnDecision })}>
                {RETURN_DECISIONS.map((d) => (
                  <option key={d} value={d}>
                    {t(`deliveries.inspection.decision.${d}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('deliveries.inspection.reasonLabel')} required>
            {(id) => (
              <Select id={id} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value as ReturnReason })}>
                {RETURN_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(`deliveries.inspection.reason.${r}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('deliveries.inspection.note')}>
            {(id) => <Input id={id} maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" variant="primary" disabled={decide.isPending}>
              {t('deliveries.inspection.save')}
            </Button>
            <Button type="button" onClick={() => setForm(null)}>
              {t('common.cancel')}
            </Button>
          </div>
          {form.decision === 'scrap' && <p className="text-xs text-muted sm:col-span-5">{t('deliveries.inspection.scrapHint')}</p>}
        </form>
      )}
    </Card>
  );
}
