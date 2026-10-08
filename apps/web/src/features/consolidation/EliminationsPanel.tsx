import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money, moneyIn } from '../../lib/format';
import type { Elimination, IntercompanyHint } from '../../lib/types';
import { MoneyInput } from '../../components/ui/MoneyInput';

interface Line { code: string; side: 'debit' | 'credit'; amount: string }

/** Elle girilen eliminasyonlar (salt eklenir, iptal edilebilir; yöntem doğrulanmadı) ve şirketler arası ipucu listesi. */
export function EliminationsPanel({ groupId, currency, archived }: { groupId: string; currency: string; archived: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ['consolidation', 'eliminations', groupId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api<{ eliminations: Elimination[] }>(`/api/consolidation/groups/${groupId}/eliminations`) });
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [kind, setKind] = useState('intercompany_balance');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>([{ code: '', side: 'debit', amount: '' }, { code: '', side: 'credit', amount: '' }]);
  const [hintsAsOf, setHintsAsOf] = useState(todayIso());
  const [showHints, setShowHints] = useState(false);
  const hints = useQuery({
    queryKey: ['consolidation', 'hints', groupId, hintsAsOf],
    queryFn: () => api<{ hints: IntercompanyHint[]; note: string }>(`/api/consolidation/groups/${groupId}/intercompany-hints?asOf=${hintsAsOf}`),
    enabled: showHints,
  });
  const create = useMutation({
    mutationFn: () =>
      api(`/api/consolidation/groups/${groupId}/eliminations`, {
        method: 'POST',
        body: { periodFrom: from, periodTo: to, kind, description, lines: lines.map((l) => ({ accountCode: l.code.trim(), [l.side]: l.amount })) },
      }),
    onSuccess: async () => {
      setDescription('');
      setLines([{ code: '', side: 'debit', amount: '' }, { code: '', side: 'credit', amount: '' }]);
      toast.success(t('consolidation.elimSaved'));
      await qc.invalidateQueries({ queryKey: ['consolidation', 'eliminations', groupId] });
      await qc.invalidateQueries({ queryKey: ['consolidation', 'report'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [voidId, setVoidId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const voidIt = useMutation({
    mutationFn: (id: string) => api(`/api/consolidation/groups/${groupId}/eliminations/${id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: async () => {
      setVoidId(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: ['consolidation', 'eliminations', groupId] });
      await qc.invalidateQueries({ queryKey: ['consolidation', 'report'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const sum = (side: 'debit' | 'credit') => lines.filter((l) => l.side === side).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const balanced = Math.abs(sum('debit') - sum('credit')) < 0.00005 && sum('debit') > 0;
  const valid = description.trim().length >= 2 && balanced && lines.every((l) => /^[0-9][0-9A-Za-z.]*$/.test(l.code.trim()) && Number(l.amount) > 0);

  return (
    <div className="flex flex-col gap-5" data-testid="eliminations-panel">
      <Callout tone="warning">{t('consolidation.elimUnverified')}</Callout>
      {!archived && (
        <Card className="p-5">
          <CardHeader title={t('consolidation.newElim')} description={t('consolidation.newElimDesc', { cur: currency })} />
          <div className="mb-3 flex flex-wrap items-end gap-4">
            <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
            <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
            <Field label={t('consolidation.elimKind')}>
              {(id) => (
                <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)} className="w-56">
                  <option value="intercompany_balance">{t('consolidation.kinds.intercompany_balance')}</option>
                  <option value="intercompany_sales">{t('consolidation.kinds.intercompany_sales')}</option>
                  <option value="other">{t('consolidation.kinds.other')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('consolidation.elimDescription')} className="min-w-0 w-full grow sm:min-w-64 sm:w-auto">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          </div>
          <div className="flex flex-col gap-2">
            {lines.map((l, i) => (
              <div key={i} className="flex flex-wrap items-end gap-3" data-testid={`elim-line-${i}`}>
                <Field label={t('consolidation.code')}>{(id) => <Input id={id} value={l.code} onChange={(e) => setLine(i, { code: e.target.value })} className="w-32" placeholder="136" />}</Field>
                <Field label={t('consolidation.side')}>
                  {(id) => (
                    <Select id={id} value={l.side} onChange={(e) => setLine(i, { side: e.target.value as Line['side'] })} className="w-32">
                      <option value="debit">{t('consolidation.debit')}</option>
                      <option value="credit">{t('consolidation.credit')}</option>
                    </Select>
                  )}
                </Field>
                <Field label={t('consolidation.amount', { cur: currency })}>{(id) => <MoneyInput id={id} value={l.amount} onChange={(v) => setLine(i, { amount: v })} className="w-40" />}</Field>
                {lines.length > 2 && <Button size="sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>{t('consolidation.removeLine')}</Button>}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => setLines((ls) => [...ls, { code: '', side: 'debit', amount: '' }])}>{t('consolidation.addLine')}</Button>
            <span className="min-w-0 break-words text-sm text-muted">{t('consolidation.balanceInfo', { d: money(String(sum('debit'))), c: money(String(sum('credit'))) })}</span>
            <Button variant="primary" className="ml-auto" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>{t('consolidation.saveElim')}</Button>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <CardHeader title={t('consolidation.elimList')} />
        {!data || data.eliminations.length === 0 ? (
          <p className="text-sm text-muted">{t('consolidation.noElim')}</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('consolidation.elimDescription')}</Th>
                  <Th>{t('consolidation.period')}</Th>
                  <Th>{t('consolidation.lines')}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.eliminations.map((e) => (
                  <Tr key={e.id} data-testid="elim-row">
                    <Td>
                      {e.description} <Badge>{t(`consolidation.kinds.${e.kind as 'other'}`)}</Badge> {e.voidedAt && <Badge tone="danger">{t('consolidation.voided')}</Badge>}
                      {e.voidReason && <span className="block text-xs text-muted">{e.voidReason}</span>}
                    </Td>
                    <Td>{formatDateTR(e.periodFrom)} – {formatDateTR(e.periodTo)}</Td>
                    <Td className="text-xs">
                      {e.lines.map((l) => (
                        <span key={l.lineNo} className="block">{l.accountCode} {Number(l.debit) > 0 ? `B ${money(l.debit)}` : `A ${money(l.credit)}`}</span>
                      ))}
                    </Td>
                    <Td>
                      {!e.voidedAt && !archived && (voidId === e.id ? (
                        <span className="flex items-center gap-2">
                          <Input value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder={t('consolidation.voidReason')} className="w-48" aria-label={t('consolidation.voidReason')} />
                          <Button size="sm" variant="danger" disabled={reason.trim().length < 3} loading={voidIt.isPending} onClick={() => voidIt.mutate(e.id)}>{t('consolidation.void')}</Button>
                        </span>
                      ) : (
                        <Button size="sm" onClick={() => setVoidId(e.id)}>{t('consolidation.void')}</Button>
                      ))}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <Card className="p-5">
        <CardHeader title={t('consolidation.hintsTitle')} description={t('consolidation.hintsDesc')} />
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label={t('fxPosition.asOf')}>{(id) => <Input id={id} type="date" value={hintsAsOf} onChange={(e) => setHintsAsOf(e.target.value)} className="w-44" />}</Field>
          <Button onClick={() => setShowHints(true)}>{t('consolidation.showHints')}</Button>
        </div>
        {showHints && hints.data && (hints.data.hints.length === 0 ? (
          <p className="text-sm text-muted">{t('consolidation.noHints')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="hints">
            {hints.data.hints.map((h) => (
              <li key={`${h.company.id}-${h.party.id}`}>
                {h.company.name}: <span className="font-mono text-[13px]">{h.party.code}</span> {h.party.name} → {h.matchedCompany.name} · {t('consolidation.hintBalances', { rec: moneyIn(h.receivable, h.currency), pay: moneyIn(h.payable, h.currency) })}
              </li>
            ))}
          </ul>
        ))}
      </Card>
    </div>
  );
}
