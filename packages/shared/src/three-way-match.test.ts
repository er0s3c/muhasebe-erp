import { describe, expect, it } from 'vitest';
import { evaluateMatch } from './three-way-match';

const base = { orderedQty: '10', receivedQty: '10', invoicedBeforeQty: '0', invoiceQty: '10', orderPrice: '100', invoicePrice: '100', qtyTolerancePct: '0', priceTolerancePct: '2' };

describe('evaluateMatch', () => {
  it('tam eşleşme bayraksızdır', () => {
    expect(evaluateMatch(base)).toMatchObject({ flags: [], priceDiffPct: '0.00' });
  });
  it('kabulden fazla fatura over_received, siparişten fazla over_ordered', () => {
    expect(evaluateMatch({ ...base, receivedQty: '6', invoiceQty: '8' }).flags).toEqual(['over_received']);
    expect(evaluateMatch({ ...base, invoicedBeforeQty: '4', invoiceQty: '8', receivedQty: '12' }).flags).toEqual(['over_ordered']);
  });
  it('miktar toleransı sipariş miktarının yüzdesidir', () => {
    expect(evaluateMatch({ ...base, invoiceQty: '10.4', receivedQty: '10.4', qtyTolerancePct: '5' }).flags).toEqual([]);
    expect(evaluateMatch({ ...base, invoiceQty: '10.6', receivedQty: '10.6', qtyTolerancePct: '5' }).flags).toEqual(['over_ordered']);
  });
  it('fiyat sapması işaretli yüzdedir; sınırda geçer', () => {
    expect(evaluateMatch({ ...base, invoicePrice: '102' })).toMatchObject({ flags: [], priceDiffPct: '2.00' });
    expect(evaluateMatch({ ...base, invoicePrice: '97' })).toMatchObject({ flags: ['price_variance'], priceDiffPct: '-3.00' });
    expect(evaluateMatch({ ...base, orderPrice: '0', invoicePrice: '1' })).toMatchObject({ flags: ['price_variance'], priceDiffPct: null });
  });
});
