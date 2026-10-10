import { z } from 'zod';
import { isoDate } from './schemas/common';

/** KKTC bir uygulama yetki alanıdır; ISO ülke kodu CY ile eşitlenmez. */
export const JURISDICTIONS = ['TR', 'KKTC'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];
export const LEGAL_ENTITY_TYPES = ['sole_proprietor', 'company', 'nonprofit', 'other'] as const;
export type LegalEntityType = (typeof LEGAL_ENTITY_TYPES)[number];
export type TaxSetupStatus = 'legacy_manual' | 'needs_review' | 'ready';

export const JURISDICTION_PROFILES = {
  TR: {
    code: 'TR', label: 'Türkiye', timeZone: 'Europe/Istanbul', fxProvider: 'tcmb',
    taxPackVersion: 'TR-VAT-2023-07-10-v1',
    capabilities: { vat: 'requires_review', payroll: 'requires_parameters', stamp: 'planned', eDocument: 'prepared' },
    vatEffectiveFrom: '2023-07-10',
    vatSourceUrl: 'https://gib.gov.tr/mevzuat/kanun/436/ozelge/30157',
    vatRates: [1, 10, 20],
  },
  KKTC: {
    code: 'KKTC', label: 'Kuzey Kıbrıs Türk Cumhuriyeti', timeZone: 'Europe/Nicosia', fxProvider: 'kktcmb',
    taxPackVersion: 'KKTC-VAT-2026-09-16-v1',
    capabilities: { vat: 'requires_review', payroll: 'requires_parameters', stamp: 'planned', eDocument: 'prepared' },
    vatEffectiveFrom: '2026-09-16',
    vatSourceUrl: 'https://www.vergi.gov.ct.tr/sites/default/files/16.09.2026-KATMA%20DE%C4%9EER%20VERG%C4%B0S%C4%B0%20ORANLARI%20B%C4%B0RLE%C5%9ET%C4%B0R%C4%B0LM%C4%B0%C5%9E%20T%C3%9CZ%C3%9C%C4%9E%C3%9C%20G%C3%BCncellenmi%C5%9F.docx',
    vatRates: [5, 10, 16, 20],
  },
} as const satisfies Record<Jurisdiction, { code: Jurisdiction; label: string; timeZone: string; fxProvider: 'tcmb' | 'kktcmb'; taxPackVersion: string; capabilities: Record<string, string>; vatEffectiveFrom: string; vatSourceUrl: string; vatRates: readonly number[] }>;

export interface LegalProfileSnapshot {
  jurisdiction: Jurisdiction;
  profileVersionId: string;
  rulePackVersion: string;
  engineVersion: string;
  effectiveFrom: string;
  legalEntityType: LegalEntityType;
  vatRegistered: boolean;
  activityCode: string | null;
  sourceRefs: string[];
}

export const companyProfileInputSchema = z.object({
  jurisdiction: z.enum(JURISDICTIONS),
  effectiveFrom: isoDate,
  legalEntityType: z.enum(LEGAL_ENTITY_TYPES).default('company'),
  vatRegistered: z.boolean().default(true),
  activityCode: z.string().trim().max(40).nullable().optional(),
}).strict();
export const activateCompanyProfileSchema = companyProfileInputSchema.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/) });
export type CompanyProfileInput = z.infer<typeof companyProfileInputSchema>;
