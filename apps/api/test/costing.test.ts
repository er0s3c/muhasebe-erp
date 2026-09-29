import { describe, expect, it } from 'vitest';
import { dec } from '@erp/shared';
import {
  applyIssue,
  costIssue,
  costReceipt,
  referenceUnitCost,
  type ItemState,
} from '../src/modules/inventory/costing';

const st = (qty: string, value: string, lastCost: string | null = null): ItemState => ({
  qty: dec(qty),
  value: dec(value),
  lastCost: lastCost === null ? null : dec(lastCost),
});
const show = (s: ItemState) => `${s.qty.toFixed(4)} / ${s.value.toFixed(2)}`;

describe('hareketli ağırlıklı ortalama maliyet', () => {
  it('iki alış sonrası ortalama: 10@10 + 10@20 → 20 ad, 300,00 (ort. 15)', () => {
    const a = costReceipt(st('0', '0'), dec(10), dec(100));
    const b = costReceipt(a.after, dec(10), dec(200));
    expect(show(b.after)).toBe('20.0000 / 300.00');
    expect(b.adjustment.isZero()).toBe(true);
    expect(referenceUnitCost(b.after).toFixed(2)).toBe('15.00');
  });

  it('çıkış ortalama maliyetle: 20 ad / 300 → 5 ad çıkış = 75,00', () => {
    const s = st('20', '300');
    const v = costIssue(s, dec(5));
    expect(v.toFixed(2)).toBe('75.00');
    expect(show(applyIssue(s, dec(5), v))).toBe('15.0000 / 225.00');
  });

  it('kalanı boşaltma tüm değeri çıkarır; kuruş artığı kalmaz (100,00 / 3 ad)', () => {
    let s = st('3', '100.00');
    const outs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const v = costIssue(s, dec(1));
      outs.push(v.toFixed(2));
      s = applyIssue(s, dec(1), v);
    }
    expect(outs).toEqual(['33.33', '33.34', '33.33']);
    expect(outs.reduce((a, b) => a.plus(b), dec(0)).toFixed(2)).toBe('100.00');
    expect(show(s)).toBe('0.0000 / 0.00');
  });

  it('miktarın tamamı tek çıkışta değerin tamamını alır', () => {
    expect(costIssue(st('7', '123.45'), dec(7)).toFixed(2)).toBe('123.45');
  });

  it('sıfır maliyetli (bedelsiz) mal sıfır değerle çıkar', () => {
    const r = costReceipt(st('0', '0'), dec(4), dec(0));
    expect(costIssue(r.after, dec(2)).isZero()).toBe(true);
    expect(r.after.lastCost).toBeNull();
  });

  it('son alış maliyeti bedelsiz girişle bozulmaz', () => {
    const a = costReceipt(st('0', '0'), dec(2), dec(50));
    const b = costReceipt(a.after, dec(3), dec(0));
    expect(b.after.lastCost?.toFixed(2)).toBe('25.00');
  });
});

describe('negatif stok maliyeti', () => {
  it('bakiyesiz malın çıkışı son alış maliyetiyle değerlenir', () => {
    const s = st('0', '0', '10');
    const v = costIssue(s, dec(5));
    expect(v.toFixed(2)).toBe('50.00');
    expect(show(applyIssue(s, dec(5), v))).toBe('-5.0000 / -50.00');
  });

  it('maliyeti hiç bilinmeyen mal sıfır maliyetle çıkar', () => {
    expect(costIssue(st('0', '0'), dec(5)).isZero()).toBe(true);
  });

  it('bakiyeyi aşan çıkış ortalama maliyetle: 2 ad / 30 → 5 ad = 75,00', () => {
    const s = st('2', '30');
    const v = costIssue(s, dec(5));
    expect(v.toFixed(2)).toBe('75.00');
    expect(show(applyIssue(s, dec(5), v))).toBe('-3.0000 / -45.00');
  });

  it('eksi bakiye yeni alışla tamamen kapanır: −5 (−50) + 10@12 → 5 ad / 60, ek −10', () => {
    const r = costReceipt(st('-5', '-50'), dec(10), dec(120));
    expect(show(r.after)).toBe('5.0000 / 60.00');
    expect(r.adjustment.toFixed(2)).toBe('-10.00');
    // Envanter değeri = miktar × yeni ortalama
    expect(r.after.value.toFixed(2)).toBe(dec(5).times(12).toFixed(2));
  });

  it('eksi bakiye kısmen kapanır: −5 (−50) + 3@12 → −2 ad / −20, ek −6', () => {
    const r = costReceipt(st('-5', '-50'), dec(3), dec(36));
    expect(show(r.after)).toBe('-2.0000 / -20.00');
    expect(r.adjustment.toFixed(2)).toBe('-6.00');
  });

  it('tam denk gelen alış bakiyeyi sıfırlar: −5 (−50) + 5@12 → 0 / 0, ek −10', () => {
    const r = costReceipt(st('-5', '-50'), dec(5), dec(60));
    expect(show(r.after)).toBe('0.0000 / 0.00');
    expect(r.adjustment.toFixed(2)).toBe('-10.00');
  });

  it('alış eski maliyetten ucuzsa ek pozitiftir (envanter artar)', () => {
    const r = costReceipt(st('-5', '-50'), dec(5), dec(40));
    expect(r.adjustment.toFixed(2)).toBe('10.00');
    expect(show(r.after)).toBe('0.0000 / 0.00');
  });

  it('değer korunumu: alış değeri + ek = kapanan çıkışın gerçek maliyet farkı', () => {
    const before = st('-5', '-50');
    const r = costReceipt(before, dec(10), dec(120));
    // önceki değer + giriş değeri + ek = yeni değer
    expect(before.value.plus(r.value).plus(r.adjustment).toFixed(2)).toBe(r.after.value.toFixed(2));
  });
});

describe('değer korunumu (deterministik rastgele dizi)', () => {
  // Basit doğrusal eşlenik üreteci: testin her çalışmada aynı olması için
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it('eksiye düşmeyen 2000 hareket sonunda değer = alışlar − çıkışlar ve boşalınca tam sıfır', () => {
    const next = rng(42);
    let s = st('0', '0');
    let receipts = dec(0);
    let issues = dec(0);
    for (let i = 0; i < 2000; i++) {
      const r = next();
      if (r < 0.55 || s.qty.isZero()) {
        const qty = dec(Math.floor(next() * 9) + 1);
        const value = dec((next() * 100).toFixed(2));
        const res = costReceipt(s, qty, value);
        receipts = receipts.plus(value);
        s = res.after;
        expect(res.adjustment.isZero()).toBe(true);
      } else {
        const max = s.qty.toNumber();
        const qty = dec(Math.min(max, Math.floor(next() * 9) + 1));
        const v = costIssue(s, qty);
        issues = issues.plus(v);
        s = applyIssue(s, qty, v);
        expect(v.gte(0)).toBe(true);
      }
      expect(s.qty.gte(0)).toBe(true);
      expect(s.value.gte(0)).toBe(true);
      if (s.qty.isZero()) expect(s.value.isZero()).toBe(true);
    }
    expect(s.value.toFixed(2)).toBe(receipts.minus(issues).toFixed(2));
  });

  it('negatif bakiyeye izin verilen dizide de değer = alışlar − çıkışlar + ekler', () => {
    const next = rng(7);
    let s = st('0', '0', '10');
    let receipts = dec(0);
    let issues = dec(0);
    let adjustments = dec(0);
    for (let i = 0; i < 2000; i++) {
      if (next() < 0.5) {
        const qty = dec(Math.floor(next() * 9) + 1);
        const value = dec((next() * 100).toFixed(2));
        const res = costReceipt(s, qty, value);
        receipts = receipts.plus(value);
        adjustments = adjustments.plus(res.adjustment);
        s = res.after;
      } else {
        const qty = dec(Math.floor(next() * 9) + 1);
        const v = costIssue(s, qty);
        issues = issues.plus(v);
        s = applyIssue(s, qty, v);
      }
    }
    expect(s.value.toFixed(2)).toBe(receipts.minus(issues).plus(adjustments).toFixed(2));
  });
});
