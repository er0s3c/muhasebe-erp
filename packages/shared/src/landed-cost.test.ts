import { describe, expect, it } from 'vitest';
import { dec } from './money';
import { AllocationError, allocateAmount, landedUnitCost, percentOf, splitStockCogs, sumByLine, toBaseAmount, type AllocLine } from './landed-cost';

const L = (key: string, quantity: string, value: string, weight?: string): AllocLine => ({ key, quantity, value, weight });
const lines = [L('a', '10', '1000', '50'), L('b', '5', '500', '10'), L('c', '3', '300', '40')];
const total = (xs: readonly ReturnType<typeof dec>[]) => xs.reduce((s, x) => s.plus(x), dec(0)).toFixed(2);

describe('ithalat maliyet dağıtımı', () => {
  it('değere göre: pay oranı değerle orantılı, toplam tam tutar', () => {
    const r = allocateAmount('180', 'value', lines);
    expect(r.map((x) => x.toFixed(2))).toEqual(['100.00', '50.00', '30.00']);
    expect(total(r)).toBe('180.00');
  });

  it('miktara ve ağırlığa göre dağıtır', () => {
    expect(allocateAmount('180', 'quantity', lines).map((x) => x.toFixed(2))).toEqual(['100.00', '50.00', '30.00']);
    expect(allocateAmount('100', 'weight', lines).map((x) => x.toFixed(2))).toEqual(['50.00', '10.00', '40.00']);
  });

  it('kuruş yuvarlaması: son (paylı) satır kalanı alır ve toplam tam tutar olur', () => {
    const three = [L('a', '1', '1'), L('b', '1', '1'), L('c', '1', '1')];
    const r = allocateAmount('100', 'quantity', three);
    expect(r.map((x) => x.toFixed(2))).toEqual(['33.33', '33.33', '33.34']);
    expect(total(r)).toBe('100.00');
    // Aynı girdi her zaman aynı sonuç (belirli)
    expect(allocateAmount('100', 'quantity', three).map((x) => x.toFixed(2))).toEqual(['33.33', '33.33', '33.34']);
  });

  it('tabanı sıfır olan satır pay almaz; kalan son paylı satıra gider', () => {
    const z = [L('a', '2', '10'), L('b', '1', '0'), L('c', '1', '20'), L('d', '1', '0')];
    const r = allocateAmount('0.10', 'value', z);
    expect(r.map((x) => x.toFixed(2))).toEqual(['0.03', '0.00', '0.07', '0.00']);
  });

  it('elle dağıtım: toplam tutara eşit olmalı', () => {
    const r = allocateAmount('100', 'manual', lines, { a: '60', b: '30', c: '10' });
    expect(r.map((x) => x.toFixed(2))).toEqual(['60.00', '30.00', '10.00']);
    expect(() => allocateAmount('100', 'manual', lines, { a: '60', b: '30' })).toThrow(AllocationError);
    expect(() => allocateAmount('100', 'manual', lines, { a: '60', b: '30', c: '-10', })).toThrow(/eksi/);
  });

  it('hata durumları: ağırlık eksik, taban sıfır, satır yok', () => {
    expect(() => allocateAmount('10', 'weight', [L('a', '1', '1'), L('b', '1', '1', '2')])).toThrow(/ağırlık/);
    expect(() => allocateAmount('10', 'value', [L('a', '1', '0')])).toThrow(/sıfır/);
    expect(() => allocateAmount('10', 'value', [])).toThrow(/satır yok/);
  });

  it('satır toplamları ve birim maliyet öncesi/sonrası', () => {
    const m = [allocateAmount('180', 'value', lines), allocateAmount('100', 'weight', lines)];
    expect(sumByLine(m, 3).map((x) => x.toFixed(2))).toEqual(['150.00', '60.00', '70.00']);
    const u = landedUnitCost('10', '1000', '150');
    expect(u.before!.toFixed(4)).toBe('100.0000');
    expect(u.after!.toFixed(4)).toBe('115.0000');
    expect(landedUnitCost('0', '0', '5')).toEqual({ before: null, after: null });
  });

  it('kur ve yüzde yardımcıları yalnızca aritmetiktir', () => {
    expect(toBaseAmount('100.00', '34.5').toFixed(2)).toBe('3450.00');
    expect(toBaseAmount('100.00', null).toFixed(2)).toBe('100.00');
    expect(percentOf('1000', '7.5').toFixed(2)).toBe('75.00');
  });

  it('stok/satılan mal maliyeti ayrımı: elde kalan miktar payı stokta, kalanı maliyette', () => {
    const full = splitStockCogs(dec('90'), dec('10'), dec('10'));
    expect([full.toStock.toFixed(2), full.toCogs.toFixed(2)]).toEqual(['90.00', '0.00']);
    const part = splitStockCogs(dec('100'), dec('3'), dec('1'));
    expect([part.toStock.toFixed(2), part.toCogs.toFixed(2)]).toEqual(['33.33', '66.67']);
    const none = splitStockCogs(dec('50'), dec('5'), dec('0'));
    expect([none.toStock.toFixed(2), none.toCogs.toFixed(2)]).toEqual(['0.00', '50.00']);
    const over = splitStockCogs(dec('50'), dec('5'), dec('20'));
    expect([over.toStock.toFixed(2), over.toCogs.toFixed(2)]).toEqual(['50.00', '0.00']);
  });
});
