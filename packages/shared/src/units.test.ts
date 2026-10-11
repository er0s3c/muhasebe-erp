import { describe, expect, it } from 'vitest';
import { quantityIssues } from './units';

const kinds = (quantity: string, unit: string | null) => quantityIssues(quantity, unit).map((issue) => issue.kind);

describe('birim ve miktar tutarlılığı (öneri 31)', () => {
  it('sayılan birimde kesir, ölçülen birimde fazla ondalık uyarılır', () => {
    expect(quantityIssues('2.5', 'adet')).toEqual([{ kind: 'precision', message: 'adet tam sayı olarak girilir; 2,5 adet girildi.' }]);
    expect(kinds('2.0000', 'adet')).toEqual([]);
    expect(kinds('1.255', 'm2')).toEqual(['precision']);
    expect(kinds('1.255', 'kg')).toEqual([]);
    expect(quantityIssues('1.2345', 'kg')[0]!.message).toContain('en çok 3 ondalık');
  });
  it('küçük birimde büyük miktar üst birime çevrilerek gösterilir', () => {
    expect(quantityIssues('2500', 'g')).toEqual([{ kind: 'larger_unit', message: '2.500 g = 2,5 kg. Birim kg olmalıysa stok kartının birimini kontrol edin.' }]);
    expect(quantityIssues('3000', 'kg')[0]!.message).toContain('= 3 ton');
    expect(kinds('999', 'g')).toEqual([]);
  });
  it('olağan dışı büyüklük birimden bağımsız uyarılır; boş/geçersiz/sıfır miktar değerlendirilmez', () => {
    expect(kinds('1000000', 'adet')).toEqual(['unusual']);
    expect(kinds('1500000', null)).toEqual(['unusual']);
    expect(kinds('12', 'bilinmeyen')).toEqual([]);
    for (const value of ['', 'abc', '0', '-1', '1,5']) expect(kinds(value, 'adet')).toEqual([]);
  });
});
