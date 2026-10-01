import { Plus, Trash2, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dec } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';

interface Bucket { week: number; start: string; end: string; receivables: string; manualIn: string; payables: string; manualOut: string; inflow: string; outflow: string; net: string; closing: string }
interface Item { date: string; week: number; source: 'receivable' | 'payable' | 'manual'; direction: 'in' | 'out'; description: string; partyName: string | null; currencyCode: string; amount: string; amountBase: string; overdue: boolean; itemId?: string }
interface Forecast { from: string; weeks: number; baseCurrency: string; opening: string; openingApproximate: boolean; buckets: Bucket[]; later: { receivables: string; payables: string }; lowest: { week: number; balance: string }; items: Item[]; missingRate: number }

const INVALIDATE = [['cash-forecast']];
const neg = (v: string) => dec(v).isNegative();

export function CashForecastPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('treasury.manage');
  const [weeks, setWeeks] = useState('13');
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const { data, isPending } = useCQuery<Forecast>(['cash-forecast', weeks], `/api/cash-forecast?weeks=${weeks}`);
  const remove = useCMutation((id: string, call) => call(`/api/cash-forecast/items/${id}`, { method: 'DELETE' }), INVALIDATE);
  if (isPending || !data) return <PageLoading />;
  const cur = data.baseCurrency;
  const max = Math.max(1, ...data.buckets.map((b) => Math.abs(Number(b.closing))), Math.abs(Number(data.opening)));
  const last = data.buckets[data.buckets.length - 1]!;

  return (
    <>
      <PageHeader
        title={t('cashForecast.title')}
        description={t('cashForecast.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu exportKey="cash-forecast" params={{ weeks }} />
            {canManage && (
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" aria-hidden />
                {t('cashForecast.add')}
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <Field label={t('cashForecast.weeks')}>
          {(id) => (
            <Select id={id} value={weeks} onChange={(e) => setWeeks(e.target.value)} className="w-32">
              {[4, 8, 13, 26].map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          )}
        </Field>
      </div>
      {data.missingRate > 0 && <div className="mb-4"><Callout tone="warning">{t('cashForecast.noRate', { n: data.missingRate })}</Callout></div>}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label={t('cashForecast.opening')} sub={data.openingApproximate ? t('cashForecast.approx') : t('cashForecast.openingSub')}>{moneyIn(data.opening, cur)}</Stat>
        <Stat label={t('cashForecast.lowest')} sub={data.lowest.week > 0 ? t('cashForecast.lowestSub', { week: data.lowest.week }) : t('cashForecast.lowestNow')}>
          <span className={cn(neg(data.lowest.balance) && 'text-danger')}>{moneyIn(data.lowest.balance, cur)}</span>
        </Stat>
        <Stat label={t('cashForecast.end')} sub={t('cashForecast.endSub', { n: data.weeks })}>
          <span className={cn(neg(last.closing) && 'text-danger')}>{moneyIn(last.closing, cur)}</span>
        </Stat>
      </div>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th className="w-16">{t('cashForecast.cols.week')}</Th>
              <Th>{t('cashForecast.cols.range')}</Th>
              <Th num>{t('cashForecast.cols.receivables')}</Th>
              <Th num>{t('cashForecast.cols.manualIn')}</Th>
              <Th num>{t('cashForecast.cols.payables')}</Th>
              <Th num>{t('cashForecast.cols.manualOut')}</Th>
              <Th num>{t('cashForecast.cols.net')}</Th>
              <Th num>{t('cashForecast.cols.closing')}</Th>
              <Th className="w-40 print:hidden" />
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((b) => (
              <Tr key={b.week}>
                <Td className="text-muted">{b.week}</Td>
                <Td>{formatDateTR(b.start)} – {formatDateTR(b.end)}</Td>
                <Td num>{moneyIn(b.receivables, cur, 0)}</Td>
                <Td num>{moneyIn(b.manualIn, cur, 0)}</Td>
                <Td num>{moneyIn(b.payables, cur, 0)}</Td>
                <Td num>{moneyIn(b.manualOut, cur, 0)}</Td>
                <Td num className={cn(neg(b.net) && 'text-danger')}>{moneyIn(b.net, cur, 0)}</Td>
                <Td num className={cn('font-medium', neg(b.closing) && 'text-danger')}>{moneyIn(b.closing, cur, 0)}</Td>
                <Td className="print:hidden">
                  <div className="flex h-3 items-center" role="img" aria-label={`${t('cashForecast.cols.closing')} ${moneyIn(b.closing, cur, 0)}`}>
                    <div className={cn('h-2.5 rounded-sm', neg(b.closing) ? 'bg-danger' : 'bg-text')} style={{ width: `${Math.max(2, (Math.abs(Number(b.closing)) / max) * 100)}%` }} />
                  </div>
                  {neg(b.closing) && <span className="sr-only">{t('cashForecast.negative')}</span>}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {(dec(data.later.receivables).gt(0) || dec(data.later.payables).gt(0)) && (
        <p className="mt-3 text-sm text-muted">{t('cashForecast.later', { in: moneyIn(data.later.receivables, cur, 0), out: moneyIn(data.later.payables, cur, 0) })}</p>
      )}

      <Card className="mt-6">
        <CardHeader title={t('cashForecast.itemsTitle')} description={t('cashForecast.itemsDesc')} />
        <TableWrap className="rounded-none border-0">
          <Table>
            <thead>
              <tr>
                <Th className="w-28">{t('cashForecast.itemCols.date')}</Th>
                <Th className="w-16">{t('cashForecast.itemCols.week')}</Th>
                <Th className="w-28">{t('cashForecast.itemCols.source')}</Th>
                <Th>{t('cashForecast.itemCols.party')}</Th>
                <Th num>{t('cashForecast.itemCols.amount')}</Th>
                <Th num>{t('cashForecast.itemCols.base')}</Th>
                <Th className="w-20 print:hidden" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((i, n) => (
                <Tr key={`${i.itemId ?? n}-${i.date}`}>
                  <Td>{formatDateTR(i.date)}</Td>
                  <Td className="text-muted">{i.week}</Td>
                  <Td><Badge tone={i.direction === 'in' ? 'success' : 'neutral'}>{t(`cashForecast.sources.${i.source === 'manual' ? (i.direction === 'in' ? 'manualIn' : 'manualOut') : i.source}`)}</Badge></Td>
                  <Td>
                    {i.partyName ? `${i.partyName} — ` : ''}{i.description}
                    {i.overdue && <Badge tone="danger" className="ml-2">{t('cashForecast.overdue')}</Badge>}
                  </Td>
                  <Td num>{i.direction === 'out' ? '−' : ''}{moneyIn(i.amount, i.currencyCode)}</Td>
                  <Td num>{i.direction === 'out' ? '−' : ''}{moneyIn(i.amountBase, cur)}</Td>
                  <Td className="print:hidden">
                    {i.source === 'manual' && canManage && (
                      <div className="flex gap-1">
                        <Button size="sm" onClick={() => setEditing(i)}>{t('common.edit')}</Button>
                        <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${i.description}`} onClick={() => remove.mutate(i.itemId!, { onSuccess: () => toast.success(t('cashForecast.deleted')) })}>
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
        {data.items.length === 0 && <p className="flex items-center gap-2 p-4 text-sm text-muted"><TrendingUp className="size-4" aria-hidden />{t('cashForecast.subtitle')}</p>}
      </Card>
      <p className="mt-4 text-xs text-muted">{t('cashForecast.note')}</p>
      <ItemSheet item={editing} onClose={() => setEditing(null)} base={cur} />
    </>
  );
}

function ItemSheet({ item, onClose, base }: { item: Item | 'new' | null; onClose: () => void; base: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const open = item !== null;
  const edit = item && item !== 'new' ? item : null;
  const [date, setDate] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(base);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!open) return;
    setDate(edit?.date ?? new Date().toISOString().slice(0, 10));
    setDirection(edit?.direction ?? 'out');
    setDescription(edit?.description ?? '');
    setAmount(edit ? String(Number(edit.amount)) : '');
    setCurrency(edit?.currencyCode ?? base);
    setError(null);
  }, [open, edit, base]);
  const save = useCMutation(
    (_: void, call) => {
      const body = { itemDate: date, direction, description: description.trim(), amount: amount.replace(',', '.'), currencyCode: currency };
      return edit ? call(`/api/cash-forecast/items/${edit.itemId}`, { method: 'PUT', body }) : call('/api/cash-forecast/items', { method: 'POST', body });
    },
    INVALIDATE,
  );
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={edit ? t('cashForecast.editTitle') : t('cashForecast.addTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={description.trim().length < 2 || !(Number(amount.replace(',', '.')) > 0)} onClick={() => { setError(null); save.mutate(undefined, { onSuccess: () => { toast.success(t('cashForecast.saved')); onClose(); }, onError: setError }); }}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('cashForecast.form.date')} required>{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label={t('cashForecast.form.direction')}>
          {(id) => (
            <Select id={id} value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
              <option value="out">{t('cashForecast.direction.out')}</option>
              <option value="in">{t('cashForecast.direction.in')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('cashForecast.form.description')} required>{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('cashForecast.form.amount')} required>{(id) => <Input id={id} inputMode="decimal" className="num text-right" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label={t('cashForecast.form.currency')}>{(id) => <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}><CurrencyOptions wide /></Select>}</Field>
        </div>
      </div>
    </Sheet>
  );
}
