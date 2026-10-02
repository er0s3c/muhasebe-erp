import { describe, expect, it } from 'vitest';
import { normalizeSerial, parseSerialList } from './serial-calc';

describe('seri no ayrıştırma', () => {
  it('büyük harfe çevirir, kırpar, ayraçları (satır, virgül, noktalı virgül, sekme) tanır', () => {
    expect(normalizeSerial('  sn-1 ')).toBe('SN-1');
    const r = parseSerialList('sn1\nsn2, sn3;sn4\tsn5\r\n"sn6"');
    expect(r.serials).toEqual(['SN1', 'SN2', 'SN3', 'SN4', 'SN5', 'SN6']);
  });
  it('yinelenenleri ve çok uzun olanları ayırır', () => {
    const r = parseSerialList(`a\nA\nb\n${'x'.repeat(61)}`);
    expect(r.serials).toEqual(['A', 'B']);
    expect(r.duplicates).toEqual(['A']);
    expect(r.tooLong).toHaveLength(1);
  });
});
