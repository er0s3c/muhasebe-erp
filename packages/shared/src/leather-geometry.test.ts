import { describe, expect, it } from 'vitest';
import { defectUsableAreas, patternScaleIssue, polygonArea, toneKey } from './leather-geometry';

const square = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('deri geometrisi (F8)', () => {
  it('çokgen alanı ve kusur sınıfına göre kullanılabilir alan', () => {
    expect(polygonArea(square(0, 0, 0.5, 0.5))).toBeCloseTo(0.25);
    const r = defectUsableAreas({
      area: '10',
      usableArea: '10',
      outline: square(0, 0, 1, 1),
      defects: [
        { code: 'D', kind: 'hole', points: square(0, 0, 0.5, 0.2) },
        { code: 'C', kind: 'tone', points: square(0, 0.5, 0.5, 1) },
      ],
    });
    expect(r).toEqual({ hiddenUsable: '9.0000', visibleUsable: '6.5000' });
    // Kayıtlı kullanılabilir alan üst sınırdır
    expect(defectUsableAreas({ area: '10', usableArea: '8', outline: null, defects: [] })).toEqual({ hiddenUsable: '8.0000', visibleUsable: '8.0000' });
  });

  it('ton anahtarı ve kalıp ölçeği', () => {
    expect(toneKey('  taba   1 ')).toBe(toneKey('Taba 1'));
    expect(toneKey('')).toBe('');
    expect(patternScaleIssue('0.5')).toBeNull();
    expect(patternScaleIssue('0.5', 1000, 1000)).toBeNull();
    expect(patternScaleIssue('0.5', 100, 100)).toMatch(/büyük/);
    expect(patternScaleIssue('0.01', 1000, 1000)).toMatch(/küçük/);
  });
});
