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
