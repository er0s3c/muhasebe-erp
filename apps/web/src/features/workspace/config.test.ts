import { describe, expect, it } from 'vitest';
import { operationsReturnDestination } from './config';

describe('operasyon ekranının şirket bağlamı', () => {
  it('deri ve üretim şirketlerinden kendi çalışma alanına döner', () => {
    for (const sector of ['LEATHER_FASHION', 'MANUFACTURING_WHOLESALE', 'GENERAL']) {
      expect(operationsReturnDestination(sector, true)).toEqual({ path: '/workspace', label: 'Çalışma alanı' });
    }
  });
  it('yalnız izinli inşaat bağlamında inşaat merkezini sunar', () => {
    expect(operationsReturnDestination('CONSTRUCTION', true).path).toBe('/workspace/construction');
    expect(operationsReturnDestination('CONSTRUCTION', false).path).toBe('/workspace');
  });
});
