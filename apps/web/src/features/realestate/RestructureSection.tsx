import { dec, todayIso } from '@erp/shared';
import { useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Field, Input } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCMutation, useCQuery } from '../../lib/queries';
import { REAL_ESTATE_INVALIDATE } from './common';

interface Restructure {
  id: string;
  date: string;
  reason: string;
  amount: string;
  userName: string | null;
  oldPlan: { seq: number; dueDate: string; remaining: string }[];
  newPlan: { dueDate: string; amount: string }[];
}

const addMonths = (date: string, n: number) => {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Taksit planını yeniden yapılandırma (öneri 92): ödenmemiş kalan yeni vadelere aynı toplamla dağıtılır. Tahsilatlar ve eski
 * taksitler korunur; eski taksidin kalanı yeni plana devredilir.
 */
export function RestructureSection({ contractId, currency, open, canEdit }: { contractId: string; currency: string; open: string; canEdit: boolean }) {
  const toast = useToast();
  const history = useCQuery<{ restructures: Restructure[] }>(['sales-contract', contractId, 'restructures'], `/api/sales-contracts/${contractId}/restructures`);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [count, setCount] = useState('6');
  const [first, setFirst] = useState(addMonths(todayIso(), 1));
  const [rows, setRows] = useState<{ dueDate: string; amount: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const total = rows.reduce((s, r) => s.plus(r.amount || 0), dec(0));
  const split = () => {
    const n = Math.max(1, Math.min(360, Number(count) || 1));
    const each = dec(open).div(n).toDecimalPlaces(2, 1);
    setRows(Array.from({ length: n }, (_, i) => ({ dueDate: addMonths(first, i), amount: (i === n - 1 ? dec(open).minus(each.times(n - 1)) : each).toFixed(2) })));
  };
  const save = useCMutation(
    (_: void, call) => call(`/api/sales-contracts/${contractId}/restructure`, { method: 'POST', body: { date, reason: reason.trim(), installments: rows } }),
    [...REAL_ESTATE_INVALIDATE, ['sales-contract', contractId, 'restructures']],
  );
  const past = history.data?.restructures ?? [];
  if (!canEdit && past.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Taksit yeniden yapılandırma" description="Ödenmemiş kalan yeni vadelere aynı toplamla dağıtılır; tahsilatlar ve eski taksitler değişmez." />
      <div className="space-y-4 p-4 text-sm">
        {past.map((r) => (
          <div key={r.id} className="rounded-md border border-border p-3">
            <p>
              <span className="font-medium">{formatDateTR(r.date)}</span> · {moneyIn(r.amount, currency)} · {r.reason}
              {r.userName && <span className="text-muted"> · {r.userName}</span>}
            </p>
            <p className="text-xs text-muted">
              Eski: {r.oldPlan.map((o) => `#${o.seq} ${formatDateTR(o.dueDate)} kalan ${moneyIn(o.remaining, currency)}`).join(', ')}
            </p>
            <p className="text-xs text-muted">Yeni: {r.newPlan.map((n) => `${formatDateTR(n.dueDate)} ${moneyIn(n.amount, currency)}`).join(', ')}</p>
          </div>
        ))}
        {canEdit && dec(open).gt(0) && !editing && (
          <Button onClick={() => { setEditing(true); setError(null); setRows([]); }}>Planı yeniden yapılandır (kalan {moneyIn(open, currency)})</Button>
        )}
        {editing && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Yapılandırma tarihi">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
              <Field label="Taksit sayısı">{(id) => <Input id={id} type="number" min={1} max={360} value={count} onChange={(e) => setCount(e.target.value)} />}</Field>
              <Field label="İlk vade">{(id) => <Input id={id} type="date" value={first} onChange={(e) => setFirst(e.target.value)} />}</Field>
              <div className="flex items-end">
                <Button onClick={split}>Eşit böl</Button>
              </div>
            </div>
            {rows.length > 0 && (
              <ul className="grid gap-2 sm:grid-cols-3">
                {rows.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <Input aria-label={`Vade ${i + 1}`} type="date" value={r.dueDate} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, dueDate: e.target.value } : y)))} />
                    <Input aria-label={`Tutar ${i + 1}`} inputMode="decimal" className="w-32 text-right" value={r.amount} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))} />
                  </li>
                ))}
              </ul>
            )}
            <p className={total.eq(open) ? 'text-muted' : 'text-danger'}>
              Yeni plan toplamı {moneyIn(total.toFixed(2), currency)} / kalan {moneyIn(open, currency)}
            </p>
            <Field label="Gerekçe" required>{(id) => <Input id={id} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
            <div className="flex gap-2">
              <Button
                variant="primary"
                loading={save.isPending}
                disabled={!rows.length || !total.eq(open) || reason.trim().length < 3}
                onClick={() =>
                  save.mutate(undefined, {
                    onSuccess: () => {
                      toast.success('Taksit planı yeniden yapılandırıldı');
                      setEditing(false);
                    },
                    onError: setError,
                  })
                }
              >
                Kaydet
              </Button>
              <Button onClick={() => setEditing(false)}>Vazgeç</Button>
            </div>
          </div>
        )}
        {error ? <ErrorCallout error={error} /> : null}
      </div>
    </Card>
  );
}
