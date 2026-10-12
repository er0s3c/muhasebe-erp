import { ATTENDANCE_DAY_TYPES, todayIso } from '@erp/shared';
import { useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { formatDateTR, money } from '../../lib/format';
import { useCMutation, useCQuery } from '../../lib/queries';

const DAY_LABEL: Record<string, string> = {
  worked: 'Çalışıldı',
  absent: 'Devamsız',
  annual_leave: 'Yıllık izin',
  sick_leave: 'Rapor',
  unpaid_leave: 'Ücretsiz izin',
  public_holiday: 'Resmî tatil',
  weekly_rest: 'Hafta tatili',
};
const STATUS = { pending: { label: 'Bekliyor', tone: 'info' }, approved: { label: 'Onaylandı', tone: 'success' }, rejected: { label: 'Reddedildi', tone: 'neutral' } } as const;

interface Summary {
  employee: { id: string; code: string; fullName: string; hireDate: string | null; department: string | null; jobTitle: string | null } | null;
  payslips?: { runId: string; month: string; status: string; gross: string; net: string; deductions: string }[];
  attendance?: { workDate: string; dayType: string; normalHours: string; overtimeHours: string }[];
  closedMonths?: string[];
  corrections?: { id: string; workDate: string; dayType: string; normalHours: string; overtimeHours: string; reason: string; status: keyof typeof STATUS; decisionNote: string | null }[];
}

/**
 * Çalışan portalı (F10: öneri 93, 94): kendi bordro pusulaları, son iki ayın puantajı ve puantaj düzeltme talebi. Yalnız
 * hesabınıza bağlı personel kaydı gösterilir; bağlantıyı İK personel kartından yapar.
 */
export function EmployeePortalPage() {
  const toast = useToast();
  const q = useCQuery<Summary>(['me', 'employee'], '/api/me/employee');
  const [slipId, setSlipId] = useState<string | null>(null);
  const slip = useCQuery<{ slip: Record<string, string> }>(['me', 'slip', slipId ?? ''], slipId ? `/api/me/employee/payslips/${slipId}` : null);
  const [form, setForm] = useState({ workDate: todayIso(), dayType: 'worked', normalHours: '8', overtimeHours: '0', reason: '' });
  const [error, setError] = useState<unknown>(null);
  const request = useCMutation((_: void, c) => c('/api/me/attendance-corrections', { method: 'POST', body: form }), [['me', 'employee']]);

  if (q.isPending) return <PageLoading />;
  if (q.error) return <ErrorCallout error={q.error} />;
  const d = q.data!;
  if (!d.employee)
    return (
      <>
        <PageHeader title="Personel portalım" />
        <Card>
          <EmptyState title="Hesabınız bir personel kaydına bağlı değil" description="İnsan kaynakları sorumlusundan personel kartınıza kullanıcı hesabınızı bağlamasını isteyin." />
        </Card>
      </>
    );
  const hoursAllowed = ['worked', 'public_holiday', 'weekly_rest'].includes(form.dayType);
  return (
    <>
      <PageHeader title="Personel portalım" description={`${d.employee.code} · ${d.employee.fullName}${d.employee.jobTitle ? ` · ${d.employee.jobTitle}` : ''}`} />
      <div className="space-y-5">
        <Card>
          <CardHeader title="Bordro pusulalarım" description="Onaylanmış ya da ödenmiş bordrolar." />
          <div className="p-4">
            {(d.payslips ?? []).length === 0 ? (
              <p className="text-sm text-muted">Henüz bordro yok.</p>
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>Ay</Th>
                      <Th num>Brüt</Th>
                      <Th num>Kesinti</Th>
                      <Th num>Net</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.payslips!.map((p) => (
                      <Tr key={p.runId}>
                        <Td>
                          {p.month} {p.status === 'paid' && <Badge tone="success">Ödendi</Badge>}
                        </Td>
                        <Td num>{money(p.gross)}</Td>
                        <Td num>{money(p.deductions)}</Td>
                        <Td num>{money(p.net)}</Td>
                        <Td className="text-right">
                          <Button size="sm" onClick={() => setSlipId(p.runId)}>
                            Pusula
                          </Button>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Puantajım" description="Bu ay ve geçen ay. Hatalı gün için düzeltme talebi açın; kapalı aylar düzeltilemez." />
          <div className="p-4">
            {(d.attendance ?? []).length === 0 ? (
              <p className="text-sm text-muted">Kayıt yok.</p>
            ) : (
              <ul className="grid gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {d.attendance!.map((a) => (
                  <li key={a.workDate}>
                    <span className="num">{formatDateTR(a.workDate)}</span> · {DAY_LABEL[a.dayType] ?? a.dayType}
                    {Number(a.normalHours) + Number(a.overtimeHours) > 0 && (
                      <span className="text-muted">
                        {' '}
                        · {Number(a.normalHours)} sa{Number(a.overtimeHours) > 0 ? ` + ${Number(a.overtimeHours)} fazla` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Puantaj düzeltme talebi" />
          <div className="grid gap-3 p-4 sm:grid-cols-5">
            <Field label="Tarih">{(id) => <Input id={id} type="date" max={todayIso()} value={form.workDate} onChange={(e) => setForm({ ...form, workDate: e.target.value })} />}</Field>
            <Field label="Gün türü">
              {(id) => (
                <Select id={id} value={form.dayType} onChange={(e) => setForm({ ...form, dayType: e.target.value, ...(['worked', 'public_holiday', 'weekly_rest'].includes(e.target.value) ? {} : { normalHours: '0', overtimeHours: '0' }) })}>
                  {ATTENDANCE_DAY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {DAY_LABEL[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Normal saat">{(id) => <Input id={id} inputMode="decimal" disabled={!hoursAllowed} value={form.normalHours} onChange={(e) => setForm({ ...form, normalHours: e.target.value })} />}</Field>
            <Field label="Fazla mesai">{(id) => <Input id={id} inputMode="decimal" disabled={!hoursAllowed} value={form.overtimeHours} onChange={(e) => setForm({ ...form, overtimeHours: e.target.value })} />}</Field>
            <Field label="Gerekçe" required>{(id) => <Input id={id} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>
            <div className="sm:col-span-5">
              <Button
                variant="primary"
                disabled={form.reason.trim().length < 3}
                loading={request.isPending}
                onClick={() =>
                  request.mutate(undefined, {
                    onSuccess: () => {
                      setError(null);
                      setForm({ ...form, reason: '' });
                      toast.success('Düzeltme talebi gönderildi');
                    },
                    onError: setError,
                  })
                }
              >
                Talep gönder
              </Button>
            </div>
            {error ? <div className="sm:col-span-5"><ErrorCallout error={error} /></div> : null}
          </div>
          {(d.corrections ?? []).length > 0 && (
            <ul className="space-y-1 border-t border-border p-4 text-sm">
              {d.corrections!.map((c) => (
                <li key={c.id}>
                  <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge> {formatDateTR(c.workDate)} · {DAY_LABEL[c.dayType] ?? c.dayType} · {c.reason}
                  {c.decisionNote && <span className="text-muted"> — {c.decisionNote}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal open={slipId !== null} onOpenChange={(o) => !o && setSlipId(null)} title={slip.data ? `Bordro pusulası · ${slip.data.slip.month}` : 'Bordro pusulası'}>
        {slip.error ? <ErrorCallout error={slip.error} /> : null}
        {slip.data && (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ['Temel ücret', 'basePay'],
                ['Fazla mesai', 'overtimePay'],
                ['Brüt', 'gross'],
                ['SGK işçi payı', 'employeeSocial'],
                ['Gelir vergisi', 'incomeTax'],
                ['Diğer kesintiler', 'otherDeductions'],
                ['Toplam kesinti', 'deductionsTotal'],
                ['Net ödenen', 'net'],
              ] as const
            ).map(([label, key]) => (
              <div key={key} className="flex justify-between gap-3 border-b border-border py-1">
                <dt className="text-muted">{label}</dt>
                <dd className="num">{money(slip.data!.slip[key] ?? '0')}</dd>
              </div>
            ))}
          </dl>
        )}
      </Modal>
    </>
  );
}
