import { ATTENDANCE_DAY_TYPES } from '@erp/shared';
import { CalendarCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th } from '../../components/ui/Table';
import { formatDateTR, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { AttendanceLabor, AttendanceSummary } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { monthBounds } from './attendance-common';

const hrs = (v: string) => money(v, 2);

/** Aylık özet: personel başına gün türüne göre gün sayıları, toplam saatler ve kaydı olmayan günler. */
export function AttendanceSummaryTab({ month }: { month: string }) {
  const { t } = useTranslation();
  const { data, isPending } = useCQuery<AttendanceSummary>(['attendance', 'summary', month], `/api/attendance/reports/summary?month=${month}`);
  if (isPending || !data) return <PageLoading />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{t('attendance.summary.hint')}</p>
        <ExportMenu exportKey="attendance-summary" params={{ month }} print={false} disabled={data.rows.length === 0} />
      </div>
      {data.totals.missingDays > 0 && <Callout tone="warning">{t('attendance.summary.missingWarn', { count: data.totals.missingDays })}</Callout>}
      {data.rows.length === 0 ? (
        <Card>
          <EmptyState icon={<CalendarCheck className="size-5" />} title={t('attendance.summary.empty')} description={t('attendance.summary.emptyDesc')} />
        </Card>
      ) : (
        <TableWrap>
          <Table aria-label={t('attendance.tabs.summary')}>
            <thead>
              <tr>
                <Th>{t('attendance.grid.employee')}</Th>
                {ATTENDANCE_DAY_TYPES.map((d) => (
                  <Th key={d} num>
                    {t(`attendance.dayTypes.${d}`)}
                  </Th>
                ))}
                <Th num>{t('attendance.summary.missing')}</Th>
                <Th num>{t('attendance.normalHours')}</Th>
                <Th num>{t('attendance.overtimeHours')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.employeeId}>
                  <Td className="whitespace-nowrap">
                    <span className="font-mono text-[12px] text-muted">{r.code}</span> {r.fullName}
                  </Td>
                  {ATTENDANCE_DAY_TYPES.map((d) => (
                    <Td key={d} num className={r.days[d] === 0 ? 'text-muted' : undefined}>
                      {r.days[d]}
                    </Td>
                  ))}
                  <Td num className={r.missingDays > 0 ? 'text-warning' : 'text-muted'}>
                    {r.missingDays}
                  </Td>
                  <Td num>{hrs(r.normalHours)}</Td>
                  <Td num>{hrs(r.overtimeHours)}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="[&>td]:border-t [&>td]:border-border [&>td]:bg-surface-2 [&>td]:px-4 [&>td]:py-2.5">
                <td colSpan={1 + ATTENDANCE_DAY_TYPES.length}>{t('attendance.summary.total')}</td>
                <td className="num">{data.totals.missingDays}</td>
                <td className="num">{hrs(data.totals.normalHours)}</td>
                <td className="num">{hrs(data.totals.overtimeHours)}</td>
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}

/** İşçilik saatleri: proje / iş kalemi / maliyet koduna göre (D3 işçilik maliyetinin girdisi). */
export function AttendanceLaborTab({ month }: { month: string }) {
  const { t } = useTranslation();
  const b = useMemo(() => monthBounds(month), [month]);
  const [from, setFrom] = useState(b.start);
  const [to, setTo] = useState(b.end);
  const [projectId, setProjectId] = useState('');
  const { projects } = useProjectOptions();
  const valid = !!from && !!to && from <= to;
  const qs = new URLSearchParams({ from, to, ...(projectId ? { projectId } : {}) }).toString();
  const { data, isPending } = useCQuery<AttendanceLabor>(['attendance', 'labor', qs], valid ? `/api/attendance/reports/labor?${qs}` : null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('attendance.labor.from')} className="w-44">
            {(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label={t('attendance.labor.to')} className="w-44">
            {(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
          {projects.length > 0 && (
            <Field label={t('attendance.labor.project')} className="w-64">
              {(id) => (
                <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">{t('attendance.labor.allProjects')}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} — {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <ExportMenu exportKey="attendance-labor" params={{ from, to, projectId }} print={false} disabled={!valid || !data || data.rows.length === 0} />
      </div>
      <p className="text-sm text-muted">{t('attendance.labor.hint')}</p>
      {!valid ? (
        <Callout tone="warning">{t('attendance.labor.invalidRange')}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : data.rows.length === 0 ? (
        <Card>
          <EmptyState icon={<CalendarCheck className="size-5" />} title={t('attendance.labor.empty')} description={t('attendance.labor.emptyDesc', { from: formatDateTR(from), to: formatDateTR(to) })} />
        </Card>
      ) : (
        <TableWrap>
          <Table aria-label={t('attendance.tabs.labor')}>
            <thead>
              <tr>
                <Th>{t('attendance.labor.project')}</Th>
                <Th>{t('attendance.labor.wbs')}</Th>
                <Th>{t('attendance.costCode')}</Th>
                <Th num>{t('attendance.labor.personDays')}</Th>
                <Th num>{t('attendance.labor.employees')}</Th>
                <Th num>{t('attendance.normalHours')}</Th>
                <Th num>{t('attendance.overtimeHours')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>
                  <Td>{r.projectCode ? `${r.projectCode} — ${r.projectName}` : <span className="text-muted">{t('attendance.labor.untagged')}</span>}</Td>
                  <Td className="text-muted">{r.wbsCode ? `${r.wbsCode} — ${r.wbsName}` : '—'}</Td>
                  <Td className="text-muted">{r.costCode ? `${r.costCode} — ${r.costCodeName}` : '—'}</Td>
                  <Td num>{r.personDays}</Td>
                  <Td num>{r.employees}</Td>
                  <Td num>{hrs(r.normalHours)}</Td>
                  <Td num>{hrs(r.overtimeHours)}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="[&>td]:border-t [&>td]:border-border [&>td]:bg-surface-2 [&>td]:px-4 [&>td]:py-2.5">
                <td colSpan={3}>{t('attendance.summary.total')}</td>
                <td className="num">{data.totals.personDays}</td>
                <td />
                <td className="num">{hrs(data.totals.normalHours)}</td>
                <td className="num">{hrs(data.totals.overtimeHours)}</td>
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
