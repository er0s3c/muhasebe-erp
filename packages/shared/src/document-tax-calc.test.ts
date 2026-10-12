import { describe, expect, it } from 'vitest';
import { calculateDocumentTaxes, reverseDocumentTaxes, type DocumentTaxInput } from './document-tax-calc';
const input: DocumentTaxInput = { jurisdiction: 'TR', rulePackVersion: 'test', sourceRefs: ['https://gib.gov.tr/'], netAmount: '1000', vatRatePct: '20', vatWithholding: { numerator: 7, denominator: 10 }, incomeWithholding: { ratePct: '10', basis: 'net' }, stamp: { kind: 'percentage', ratePct: '0.948', basis: 'net', exemptAmount: '0', capAmount: null } };
describe('türlü belge vergisi hesapları', () => {
  it('KDV tevkifatını KDVye, stopajı seçilen esasa uygular', () => {
    expect(calculateDocumentTaxes(input)).toMatchObject({ vat: '200.00', grossAmount: '1200.00', vatWithheld: '140.00', vatPayableToSeller: '60.00', incomeWithheld: '100.00', stamp: '9.48', payableToSeller: '960.00' });
  });
  it('KKTC pul için maktu tutar veya istisna/tavanlı nispi hesap kullanılabilir', () => {
    expect(calculateDocumentTaxes({ ...input, jurisdiction: 'KKTC', stamp: { kind: 'fixed', amount: '25.00' } }).stamp).toBe('25.00');
    expect(calculateDocumentTaxes({ ...input, stamp: { kind: 'percentage', ratePct: '10', basis: 'gross', exemptAmount: '200', capAmount: '50' } }).stamp).toBe('50.00');
  });
  it('iade orijinal vergi görüntüsünü ters çevirir ve orijinali değiştirmez', () => {
    const original = calculateDocumentTaxes(input);
    const reversed = reverseDocumentTaxes(original);
    expect(reversed).toMatchObject({ direction: 'reversal', vat: '-200.00', vatWithheld: '-140.00', stamp: '-9.48', payableToSeller: '-960.00' });
    expect(original.vat).toBe('200.00');
    expect(reversed.input).toEqual(original.input);
    expect(() => reverseDocumentTaxes(reversed)).toThrow();
  });
  it('geçersiz tevkifat/kesinti ve negatif matrahları reddeder', () => {
    expect(() => calculateDocumentTaxes({ ...input, vatWithholding: { numerator: 11, denominator: 10 } })).toThrow();
    expect(() => calculateDocumentTaxes({ ...input, netAmount: '-1' })).toThrow();
    expect(() => calculateDocumentTaxes({ ...input, vatWithholding: { numerator: 1, denominator: 1 }, incomeWithholding: { basis: 'gross', ratePct: '100' } })).toThrow('aşamaz');
  });
  it('KDV dahil küçük tutarda brüt-net kuruşunu korur, tutarsız KDV tutarını reddeder', () => {
    expect(calculateDocumentTaxes({ ...input, netAmount: '0.50', vatRatePct: '1', vatAmount: '0.00', stamp: null })).toMatchObject({ vat: '0.00', grossAmount: '0.50', vatWithheld: '0.00', incomeWithheld: '0.05', payableToSeller: '0.45' });
    expect(() => calculateDocumentTaxes({ ...input, vatAmount: '199.98' })).toThrow('uyuşmuyor');
  });
});
