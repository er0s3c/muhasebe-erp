import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCMutation, useCQuery } from '../../lib/queries';
import type { LedgerSettings, OutstandingAdvance, RunDeductionRow } from '../../lib/types';
import { LEDGER_INVALIDATE, LedgerUnverifiedBadge } from './employee-ledger-common';

/**
 * Taslak bordroda bir personelin avans kesintisi: kesinti bekleyen avanslardan tutar seçilir; bordro sunucuda yeniden hesaplanır.
 * Üst sınır varsa (kullanıcı parametresi, "doğrulanmadı" olabilir) burada gösterilir ve sunucu da denetler.
 */
export function AdvanceDeductionModal({ runId, employeeId, employeeName, onClose }: { runId: string; employeeId: string; employeeName: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ advances: OutstandingAdvance[]; settings: LedgerSettings }>(['employee-ledger', 'outstanding', employeeId], `/api/employee-ledger/advances/outstanding?employeeId=${employeeId}`);
  const { data: planned, error: plannedError, isPending: plannedPending, refetch: retryPlanned, isFetching: retryingPlanned } = useCQuery<{ deductions: RunDeductionRow[] }>(['employee-ledger', 'run-deductions', runId], `/api/employee-ledger/runs/${runId}/deductions`);
  const [amounts, setAmounts] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of planned?.deductions ?? []) if (d.employeeId === employeeId) m[d.advanceId] = d.amount;
    return m;
  }, [planned, employeeId]);
  const values = amounts ?? initial;
  const save = useCMutation(
    (deductions: { advanceId: string; amount: string }[], call) => call(`/api/employee-ledger/runs/${runId}/deductions`, { method: 'PUT', body: { employeeId, deductions } }),
    LEDGER_INVALIDATE,
  );
  const rows = (data?.advances ?? []).filter((a) => a.employeeId === employeeId);
  const chosen = Object.entries(values)
    .map(([advanceId, amount]) => ({ advanceId, amount: amount.trim() }))
    .filter((d) => Number(d.amount) > 0);
  const over = chosen.some((d) => Number(d.amount) > Number(rows.find((r) => r.id === d.advanceId)?.remaining ?? '0'));
  const total = chosen.reduce((s, d) => s + Number(d.amount), 0);
  const cap = data?.settings.deductionCapPct;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('employeeLedger.deduct.title', { name: employeeName })}
      description={t('employeeLedger.deduct.desc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={over || isPending || plannedPending || !!queryError || !!plannedError} onClick={() => save.mutate(chosen, { onSuccess: onClose, onError: setError })}>
            {chosen.length === 0 ? t('employeeLedger.deduct.clear') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {cap && (
          <Callout tone="info">
            <span className="inline-flex flex-wrap items-center gap-2">
              {t('employeeLedger.deduct.cap', { pct: Number(cap) })}
              {data?.settings.verifiedAt ? <Badge tone="success">{t('employeeLedger.settings.verified', { by: data.settings.verifiedBy ?? '' })}</Badge> : <LedgerUnverifiedBadge />}
            </span>
          </Callout>
        )}
        {plannedError ? <ErrorState description={errorMessage(plannedError)} onRetry={() => void retryPlanned()} retrying={retryingPlanned} /> : queryError ? (<ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending || plannedPending ? (
          <PageLoading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{t('employeeLedger.deduct.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={t('employeeLedger.deduct.list')}>
            {rows.map((a) => (
              <li key={a.id} className="grid grid-cols-[1fr_9rem] items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <span>
                  <span className="font-mono text-[13px]">{a.number}</span> · {formatDateTR(a.advanceDate)} · {a.purpose}
                  <span className="ml-2 text-muted">{t('employeeLedger.deduct.remaining', { amount: money(a.remaining) })}</span>
                </span>
                <MoneyInput
                  aria-label={t('employeeLedger.deduct.amountFor', { no: a.number })}
                  value={values[a.id] ?? ''}
                  allowNegative={false}
                  onChange={(v) => setAmounts({ ...values, [a.id]: v })}
                />
              </li>
            ))}
          </ul>
        )}
        {!queryError && !plannedError && !isPending && !plannedPending && <p className="text-sm text-muted">{t('employeeLedger.deduct.total', { amount: money(total.toFixed(2)) })}</p>}
        {over && <Callout tone="danger">{t('employeeLedger.deduct.exceeds')}</Callout>}
      </div>
    </Modal>
  );
}
