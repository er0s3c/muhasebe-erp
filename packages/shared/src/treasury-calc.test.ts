import { describe, expect, it } from 'vitest';
import { dec } from './money';
import { proportionalBase, settlementFxDiff } from './treasury-calc';

describe('proportionalBase', () => {
  it('tamamı çıkıyorsa kalan defter tutarının tamamını taşır', () => {
    expect(proportionalBase(dec('3'), dec('3'), dec('100.00')).toFixed(2)).toBe('100.00');
  });

  it('kısmi tutarı orantılar ve iki ondalığa yuvarlar', () => {
    expect(proportionalBase(dec('1'), dec('3'), dec('100.00')).toFixed(2)).toBe('33.33');
    expect(proportionalBase(dec('20'), dec('50'), dec('2050')).toFixed(2)).toBe('820.00');
  });

  it('üç eşit kısmi kapanış tam toplamı verir (son pay kalanı alır)', () => {
    let doc = dec('3');
    let base = dec('100.00');
    let total = dec(0);
    for (let i = 0; i < 3; i++) {
      const part = proportionalBase(dec('1'), doc, base);
      total = total.plus(part);
      doc = doc.minus(1);
      base = base.minus(part);
    }
    expect(total.toFixed(2)).toBe('100.00');
  });
});

describe('settlementFxDiff', () => {
  it('tahsilatta taşınandan fazla alınan defter değeri kârdır', () => {
    expect(settlementFxDiff('receipt', dec('4000'), dec('4200')).toFixed(2)).toBe('200.00');
    expect(settlementFxDiff('receipt', dec('4000'), dec('3800')).toFixed(2)).toBe('-200.00');
  });

  it('ödemede taşınandan fazla ödenen defter değeri zarardır', () => {
    expect(settlementFxDiff('payment', dec('4000'), dec('4200')).toFixed(2)).toBe('-200.00');
    expect(settlementFxDiff('payment', dec('4000'), dec('3800')).toFixed(2)).toBe('200.00');
  });
});
