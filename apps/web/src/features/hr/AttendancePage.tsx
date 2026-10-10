import { todayIso } from '@erp/shared';
import { ChevronLeft, ChevronRight, Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { Callout, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { SegmentedTabs, TabPanel } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { AttendanceSheetData } from '../../lib/types';
import { ATTENDANCE_INVALIDATE, isMonth, shiftMonth } from './attendance-common';
import { AttendanceDaySheet } from './AttendanceDaySheet';
import { AttendanceGrid } from './AttendanceGrid';
import { AttendanceLaborTab, AttendanceSummaryTab } from './AttendanceReports';

type Tab = 'grid' | 'day' | 'summary' | 'labor';

/** Puantaj (Faz D2): aylık çizelge, günlük giriş, aylık özet ve işçilik saatleri; aylık kapanış. */
export function AttendancePage() {
  const { t } = useTranslation();
  const can = useCan();
  const [tab, setTab] = useState<Tab>('grid');
  const thisMonth = todayIso().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const { data, isPending, dataUpdatedAt, error , refetch: retryQuery, isFetching: retryingQuery } = useCQuery<AttendanceSheetData>(['attendance', 'month', month], `/api/attendance/month?month=${month}`);
  const manage = can('hr.manage');
  const closed = data?.lock.closed ?? false;

  return (
    <>
      <PageHeader
        title={t('attendance.title')}
        description={t('attendance.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button aria-label={t('attendance.prevMonth')} onClick={() => setMonth(shiftMonth(month, -1))}>
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Input aria-label={t('attendance.month')} type="month" className="w-44" value={month} onChange={(e) => isMonth(e.target.value) && setMonth(e.target.value)} />
            <Button aria-label={t('attendance.nextMonth')} onClick={() => setMonth(shiftMonth(month, 1))}>
              <ChevronRight className="size-4" aria-hidden />
            </Button>
            {data && <Badge tone={closed ? 'danger' : 'success'}>{closed ? t('attendance.lock.closed') : t('attendance.lock.open')}</Badge>}
            {data && manage && <LockActions lock={data.lock} thisMonth={thisMonth} />}
          </div>
        }
      />

      {data && closed && (
        <div className="mb-4">
          <Callout tone="warning" title={t('attendance.lock.closedTitle', { month })}>
            {t('attendance.lock.closedBody')}
            {data.lock.closedBy ? ` ${t('attendance.lock.closedBy', { by: data.lock.closedBy })}` : ''}
            {data.lock.closeNote ? ` ${t('attendance.lock.closeNote', { note: data.lock.closeNote })}` : ''}
          </Callout>
        </div>
      )}
      {data && !closed && data.lock.reopenCount > 0 && (
        <div className="mb-4">
          <Callout tone="info">{t('attendance.lock.reopenedInfo', { count: data.lock.reopenCount, reason: data.lock.reopenReason ?? '—' })}</Callout>
        </div>
      )}
      {data && data.missingHireDate > 0 && (
        <div className="mb-4">
          <Callout tone="warning" action={<Link to="/hr/employees" className="text-sm underline">{t('attendance.missingHireLink')}</Link>}>
            {t('attendance.missingHire', { count: data.missingHireDate })}
          </Callout>
        </div>
      )}
      <div className="mb-4">
        <SegmentedTabs
          id="attendance-tabs"
          panelId={key => `attendance-panel-${key}`}
          value={tab}
          onChange={setTab}
          items={[
            { key: 'grid', label: t('attendance.tabs.grid') },
            { key: 'day', label: t('attendance.tabs.day') },
            { key: 'summary', label: t('attendance.tabs.summary') },
            { key: 'labor', label: t('attendance.tabs.labor') },
          ]}
        />
      </div>
      {error ? (<ErrorState description={errorMessage(error)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending || !data ? (
        <PageLoading />
      ) : (
        <>
          {/* Çizelge ve günlük giriş bağlı kalır (gizlenir): sekme değişince kaydedilmemiş taslak kaybolmaz */}
          <TabPanel id="attendance-panel-grid" labelledBy="attendance-tabs-grid" hidden={tab !== 'grid'}>
            <AttendanceGrid key={month} sheet={data} canEdit={manage && !closed} />
          </TabPanel>
          <TabPanel id="attendance-panel-day" labelledBy="attendance-tabs-day" hidden={tab !== 'day'}>
            <AttendanceDaySheet key={month} sheet={data} canEdit={manage && !closed} dataKey={dataUpdatedAt} />
          </TabPanel>
          <TabPanel id="attendance-panel-summary" labelledBy="attendance-tabs-summary" hidden={tab !== 'summary'}>{tab === 'summary' && <AttendanceSummaryTab month={month} />}</TabPanel>
          <TabPanel id="attendance-panel-labor" labelledBy="attendance-tabs-labor" hidden={tab !== 'labor'}>{tab === 'labor' && <AttendanceLaborTab key={month} month={month} />}</TabPanel>
        </>
      )}
    </>
  );
}

/** Ayı kapat / yeniden aç. Kapatma notu isteğe bağlıdır; yeniden açma gerekçe ister ve denetim izine yazılır. */
function LockActions({ lock, thisMonth }: { lock: AttendanceSheetData['lock']; thisMonth: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const month = lock.month;
  const closing = !lock.closed;
  const run = useCMutation(
    (_: void, call) =>
      closing
        ? call('/api/attendance/months/close', { method: 'POST', body: { month, ...(text.trim() ? { note: text.trim() } : {}) } })
        : call('/api/attendance/months/reopen', { method: 'POST', body: { month, reason: text.trim() } }),
    ATTENDANCE_INVALIDATE,
  );
  const future = closing && month > thisMonth;
  const ask = () => {
    setText('');
    setError(null);
    setOpen(true);
  };
  const submit = () =>
    run.mutate(undefined, {
      onSuccess: () => {
        toast.success(closing ? t('attendance.lock.closedToast') : t('attendance.lock.reopenedToast'));
        setOpen(false);
      },
      onError: setError,
    });
  const canSubmit = closing || text.trim().length >= 3;

  return (
    <>
      <Button variant={closing ? 'primary' : 'secondary'} disabled={future} title={future ? t('attendance.lock.future') : undefined} onClick={ask}>
        {closing ? <Lock className="size-4" aria-hidden /> : <LockOpen className="size-4" aria-hidden />}
        {closing ? t('attendance.lock.close') : t('attendance.lock.reopen')}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={closing ? t('attendance.lock.closeTitle', { month }) : t('attendance.lock.reopenTitle', { month })}
        description={closing ? t('attendance.lock.closeDesc') : t('attendance.lock.reopenDesc')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={run.isPending} disabled={!canSubmit} onClick={submit}>
              {closing ? t('attendance.lock.close') : t('attendance.lock.reopen')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={closing ? t('attendance.lock.note') : t('attendance.lock.reason')} required={!closing}>
            {(id) => <Textarea id={id} rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        </div>
      </Modal>
    </>
  );
}
