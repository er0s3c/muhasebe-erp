import { describe, expect, it } from 'vitest';
import { assetDisposalSchema, disposalResult, missingDepreciationMonths } from './fixed-assets';

describe('demirbaş elden çıkarma hesapları', () => {
  it('defter değeri ve kâr/zarar', () => {
    expect(disposalResult('1000.00', '300.00', '800')).toEqual({ bookValue: '700.00', gainLoss: '100.00' });
    expect(disposalResult('1000', '300', '0')).toEqual({ bookValue: '700.00', gainLoss: '-700.00' });
  });
  it('elden çıkarma ayından önceki kayıtsız aylar yıl sınırını geçer', () => {
    const asset = { startMonth: '2025-11', usefulMonths: 6 };
    expect(missingDepreciationMonths(asset, '2026-02', new Set(['2025-11']))).toEqual(['2025-12', '2026-01']);
    expect(missingDepreciationMonths(asset, '2025-11', new Set())).toEqual([]);
    expect(missingDepreciationMonths({ startMonth: '2025-01', usefulMonths: 2 }, '2026-01', new Set(['2025-01', '2025-02']))).toEqual([]);
  });
  it('hurdada bedel olmaz, bedelli satış karşı hesap ister', () => {
    const base = { date: '2026-01-10', assetAccountId: '018f0000-0000-7000-8000-000000000001', version: 1 };
    expect(assetDisposalSchema.safeParse({ ...base, method: 'scrap', proceeds: '10' }).success).toBe(false);
    expect(assetDisposalSchema.safeParse({ ...base, method: 'sale', proceeds: '10' }).success).toBe(false);
    expect(assetDisposalSchema.safeParse({ ...base, method: 'sale', proceeds: '10', proceedsAccountId: '018f0000-0000-7000-8000-000000000002' }).success).toBe(true);
  });
});
