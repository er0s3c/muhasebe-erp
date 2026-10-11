import { todayIso } from '@erp/shared';
import { useEffect, useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';

interface ReportRow {
  repId: string | null;
  repName: string | null;
  quotes: number;
  quotesWon: number;
  quotesLost: number;
  winRatePct: string | null;
  ordersConfirmed: number;
  ordersNetBase: string;
  sales: string;
  cost: string;
  profit: string;
  marginPct: string | null;
  target: string | null;
  achievementPct: string | null;
}
type Mode = 'off' | 'warn' | 'block';
interface Policy { minMarginPct: string | null; marginMode: Mode; creditMode: Mode }
const MODE_LABEL: Record<Mode, string> = { off: 'Kapalı', warn: 'Uyar ve kaydet', block: 'Engelle (gerekçeyle geçilir)' };
const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

/**
 * Satış sorumluları (F6: öneri 13, 35, 38): sorumlu başına teklif kazanma oranı, onaylı sipariş, faturalı net satış, katkı ve hedef
 * gerçekleşmesi; aylık hedefler ve teklif/sipariş ticari politikası.
 */
export function SalesRepsPage() {
  const base = useCompany().baseCurrency;
  const can = useCan();
  const today = todayIso();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const report = useCQuery<{ rows: ReportRow[]; totals: { sales: string; cost: string; profit: string } }>(['sales-reps', 'report', from, to], `/api/reports/sales-reps?from=${from}&to=${to}`);

  return (
    <>
      <PageHeader title="Satış sorumluları" description="Sorumlu başına teklif, sipariş, faturalı satış, katkı ve hedef gerçekleşmesi." />
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Başlangıç">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Bitiş">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        {report.error ? (
          <ErrorCallout error={report.error} />
        ) : !report.data ? (
          <PageLoading />
        ) : report.data.rows.length === 0 ? (
          <p className="text-sm text-muted">Bu aralıkta kayıt yok.</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Sorumlu</Th>
                  <Th num>Teklif</Th>
                  <Th num>Kazanma</Th>
                  <Th num>Onaylı sipariş</Th>
                  <Th num>Faturalı net satış</Th>
                  <Th num>Maliyet</Th>
                  <Th num>Katkı</Th>
                  <Th num>Hedef</Th>
                  <Th num>Gerçekleşme</Th>
                </tr>
              </thead>
              <tbody>
                {report.data.rows.map((r) => (
                  <Tr key={r.repId ?? 'none'}>
                    <Td>{r.repName ?? <span className="text-muted">Atanmamış</span>}</Td>
                    <Td num>{r.quotes}</Td>
                    <Td num>{r.winRatePct === null ? '—' : `%${r.winRatePct}`}</Td>
                    <Td num>
                      {r.ordersConfirmed} · {money(r.ordersNetBase)}
                    </Td>
                    <Td num>{money(r.sales)}</Td>
                    <Td num>{money(r.cost)}</Td>
                    <Td num>
                      {money(r.profit)} {r.marginPct !== null && <span className="text-muted">(%{r.marginPct})</span>}
                    </Td>
                    <Td num>{r.target ? money(r.target) : '—'}</Td>
                    <Td num>{r.achievementPct === null ? '—' : `%${r.achievementPct}`}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <p className="mt-2 text-xs text-muted">
          Tutarlar {base}. Fatura satırı bağlı siparişin sorumlusuna, sipariş yoksa carinin bugünkü sorumlusuna sayılır; iadeler düşülür. Sipariş tutarı onay anındaki
          görüntüden alınır.
        </p>
      </Card>
      {can('settings.manage') && <TargetsCard />}
      <PolicyCard canEdit={can('settings.manage')} />
    </>
  );
}

function TargetsCard() {
  const toast = useToast();
  const [year, setYear] = useState(Number(todayIso().slice(0, 4)));
  const reps = useCQuery<{ reps: { id: string; name: string }[] }>(['sales-reps'], '/api/sales-reps');
  const targets = useCQuery<{ targets: { userId: string; month: number; amount: string }[] }>(['sales-reps', 'targets', year], `/api/sales-rep-targets?year=${year}`);
  const [grid, setGrid] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const t of targets.data?.targets ?? []) next[`${t.userId}|${t.month}`] = String(Number(t.amount));
    setGrid(next);
  }, [targets.data]);
  const save = useCMutation(
    (_: void, c) =>
      c('/api/sales-rep-targets', {
        method: 'PUT',
        body: {
          year,
          targets: (reps.data?.reps ?? []).flatMap((r) => MONTHS.map((_, i) => ({ userId: r.id, month: i + 1, amount: grid[`${r.id}|${i + 1}`]?.trim() || '0' }))),
        },
      }),
    [['sales-reps']],
  );
  return (
    <Card className="mt-5 p-5">
      <section aria-label="Satış hedefleri" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Aylık hedefler</h2>
            <p className="text-xs text-muted">Faturalı net satış hedefi (defter para birimi). Boş ya da 0 hedef silinir.</p>
          </div>
          <div className="flex items-end gap-2">
            <Field label="Yıl">{(id) => <Input id={id} type="number" className="w-24" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} />}</Field>
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate(undefined, {
                  onSuccess: () => {
                    setError(null);
                    toast.success('Hedefler kaydedildi');
                  },
                  onError: setError,
                })
              }
            >
              Kaydet
            </Button>
          </div>
        </div>
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Sorumlu</Th>
                {MONTHS.map((m) => (
                  <Th key={m} num>
                    {m}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(reps.data?.reps ?? []).map((r) => (
                <Tr key={r.id}>
                  <Td>{r.name}</Td>
                  {MONTHS.map((m, i) => (
                    <Td key={m} num>
                      <Input
                        aria-label={`${r.name} ${m} hedefi`}
                        inputMode="decimal"
                        className="w-24 text-right"
                        value={grid[`${r.id}|${i + 1}`] ?? ''}
                        onChange={(e) => setGrid({ ...grid, [`${r.id}|${i + 1}`]: e.target.value })}
                      />
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
        {error ? <ErrorCallout error={error} /> : null}
      </section>
    </Card>
  );
}

function PolicyCard({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const policy = useCQuery<Policy>(['sales-policy'], '/api/sales-policy');
  const [form, setForm] = useState<Policy | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (policy.data) setForm(policy.data);
  }, [policy.data]);
  const save = useCMutation((_: void, c) => c<Policy>('/api/sales-policy', { method: 'PUT', body: { ...form!, minMarginPct: form!.minMarginPct?.trim() ? form!.minMarginPct.trim() : null } }), [['sales-policy']]);
  if (!form) return null;
  return (
    <Card className="mt-5 p-5">
      <section aria-label="Ticari politika" className="flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold">Ticari politika</h2>
          <p className="text-xs text-muted">
            Teklif gönderiminde ve sipariş onayında uygulanır. Engellenen geçişi yalnız fatura kaydetme yetkisi olan kullanıcı gerekçeyle geçebilir; gerekçe ticari görüntüyle saklanır.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Asgari katkı (%)" hint="(Net satış − maliyet) / net satış; boşsa kontrol yok">
            {(id) => <Input id={id} inputMode="decimal" disabled={!canEdit} value={form.minMarginPct ?? ''} onChange={(e) => setForm({ ...form, minMarginPct: e.target.value })} />}
          </Field>
          <Field label="Katkı kontrolü">
            {(id) => (
              <Select id={id} disabled={!canEdit} value={form.marginMode} onChange={(e) => setForm({ ...form, marginMode: e.target.value as Mode })}>
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Kredi limiti kontrolü" hint="Alacak bakiyesi + faturalanmamış onaylı siparişler + bu belge">
            {(id) => (
              <Select id={id} disabled={!canEdit} value={form.creditMode} onChange={(e) => setForm({ ...form, creditMode: e.target.value as Mode })}>
                {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {canEdit && (
          <div>
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate(undefined, {
                  onSuccess: () => {
                    setError(null);
                    toast.success('Ticari politika kaydedildi');
                  },
                  onError: setError,
                })
              }
            >
              Kaydet
            </Button>
          </div>
        )}
        {error ? <ErrorCallout error={error} /> : null}
      </section>
    </Card>
  );
}
