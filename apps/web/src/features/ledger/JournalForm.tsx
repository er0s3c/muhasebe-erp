import { useQueries } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CURRENCY_CODES, applyRate, dec, formatTR, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCQuery, useCompanyApi } from '../../lib/queries';
import type { Account, JournalEntry } from '../../lib/types';

interface LineState {
  key: number;
  accountId: string;
  description: string;
  currency: string;
  debit: string;
  credit: string;
  fxRate: string;
}

let lineKey = 1;
const emptyLine = (currency: string): LineState => ({ key: lineKey++, accountId: '', description: '', currency, debit: '', credit: '', fxRate: '' });

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Verilirse taslak düzenlenir; yoksa yeni kayıt açılır. */
  initial?: JournalEntry | null;
  onSaved: (entry: JournalEntry) => void;
}

/** Yevmiye giriş formu: dövizli satırlar, canlı denge kontrolü, taslak/kaydet. */
export function JournalForm({ open, onOpenChange, initial, onSaved }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const { company, call } = useCompanyApi();
  const base = company.baseCurrency;

  const { data: accountsData } = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts');
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<LineState[]>([]);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Forma her açılışta taze durum yükle
  useEffect(() => {
    if (!open) return;
    setError(null);
    setFieldError(null);
    if (initial) {
      setDate(initial.entryDate);
      setDescription(initial.description);
      setLines(
        initial.lines.map((l) => ({
          key: lineKey++,
          accountId: l.accountId,
          description: l.description ?? '',
          currency: l.currencyCode,
          debit: Number(l.debit) > 0 ? trimZeros(l.debit) : '',
          credit: Number(l.credit) > 0 ? trimZeros(l.credit) : '',
          fxRate: l.currencyCode !== base ? trimZeros(l.fxRate) : '',
        })),
      );
    } else {
      setDate(todayIso());
      setDescription('');
      setLines([emptyLine(base), emptyLine(base)]);
    }
  }, [open, initial, base]);

  const options = useMemo<ComboOption[]>(
    () =>
      (accountsData?.accounts ?? [])
        .filter((a) => a.isPostable && a.isActive)
        .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}`, keywords: a.code, hint: a.currencyCode ?? undefined })),
    [accountsData],
  );
  const accountById = useMemo(() => new Map((accountsData?.accounts ?? []).map((a) => [a.id, a])), [accountsData]);

  // Dövizli satırlar için tarihteki kayıtlı kuru sorgula (sunucu ile aynı hesabı önizlemek için)
  const foreign = [...new Set(lines.map((l) => l.currency).filter((c) => c !== base))];
  const rateQueries = useQueries({
    queries: foreign.map((cur) => ({
      queryKey: [company.id, 'rate-lookup', cur, base, date],
      queryFn: () => call<{ rate: string | null }>(`/api/exchange-rates/lookup?from=${cur}&to=${base}&date=${date}`),
      enabled: open && /^\d{4}-\d{2}-\d{2}$/.test(date),
    })),
  });
  const lookedUp = new Map(foreign.map((cur, i) => [cur, rateQueries[i]?.data?.rate ?? null]));

  const computed = useMemo(() => {
    let debit = dec(0);
    let credit = dec(0);
    const missing = new Set<string>();
    for (const l of lines) {
      const rate = l.currency === base ? dec(1) : l.fxRate ? dec(l.fxRate) : lookedUp.get(l.currency) ? dec(lookedUp.get(l.currency)!) : null;
      const amounts = [l.debit, l.credit];
      if (!rate) {
        if (amounts.some((a) => a !== '')) missing.add(l.currency);
        continue;
      }
      if (l.debit) debit = debit.plus(applyRate(l.debit, rate));
      if (l.credit) credit = credit.plus(applyRate(l.credit, rate));
    }
    return { debit, credit, diff: debit.minus(credit), missing: [...missing] };
    // lookedUp bir Map; içeriği rateQueries değişince yenilenir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, base, rateQueries.map((q) => q.data?.rate ?? '').join('|')]);

  const balanced = computed.diff.isZero() && computed.debit.gt(0) && computed.missing.length === 0;

  const patch = (key: number, p: Partial<LineState>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const addLine = () =>
    setLines((cur) => {
      const line = emptyLine(base);
      // Farkı kapatacak karşı taraf tutarını hazırla
      if (!computed.diff.isZero() && computed.missing.length === 0) {
        if (computed.diff.gt(0)) line.credit = computed.diff.toFixed(2);
        else line.debit = computed.diff.abs().toFixed(2);
      }
      return [...cur, line];
    });

  const save = useCMutation(
    async (v: { post: boolean }, c) => {
      const body = {
        entryDate: date,
        description,
        post: v.post,
        lines: lines
          .filter((l) => l.accountId)
          .map((l) => ({
            accountId: l.accountId,
            currency: l.currency,
            ...(l.description ? { description: l.description } : {}),
            ...(l.debit ? { debit: l.debit } : {}),
            ...(l.credit ? { credit: l.credit } : {}),
            ...(l.currency !== base && l.fxRate ? { fxRate: l.fxRate } : {}),
          })),
      };
      const res = initial
        ? await c<{ entry: JournalEntry }>(`/api/journal-entries/${initial.id}`, { method: 'PUT', body })
        : await c<{ entry: JournalEntry }>('/api/journal-entries', { method: 'POST', body });
      return res.entry;
    },
    [['journal'], ['journal-entry'], ['dashboard'], ['trial-balance'], ['account-ledger']],
  );

  const submit = (post: boolean) => {
    setError(null);
    setFieldError(null);
    const filled = lines.filter((l) => l.accountId);
    if (!description.trim()) return setFieldError(t('ledger.journal.description'));
    if (filled.length < 2) return setFieldError(t('ledger.journal.minLines'));
    if (filled.some((l) => !l.debit && !l.credit)) return setFieldError(t('common.amount'));
    save.mutate(
      { post },
      {
        onSuccess: (entry) => {
          toast.success(post && entry.entryNo ? t('ledger.journal.postedMsg', { no: entry.entryNo }) : t('ledger.journal.draftSaved'));
          onSaved(entry);
          onOpenChange(false);
        },
        onError: (e) => setError(e),
      },
    );
  };

  const fxMissing = error instanceof ApiError && error.code === 'FX_RATE_MISSING';

  return (
    <Sheet
      wide
      open={open}
      onOpenChange={onOpenChange}
      title={initial ? t('ledger.journal.edit') : t('ledger.journal.new')}
      footer={
        <>
          <div className="mr-auto text-sm" aria-live="polite">
            {computed.missing.length > 0 ? (
              <span className="text-warning">{t('ledger.journal.fxMissing')}</span>
            ) : balanced ? (
              <span className="font-medium text-success">{t('ledger.journal.diffBalanced')}</span>
            ) : computed.debit.gt(0) || computed.credit.gt(0) ? (
              <span className="font-medium text-danger">{t('ledger.journal.diffUnbalanced', { amount: formatTR(computed.diff.abs().toFixed(2)) })}</span>
            ) : null}
          </div>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button loading={save.isPending && !save.variables?.post} onClick={() => submit(false)}>
            {t('ledger.journal.saveDraft')}
          </Button>
          <Button variant="primary" loading={save.isPending && !!save.variables?.post} disabled={!balanced} onClick={() => submit(true)}>
            {t('ledger.journal.post')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {(error || fieldError) && (
          <Callout
            tone="danger"
            action={
              fxMissing ? (
                <Link to="/settings/currencies" className="shrink-0 text-sm font-medium text-brand hover:underline" onClick={() => onOpenChange(false)}>
                  {t('ledger.journal.enterFx')}
                </Link>
              ) : undefined
            }
          >
            {error ? errorMessage(error) : fieldError}
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <Field label={t('ledger.journal.date')} required>
            {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label={t('ledger.journal.description')} required>
            {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} autoFocus={!initial} />}
          </Field>
        </div>

        <section aria-label={t('ledger.journal.lines')}>
          <div className="mb-2 grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_96px_minmax(0,1fr)_minmax(0,1fr)_88px_32px] items-end gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted max-lg:hidden">
            <span>{t('ledger.journal.account')}</span>
            <span>{t('ledger.journal.lineDescription')}</span>
            <span>{t('common.currency')}</span>
            <span className="text-right">{t('common.debit')}</span>
            <span className="text-right">{t('common.credit')}</span>
            <span className="text-right" title={t('ledger.journal.fxRateHint')}>
              {t('ledger.journal.fxRate')}
            </span>
            <span />
          </div>
          <div className="flex flex-col gap-2">
            {lines.map((l, i) => {
              const acc = accountById.get(l.accountId);
              const locked = !!acc?.currencyCode;
              return (
                <div
                  key={l.key}
                  className="grid grid-cols-2 items-center gap-2 rounded-lg border border-border p-2 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_96px_minmax(0,1fr)_minmax(0,1fr)_88px_32px] lg:border-0 lg:p-0"
                >
                  <Combobox
                    className="col-span-2 lg:col-span-1"
                    options={options}
                    value={l.accountId || null}
                    placeholder={t('ledger.journal.pickAccount')}
                    aria-label={`${t('ledger.journal.account')} ${i + 1}`}
                    onChange={(v) => {
                      const a = accountById.get(v);
                      patch(l.key, { accountId: v, ...(a?.currencyCode ? { currency: a.currencyCode } : {}) });
                    }}
                  />
                  <Input
                    className="col-span-2 lg:col-span-1"
                    value={l.description}
                    onChange={(e) => patch(l.key, { description: e.target.value })}
                    aria-label={`${t('ledger.journal.lineDescription')} ${i + 1}`}
                  />
                  <Select
                    className="px-2 pr-6"
                    value={l.currency}
                    disabled={locked}
                    onChange={(e) => patch(l.key, { currency: e.target.value, fxRate: '' })}
                    aria-label={`${t('common.currency')} ${i + 1}`}
                  >
                    {CURRENCY_CODES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                  <MoneyInput
                    value={l.debit}
                    aria-label={`${t('common.debit')} ${i + 1}`}
                    placeholder={t('common.debit')}
                    onChange={(v) => patch(l.key, { debit: v, ...(v ? { credit: '' } : {}) })}
                  />
                  <MoneyInput
                    value={l.credit}
                    aria-label={`${t('common.credit')} ${i + 1}`}
                    placeholder={t('common.credit')}
                    onChange={(v) => patch(l.key, { credit: v, ...(v ? { debit: '' } : {}) })}
                  />
                  <MoneyInput
                    value={l.fxRate}
                    decimals={4}
                    maxDecimals={8}
                    disabled={l.currency === base}
                    placeholder={l.currency === base ? '—' : (lookedUp.get(l.currency) ? formatTR(lookedUp.get(l.currency), 4) : '?')}
                    aria-label={`${t('ledger.journal.fxRate')} ${i + 1}`}
                    onChange={(v) => patch(l.key, { fxRate: v })}
                  />
                  <button
                    className="justify-self-end rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"
                    disabled={lines.length <= 2}
                    onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}
                    aria-label={t('ledger.journal.removeLine')}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <Button size="sm" onClick={addLine}>
              <Plus className="size-3.5" aria-hidden />
              {t('ledger.journal.addLine')}
            </Button>
            <dl className="flex gap-6 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted">{t('common.debit')}</dt>
                <dd className="num font-medium">{formatTR(computed.debit.toFixed(2))}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">{t('common.credit')}</dt>
                <dd className="num font-medium">{formatTR(computed.credit.toFixed(2))}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted">{base}</dt>
                <dd className="text-muted">{t('ledger.journal.baseAmount')}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>
    </Sheet>
  );
}

/** "100.0000" -> "100"; "1.5000" -> "1.5" */
function trimZeros(v: string): string {
  return v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
}
