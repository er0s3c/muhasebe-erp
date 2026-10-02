import { describe, expect, it } from 'vitest';
import { pickTier, resolvePriceFrom, type PriceInputs, type PriceListCandidate } from './price-resolution';

const list = (over: Partial<PriceListCandidate> = {}): PriceListCandidate => ({
  id: 'L1',
  code: 'L1',
  name: 'Bayi',
  currency: 'TRY',
  isActive: true,
  validFrom: null,
  validTo: null,
  rows: [{ minQty: '0', price: '90', validFrom: null, validTo: null }],
  ...over,
});
const base = (over: Partial<PriceInputs> = {}): PriceInputs => ({
  date: '2026-06-15',
  quantity: '1',
  currency: 'TRY',
  partyRows: [],
  partyList: null,
  defaultList: null,
  itemCard: { price: '100', currency: 'TRY' },
  partyDiscountPct: '0',
  ...over,
});

describe('fiyat çözümleme sırası', () => {
  it('hiçbir kaynak yoksa fiyat yok; yalnızca kart varsa kart', () => {
    expect(resolvePriceFrom(base({ itemCard: null })).priceSource).toBe('none');
    expect(resolvePriceFrom(base())).toMatchObject({ unitPrice: '100', priceSource: 'item_card', discountPct: '0', discountSource: 'none' });
  });

  it('sıra: cari özel > cari listesi > şirket varsayılan listesi > kart', () => {
    const party = [{ minQty: '0', validFrom: null, validTo: null, price: '70', currency: 'TRY', discountPct: null }];
    const r1 = resolvePriceFrom(base({ partyRows: party, partyList: list(), defaultList: list({ id: 'D', rows: [{ minQty: '0', price: '95', validFrom: null, validTo: null }] }) }));
    expect(r1).toMatchObject({ unitPrice: '70', priceSource: 'party_item' });
    const r2 = resolvePriceFrom(base({ partyList: list(), defaultList: list({ id: 'D', name: 'Genel', rows: [{ minQty: '0', price: '95', validFrom: null, validTo: null }] }) }));
    expect(r2).toMatchObject({ unitPrice: '90', priceSource: 'party_list', priceListId: 'L1', priceListName: 'Bayi' });
    const r3 = resolvePriceFrom(base({ defaultList: list({ id: 'D', name: 'Genel', rows: [{ minQty: '0', price: '95', validFrom: null, validTo: null }] }) }));
    expect(r3).toMatchObject({ unitPrice: '95', priceSource: 'default_list', priceListName: 'Genel' });
  });

  it('para birimi uyuşmayan, pasif ve süresi geçmiş kaynak atlanır; kalemi olmayan liste bir sonrakine düşer', () => {
    expect(resolvePriceFrom(base({ partyList: list({ currency: 'EUR' }) })).priceSource).toBe('item_card');
    expect(resolvePriceFrom(base({ partyList: list({ isActive: false }) })).priceSource).toBe('item_card');
    expect(resolvePriceFrom(base({ partyList: list({ validTo: '2026-06-01' }) })).priceSource).toBe('item_card');
    expect(resolvePriceFrom(base({ partyList: list({ rows: [] }), defaultList: list({ id: 'D' }) })).priceSource).toBe('default_list');
    expect(resolvePriceFrom(base({ currency: 'EUR' })).priceSource).toBe('none');
    const eur = [{ minQty: '0', validFrom: null, validTo: null, price: '5', currency: 'EUR', discountPct: null }];
    expect(resolvePriceFrom(base({ partyRows: eur })).priceSource).toBe('item_card');
  });

  it('miktar kademesi: uygun en büyük kademe; kademenin altındaki miktar bir sonraki kaynağa düşer', () => {
    const rows = [
      { minQty: '0', price: '90', validFrom: null, validTo: null },
      { minQty: '10', price: '80', validFrom: null, validTo: null },
      { minQty: '100', price: '70', validFrom: null, validTo: null },
    ];
    expect(resolvePriceFrom(base({ quantity: '9', partyList: list({ rows }) })).unitPrice).toBe('90');
    expect(resolvePriceFrom(base({ quantity: '10', partyList: list({ rows }) })).unitPrice).toBe('80');
    expect(resolvePriceFrom(base({ quantity: '250', partyList: list({ rows }) })).unitPrice).toBe('70');
    const only10 = [{ minQty: '10', price: '80', validFrom: null, validTo: null }];
    expect(resolvePriceFrom(base({ quantity: '5', partyList: list({ rows: only10 }) })).priceSource).toBe('item_card');
  });

  it('satır geçerliliği: tarih dışı satır yok sayılır; eşit kademede en yeni başlangıç kazanır', () => {
    const rows = [
      { minQty: '0', price: '90', validFrom: '2026-01-01', validTo: '2026-12-31' },
      { minQty: '0', price: '85', validFrom: '2026-06-01', validTo: null },
      { minQty: '0', price: '60', validFrom: '2025-01-01', validTo: '2025-12-31' },
    ];
    expect(resolvePriceFrom(base({ partyList: list({ rows }) })).unitPrice).toBe('85');
    expect(resolvePriceFrom(base({ date: '2026-03-01', partyList: list({ rows }) })).unitPrice).toBe('90');
    expect(pickTier(rows, '2024-01-01', '1')).toBeNull();
  });
});

describe('iskonto çözümleme', () => {
  const disc = (d: string, minQty = '0') => ({ minQty, validFrom: null, validTo: null, price: null, currency: null, discountPct: d });
  it('cari genel iskontosu liste/kart fiyatına uygulanır', () => {
    expect(resolvePriceFrom(base({ partyDiscountPct: '5' }))).toMatchObject({ discountPct: '5.0000', discountSource: 'party_default' });
  });
  it('kalem iskontosu genel iskontoyu ezer ve fiyat başka kaynaktan gelir', () => {
    const r = resolvePriceFrom(base({ partyRows: [disc('12.5')], partyDiscountPct: '5', partyList: list() }));
    expect(r).toMatchObject({ unitPrice: '90', priceSource: 'party_list', discountPct: '12.5000', discountSource: 'party_item' });
  });
  it('cariye özel fiyat kendi iskontosu yoksa genel iskontoyu uygulatmaz', () => {
    const special = { minQty: '0', validFrom: null, validTo: null, price: '70', currency: 'TRY', discountPct: null };
    expect(resolvePriceFrom(base({ partyRows: [special], partyDiscountPct: '5' }))).toMatchObject({ priceSource: 'party_item', discountPct: '0', discountSource: 'none' });
    expect(resolvePriceFrom(base({ partyRows: [{ ...special, discountPct: '3' }], partyDiscountPct: '5' }))).toMatchObject({ discountPct: '3.0000', discountSource: 'party_item' });
  });
  it('iskonto kademesi miktara göre seçilir', () => {
    const rows = [disc('2', '0'), disc('8', '50')];
    expect(resolvePriceFrom(base({ quantity: '49', partyRows: rows })).discountPct).toBe('2.0000');
    expect(resolvePriceFrom(base({ quantity: '50', partyRows: rows })).discountPct).toBe('8.0000');
  });
});
