import { describe, expect, it } from 'vitest';
import { measureDrawing } from './construction-control';
import { criticalPath, WORKFLOW_PAYLOADS } from './construction-workflows';
describe('İnşaat hesapları', () => {
  it('PDF oranı ve ölçeğiyle uzunluk/alan hesaplar', () => {
    expect(
      measureDrawing(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        'length',
        1000,
        500,
        0.01,
      ),
    ).toBe(10);
    expect(
      measureDrawing(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        'area',
        1000,
        500,
        0.01,
      ),
    ).toBe(50);
    expect(() => measureDrawing([{ x: 0, y: 0 }], 'area', 1000, 500, 0.01)).toThrow();
  });
  it('hafta sonu, tatil, kritik yol, paralel iş ve döngü', () => {
    const a = {
      id: 'a',
      title: 'A',
      start: '2026-10-05',
      end: '2026-10-06',
      progress: 0,
      dependencies: [],
    };
    const b = {
      ...a,
      id: 'b',
      title: 'B',
      start: '2026-10-06',
      end: '2026-10-09',
      dependencies: ['a'],
    };
    const parallel = { ...a, id: 'c', title: 'C', end: '2026-10-05' };
    const r = criticalPath([a, b, parallel], [1, 2, 3, 4, 5], ['2026-10-07']);
    expect(r.finish).toBe('2026-10-12');
    expect(r.activities.find((x) => x.id === 'b')?.computedStart).toBe('2026-10-08');
    expect(r.activities.find((x) => x.id === 'c')?.critical).toBe(false);
    expect(() => criticalPath([{ ...a, dependencies: ['b'] }, b])).toThrow('döngüsü');
    expect(() => criticalPath([{ ...a, dependencies: ['missing'] }])).toThrow('bulunamadı');
  });
  it('boş numune sonucu sıfır değildir; izin tarihini doğrular', () => {
    const concrete = WORKFLOW_PAYLOADS.concrete.parse({
      supplierId: '00000000-0000-4000-8000-000000000001',
      batchNo: 'A',
      quantity: 10,
      date: '2026-10-06',
      samples: [{ name: '7 gün', testDate: '2026-10-13', strength: null, minimum: 20 }],
    });
    expect(concrete.samples[0]?.strength).toBeNull();
    expect(
      WORKFLOW_PAYLOADS.permit.safeParse({
        type: 'height',
        start: '2026-10-07',
        end: '2026-10-06',
        checklist: [{ label: 'Kontrol', checked: true }],
        procedure: 'Yöntem',
      }).success,
    ).toBe(false);
  });
});
