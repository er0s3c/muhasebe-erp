import { describe, expect, it } from 'vitest';
import { isValidIban, maskIban, normalizeIban } from './iban';

describe('IBAN denetimi', () => {
  it('geçerli IBAN mod-97 ile doğrulanır; tek hane hatası ve yer değişimi yakalanır', () => {
    expect(isValidIban('TR33 0006 1005 1978 6457 8413 26')).toBe(true);
    expect(isValidIban('GB82WEST12345698765432')).toBe(true);
    expect(isValidIban('TR33 0006 1005 1978 6457 8413 27')).toBe(false);
    expect(isValidIban('TR33 0006 1005 1978 6457 8413 62')).toBe(false);
    expect(isValidIban('12345')).toBe(false);
    expect(normalizeIban(' tr33 0006 ')).toBe('TR330006');
    expect(maskIban('TR', '1326')).toBe('TR•• •••• •••• 1326');
  });
});
