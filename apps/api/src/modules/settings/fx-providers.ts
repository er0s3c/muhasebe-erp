import { fxProviderForJurisdiction, FX_PROVIDER_LABELS, type FxProvider } from '@erp/shared';
import { badRequest } from '../../http/errors';
import { fetchKktcmbXml, kktcmbUrl, parseKktcmbXml } from './kktcmb';
import { fetchTcmbXml, parseTcmbXml, tcmbUrl } from './tcmb';
import type { PublishedRateDay } from './xml-rates';

export const FX_PROVIDER_REGISTRY: Record<
  FxProvider,
  {
    label: string;
    url: (date?: string) => string;
    parse: (xml: string) => PublishedRateDay;
    fetch: (date?: string) => Promise<string>;
  }
> = {
  tcmb: { label: FX_PROVIDER_LABELS.tcmb, url: tcmbUrl, parse: parseTcmbXml, fetch: fetchTcmbXml },
  kktcmb: {
    label: FX_PROVIDER_LABELS.kktcmb,
    url: kktcmbUrl,
    parse: parseKktcmbXml,
    fetch: fetchKktcmbXml,
  },
};
export function fetchProviderXml(provider: FxProvider, date?: string) {
  return FX_PROVIDER_REGISTRY[provider].fetch(date);
}
export function companyFxProvider(company: {
  jurisdiction?: 'TR' | 'KKTC' | null;
  fxProvider?: FxProvider | null;
}): FxProvider | null {
  return company.fxProvider ?? fxProviderForJurisdiction(company.jurisdiction);
}
export function requireCompanyFxProvider(company: Parameters<typeof companyFxProvider>[0]) {
  const provider = companyFxProvider(company);
  if (!provider)
    throw badRequest(
      'Resmî kur almak için şirketin Türkiye veya KKTC çalışma ülkesini seçin.',
      'FX_JURISDICTION_REQUIRED',
    );
  const expected = fxProviderForJurisdiction(company.jurisdiction);
  if (expected && expected !== provider)
    throw badRequest(
      'Kur sağlayıcısı şirketin çalışma ülkesiyle uyuşmuyor.',
      'FX_PROVIDER_MISMATCH',
    );
  return provider;
}
