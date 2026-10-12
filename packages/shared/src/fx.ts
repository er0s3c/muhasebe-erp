import { z } from 'zod';

export const FX_PROVIDERS = ['tcmb', 'kktcmb'] as const;
export type FxProvider = (typeof FX_PROVIDERS)[number];
export const fxProviderSchema = z.enum(FX_PROVIDERS);
export const FX_RATE_TYPES = [
  'forex_buy',
  'forex_sell',
  'effective_buy',
  'effective_sell',
] as const;
export type FxRateType = (typeof FX_RATE_TYPES)[number];
export const fxRateTypeSchema = z.enum(FX_RATE_TYPES);
export const FX_RATE_TYPE_LABELS: Record<FxRateType, string> = {
  forex_buy: 'Döviz alış',
  forex_sell: 'Döviz satış',
  effective_buy: 'Efektif alış',
  effective_sell: 'Efektif satış',
};
export const FX_PURPOSES = [
  'valuation',
  'collection',
  'payment',
  'cash_collection',
  'cash_payment',
] as const;
export type FxPurpose = (typeof FX_PURPOSES)[number];
export const fxPurposeSchema = z.enum(FX_PURPOSES);
export const FX_PURPOSE_LABELS: Record<FxPurpose, string> = {
  valuation: 'Değerleme / muhasebe',
  collection: 'Döviz tahsilatı',
  payment: 'Döviz ödemesi',
  cash_collection: 'Nakit döviz tahsilatı',
  cash_payment: 'Nakit döviz ödemesi',
};
/** These are explicit calculation defaults; an agreed transaction rate may override them. */
export const FX_PURPOSE_RATE_TYPES: Record<FxPurpose, FxRateType> = {
  valuation: 'forex_buy',
  collection: 'forex_buy',
  payment: 'forex_sell',
  cash_collection: 'effective_buy',
  cash_payment: 'effective_sell',
};
export const FX_PROVIDER_LABELS: Record<FxProvider, string> = {
  tcmb: 'Türkiye Cumhuriyet Merkez Bankası',
  kktcmb: 'KKTC Merkez Bankası',
};
export function fxProviderForJurisdiction(
  jurisdiction: 'TR' | 'KKTC' | null | undefined,
): FxProvider | null {
  return jurisdiction === 'TR' ? 'tcmb' : jurisdiction === 'KKTC' ? 'kktcmb' : null;
}
export function oppositeFxRateType(type: FxRateType): FxRateType {
  return (
    {
      forex_buy: 'forex_sell',
      forex_sell: 'forex_buy',
      effective_buy: 'effective_sell',
      effective_sell: 'effective_buy',
    } as const
  )[type];
}
export interface FxRateLeg {
  currencyCode: string;
  quoteCode: string;
  rateDate: string;
  source: string;
  provider: string;
  sourceUrl: string | null;
  rateType: FxRateType;
  inverted: boolean;
  value: string;
}
export interface FxRateLookup {
  from: string;
  to: string;
  date: string;
  rate: string | null;
  rateDate: string | null;
  rateType: FxRateType;
  purpose: FxPurpose | null;
  source: string | null;
  provider: string | null;
  sourceUrl: string | null;
  method: 'identity' | 'direct' | 'inverse' | 'cross' | 'missing';
  legs: FxRateLeg[];
}

export type FinancialFxSnapshot = Omit<FxRateLookup, 'method'> & {
  method: FxRateLookup['method'] | 'manual';
  manualReason?: string | null;
  originalInvoiceId?: string;
};
