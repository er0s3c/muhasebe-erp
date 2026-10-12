import { z } from 'zod';
import { isoDate, moneyString, uuid } from './schemas/common';
import { dec, roundMoney, decCheck, tryDec } from './money';

export const fixedAssetSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\p{L}\p{N}._-]+$/u)
      .transform((v) => v.toLocaleUpperCase('tr-TR')),
    name: z.string().trim().min(2).max(160),
    category: z
      .enum(['equipment', 'vehicle', 'building', 'furniture', 'other'])
      .default('equipment'),
    acquisitionDate: isoDate,
    startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    cost: moneyString.refine(
      decCheck((v) => v.gt(0) && v.decimalPlaces() <= 2),
      'Maliyet pozitif ve en çok iki ondalık olmalı',
    ),
    salvage: moneyString.default('0').refine(decCheck((v) => v.gte(0) && v.decimalPlaces() <= 2)),
    usefulMonths: z.number().int().min(1).max(600),
    expenseAccountId: uuid,
    accumulatedAccountId: uuid,
    projectId: uuid.nullable().default(null),
    department: z.string().trim().max(100).default(''),
    serialNo: z.string().trim().max(100).default(''),
    location: z.string().trim().max(160).default(''),
    notes: z.string().trim().max(1000).default(''),
  })
  .refine(
    (v) => {
      const cost = tryDec(v.cost),
        salvage = tryDec(v.salvage);
      return !!cost && !!salvage && salvage.lt(cost);
    },
    { message: 'Kalıntı değer maliyetten küçük olmalı', path: ['salvage'] },
  )
  .refine((v) => v.startMonth >= v.acquisitionDate.slice(0, 7), {
    message: 'Amortisman edinim ayından önce başlayamaz',
    path: ['startMonth'],
  })
  .refine((v) => v.startMonth >= '1900-01' && v.startMonth <= '2100-12', {
    message: 'Geçerli başlangıç ayı seçin',
    path: ['startMonth'],
  })
  .refine((v) => v.expenseAccountId !== v.accumulatedAccountId, {
    message: 'Gider ve birikmiş amortisman hesapları farklı olmalı',
    path: ['accumulatedAccountId'],
  });
export type FixedAssetInput = z.infer<typeof fixedAssetSchema>;

/** User supplied straight-line schedule. Cumulative rounding makes the final total exact. */
export function depreciationForMonth(
  asset: Pick<FixedAssetInput, 'cost' | 'salvage' | 'startMonth' | 'usefulMonths'>,
  month: string,
) {
  const [y, m] = month.split('-').map(Number),
    [sy, sm] = asset.startMonth.split('-').map(Number);
  const index = (y! - sy!) * 12 + m! - sm!;
  if (index < 0 || index >= asset.usefulMonths) return null;
  const depreciable = dec(asset.cost).minus(asset.salvage);
  const cumulative = roundMoney(depreciable.times(index + 1).div(asset.usefulMonths));
  const prior = roundMoney(depreciable.times(index).div(asset.usefulMonths));
  return {
    index: index + 1,
    amount: cumulative.minus(prior).toFixed(2),
    plannedAccumulated: cumulative.toFixed(2),
    plannedBookValue: dec(asset.cost).minus(cumulative).toFixed(2),
  };
}
export interface FixedAsset {
  id: string;
  version: number;
  active: boolean;
  config: FixedAssetInput;
  postedAmount: string;
  draftAmount: string;
  bookValue: string;
  historyCount: number;
  /** Etkin elden çıkarmanın tarihi; yoksa null. */
  disposedOn: string | null;
  createdAt: string;
}
export interface DepreciationEntry {
  id: string;
  month: string;
  amount: string;
  journalEntryId: string;
  snapshot: FixedAssetInput;
  cancelledAt: string | null;
  entryStatus: 'draft' | 'posted';
  entryNo: string | null;
  entryDate: string;
  reversalEntryId: string | null;
  createdAt: string;
}

/** Demirbaş elden çıkarma (öneri 60): satış ya da hurdaya ayırma; kart kapanır, kâr/zarar ayrı hesaba yazılır. */
export const ASSET_DISPOSAL_METHODS = ['sale', 'scrap'] as const;
export type AssetDisposalMethod = (typeof ASSET_DISPOSAL_METHODS)[number];
export const assetDisposalSchema = z
  .object({
    date: isoDate,
    method: z.enum(ASSET_DISPOSAL_METHODS),
    proceeds: moneyString.default('0').refine(decCheck((v) => v.gte(0) && v.decimalPlaces() <= 2), 'Satış bedeli sıfır ya da pozitif olmalı'),
    assetAccountId: uuid,
    proceedsAccountId: uuid.nullable().default(null),
    gainAccountId: uuid.nullable().default(null),
    lossAccountId: uuid.nullable().default(null),
    note: z.string().trim().max(500).default(''),
    version: z.number().int().positive(),
  })
  .refine((v) => v.method === 'sale' || dec(v.proceeds).eq(0), { message: 'Hurdaya ayırmada satış bedeli olmaz', path: ['proceeds'] })
  .refine((v) => dec(v.proceeds).eq(0) || !!v.proceedsAccountId, { message: 'Satış bedelinin karşı hesabını seçin', path: ['proceedsAccountId'] });
export type AssetDisposalInput = z.infer<typeof assetDisposalSchema>;

/** Defter değeri = maliyet − kayıtlı birikmiş amortisman; kâr/zarar = satış bedeli − defter değeri. */
export function disposalResult(cost: string, accumulated: string, proceeds: string) {
  const bookValue = dec(cost).minus(accumulated);
  return { bookValue: bookValue.toFixed(2), gainLoss: dec(proceeds).minus(bookValue).toFixed(2) };
}

/** Elden çıkarma ayından önceki, kullanım süresi içindeki ve kayıtlı amortismanı olmayan aylar. */
export function missingDepreciationMonths(asset: Pick<FixedAssetInput, 'startMonth' | 'usefulMonths'>, disposalMonth: string, postedMonths: ReadonlySet<string>) {
  const out: string[] = [];
  let [y, m] = asset.startMonth.split('-').map(Number) as [number, number];
  for (let i = 0; i < asset.usefulMonths; i++) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    if (month >= disposalMonth) break;
    if (!postedMonths.has(month)) out.push(month);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
export interface AssetDisposal {
  id: string;
  disposalDate: string;
  method: AssetDisposalMethod;
  proceeds: string;
  cost: string;
  accumulated: string;
  bookValue: string;
  gainLoss: string;
  note: string;
  journalEntryId: string;
  reversalEntryId: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}
