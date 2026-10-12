import { useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input, Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { fmtDateTime } from '../../lib/license';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';

interface RepInfo {
  salesRepId: string | null;
  salesRepName: string | null;
  history: { id: string; fromName: string | null; toName: string | null; reason: string | null; changedBy: string | null; changedAt: string }[];
}

/** Müşteri sorumlusu (öneri 13): yeni teklif/siparişler sorumluyu buradan alır; her değişiklik gerekçesiyle saklanır. */
export function PartySalesRep({ partyId }: { partyId: string }) {
  const can = useCan();
  const toast = useToast();
  const key = ['parties', partyId, 'sales-rep'];
  const info = useCQuery<RepInfo>(key, `/api/parties/${partyId}/sales-rep`);
  const reps = useCQuery<{ reps: { id: string; name: string }[] }>(['sales-reps'], '/api/sales-reps');
  const [editing, setEditing] = useState(false);
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const save = useCMutation((_: void, c) => c<RepInfo>(`/api/parties/${partyId}/sales-rep`, { method: 'PUT', body: { userId: userId || null, reason } }), [key, ['party']]);
  const d = info.data;

  return (
    <Card className="mt-5 p-5">
      <section aria-label="Satış sorumlusu" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Satış sorumlusu</h2>
            <p className="text-sm">{d?.salesRepName ?? <span className="text-muted">Atanmamış</span>}</p>
          </div>
          {can('parties.manage') && !editing && (
            <Button
              onClick={() => {
                setUserId(d?.salesRepId ?? '');
                setReason('');
                setError(null);
                setEditing(true);
              }}
            >
              Sorumluyu değiştir
            </Button>
          )}
        </div>
        {editing && (
          <form
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(undefined, {
                onSuccess: () => {
                  toast.success('Satış sorumlusu kaydedildi');
                  setEditing(false);
                },
                onError: setError,
              });
            }}
          >
            <Field label="Sorumlu">
              {(id) => (
                <Select id={id} value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">Atanmamış</option>
                  {(reps.data?.reps ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Gerekçe">{(id) => <Input id={id} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
            <div className="flex items-end gap-2">
              <Button type="submit" variant="primary" loading={save.isPending}>
                Kaydet
              </Button>
              <Button onClick={() => setEditing(false)}>Vazgeç</Button>
            </div>
            {error ? <div className="sm:col-span-3"><ErrorCallout error={error} /></div> : null}
          </form>
        )}
        {d && d.history.length > 0 && (
          <ol className="flex flex-col gap-1 text-xs text-muted">
            {d.history.map((h) => (
              <li key={h.id}>
                <span className="num">{fmtDateTime(h.changedAt)}</span> · {h.fromName ?? 'Atanmamış'} → {h.toName ?? 'Atanmamış'}
                {h.reason && <> · {h.reason}</>}
                {h.changedBy && <> · {h.changedBy}</>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </Card>
  );
}
