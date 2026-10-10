import { CalendarPlus, Lock, LockOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { Period } from '../../lib/types';

export function PeriodsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const months = t('months', { returnObjects: true }) as string[];
  const { data: yearsData } = useCQuery<{ years: number[] }>(['period-years'], '/api/periods/years');
  const currentYear = Number(todayIso().slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const { data, isPending, error: PeriodsPageQueryError, refetch: PeriodsPageQueryRetry, isFetching: PeriodsPageQueryFetching } = useCQuery<{ periods: Period[] }>(['periods', year], `/api/periods?year=${year}`);
  const [confirm, setConfirm] = useState<{ period: Period; action: 'close' | 'reopen' } | null>(null);

  useEffect(() => {
    if (yearsData && yearsData.years.length > 0 && !yearsData.years.includes(year)) setYear(yearsData.years[0]!);
  }, [yearsData, year]);

  const generate = useCMutation((y: number, call) => call('/api/periods/generate', { method: 'POST', body: { year: y } }), [['period-years'], ['periods']]);
  const change = useCMutation(
    (v: { id: string; action: 'close' | 'reopen' }, call) => call(`/api/periods/${v.id}/${v.action}`, { method: 'POST' }),
    [['periods']],
  );

  const maxYear = Math.max(currentYear, ...(yearsData?.years ?? []));
  const canClose = can('ledger.close_period');

  if (PeriodsPageQueryError && !data) return <ErrorState error={PeriodsPageQueryError} onRetry={() => void PeriodsPageQueryRetry()} retrying={PeriodsPageQueryFetching} />;
  return (
    <>
      <PageHeader
        title={t('settings.periods.title')}
        description={t('settings.periods.subtitle')}
        actions={
          <>
            <Select className="w-28" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label={t('common.year')}>
              {(yearsData?.years ?? [year]).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
            {can('settings.manage') && (
              <Button
                loading={generate.isPending}
                onClick={() =>
                  generate.mutate(maxYear + 1, {
                    onSuccess: () => {
                      toast.success(t('settings.periods.yearAdded', { year: maxYear + 1 }));
                      setYear(maxYear + 1);
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  })
                }
              >
                <CalendarPlus className="size-4" aria-hidden />
                {t('settings.periods.addYear')}
              </Button>
            )}
          </>
        }
      />

      {isPending ? (
        <PageLoading />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data?.periods.map((p) => {
            const closed = p.status === 'closed';
            return (
              <Card key={p.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p>{months[p.month - 1]}</p>
                    <p className="text-xs text-muted">
                      {formatDateTR(p.startDate)} – {formatDateTR(p.endDate)}
                    </p>
                  </div>
                  <Badge tone={closed ? 'neutral' : 'success'}>{closed ? t('settings.periods.closed') : t('settings.periods.open')}</Badge>
                </div>
                {canClose && (
                  <Button size="sm" onClick={() => setConfirm({ period: p, action: closed ? 'reopen' : 'close' })}>
                    {closed ? <LockOpen className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
                    {closed ? t('settings.periods.reopen') : t('settings.periods.close')}
                  </Button>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.action === 'close' ? t('settings.periods.close') : t('settings.periods.reopen')}
        description={
          confirm
            ? t(confirm.action === 'close' ? 'settings.periods.closeConfirm' : 'settings.periods.reopenConfirm', {
                period: `${months[confirm.period.month - 1]} ${confirm.period.year}`,
              })
            : undefined
        }
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={change.isPending}
              onClick={() =>
                confirm &&
                change.mutate(
                  { id: confirm.period.id, action: confirm.action },
                  {
                    onSuccess: () => {
                      toast.success(confirm.action === 'close' ? t('settings.periods.closedMsg') : t('settings.periods.reopenedMsg'));
                      setConfirm(null);
                    },
                    onError: (e) => {
                      toast.error(errorMessage(e));
                      setConfirm(null);
                    },
                  },
                )
              }
            >
              {confirm?.action === 'close' ? t('settings.periods.close') : t('settings.periods.reopen')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  );
}
