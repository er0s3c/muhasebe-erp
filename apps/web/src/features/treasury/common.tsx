import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { dec, type MoneyValue } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { useCompanyApi, useCQuery } from '../../lib/queries';
import type { TreasuryAccount, TreasuryTxnStatus, TreasuryTxnType } from '../../lib/types';

/** Kasa/banka hareketi değişince etkilenen sorgular: bakiyeler, cari, yevmiye ve raporlar. */
export const TREASURY_INVALIDATE = [
  ['treasury'],
  ['journal'],
  ['journal-entry'],
  ['parties'],
  ['party'],
  ['party-aging'],
  ['trial-balance'],
  ['account-ledger'],
  ['dashboard'],
];

export const TXN_TYPES: readonly TreasuryTxnType[] = ['receipt', 'payment', 'transfer', 'exchange', 'other_receipt', 'other_payment'];

const TYPE_TONE = { receipt: 'success', payment: 'warning', transfer: 'brand', exchange: 'brand', other_receipt: 'neutral', other_payment: 'neutral' } as const;
const STATUS_TONE = { posted: 'success', cancelled: 'danger' } as const;

export function TxnTypeBadge({ type }: { type: TreasuryTxnType }) {
  const { t } = useTranslation();
  return <Badge tone={TYPE_TONE[type]}>{t(`treasury.types.${type}`)}</Badge>;
}

export function TxnStatusBadge({ status }: { status: TreasuryTxnStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`treasury.status.${status}`)}</Badge>;
}

export const useTreasuryAccounts = (enabled = true) =>
  useCQuery<{ accounts: TreasuryAccount[] }>(['treasury', 'accounts'], '/api/treasury/accounts', { enabled });

/** Hesap seçicide "Ana kasa · TRY" biçiminde etiket. */
export const accountLabel = (a: Pick<TreasuryAccount, 'name' | 'currencyCode'>) => `${a.name} · ${a.currencyCode}`;

const isIsoDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * Verilen para birimlerinin `date` tarihindeki kayıtlı kuru (defter para birimine); defter para biriminin kuru 1,
 * kur yoksa null. Önizleme amaçlıdır: sunucu kaydederken aynı aramayı yeniden yapar.
 */
export function useMarketRates(currencies: readonly string[], date: string, enabled: boolean) {
  const { company, call } = useCompanyApi();
  const base = company.baseCurrency;
  const foreign = [...new Set(currencies.filter((c) => c && c !== base))].sort();
  const queries = useQueries({
    queries: foreign.map((cur) => ({
      queryKey: [company.id, 'rate-lookup', cur, base, date],
      queryFn: () => call<{ rate: string | null }>(`/api/exchange-rates/lookup?from=${cur}&to=${base}&date=${date}`),
      enabled: enabled && isIsoDate(date),
    })),
  });
  const found = new Map(foreign.map((cur, i) => [cur, queries[i]?.data?.rate ?? null]));
  const loading = queries.some((q) => q.isPending && q.fetchStatus !== 'idle');
  return {
    loading,
    rate: (cur: string): MoneyValue | null => {
      if (cur === base) return dec(1);
      const r = found.get(cur);
      return r ? dec(r) : null;
    },
  };
}
