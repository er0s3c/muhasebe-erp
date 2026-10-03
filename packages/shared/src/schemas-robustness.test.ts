import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as shared from './index';
import { isoDate, moneyString } from './schemas/common';

/**
 * Şema sağlamlığı (API-2, API-4): paylaşılan şemalara verilen hiçbir girdi doğrulama sırasında istisna FIRLATMAZ
 * (özellikle `.regex` başarısız olduktan sonra da çalışan `.refine` içindeki Decimal dönüşümü → DecimalError → 500).
 * Her dışa aktarılan zod şeması için yaprak değerleri bozuk dizelerle doldurulmuş girdiler üretilir; `safeParse` her zaman
 * bir sonuç döndürmeli ve bozuk tutar/miktar reddedilmelidir.
 */
const BAD = ['1,5', 'abc', '', ' ', 'NaN', 'Infinity', '-Infinity', '1e999', '0x10', '1.2.3', '\u0000', '١٢'];

type Def = { type: string; [k: string]: any };
const defOf = (s: z.ZodType): Def => (s as any)._zod.def;

/** Şemaya uygun biçimde, her dize yaprağına `leaf(path)` değerini koyan bir girdi kurar. */
function build(s: z.ZodType, leaf: (path: string) => unknown, path = '', depth = 0): unknown {
  if (depth > 12) return undefined;
  const d = defOf(s);
  switch (d.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d.shape as Record<string, z.ZodType>)) out[k] = build(v, leaf, `${path}.${k}`, depth + 1);
      return out;
    }
    case 'array':
      return [build(d.element, leaf, `${path}[]`, depth + 1), build(d.element, leaf, `${path}[]`, depth + 1)];
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
    case 'success':
      return build(d.innerType, leaf, path, depth + 1);
    case 'pipe':
      return build(d.in, leaf, path, depth + 1);
    case 'lazy':
      return build(d.getter(), leaf, path, depth + 1);
    case 'union':
      return build(d.options[0], leaf, path, depth + 1);
    case 'intersection':
      return { ...(build(d.left, leaf, path, depth + 1) as object), ...(build(d.right, leaf, path, depth + 1) as object) };
    case 'record':
      return { k: build(d.valueType, leaf, `${path}.k`, depth + 1) };
    case 'tuple':
      return (d.items as z.ZodType[]).map((i, n) => build(i, leaf, `${path}[${n}]`, depth + 1));
    case 'enum':
      return Object.values(d.entries)[0];
    case 'literal':
      return d.values[0];
    case 'string':
      return leaf(path);
    case 'number':
    case 'int':
      return 1;
    case 'boolean':
      return true;
    default:
      return leaf(path);
  }
}

/** Yaprak yollarını toplar (tek tek bozmak için). */
function leaves(s: z.ZodType): string[] {
  const out: string[] = [];
  build(s, (p) => {
    out.push(p);
    return '1';
  });
  return out;
}

const schemas = Object.entries(shared).filter(
  ([, v]) => v && typeof v === 'object' && '_zod' in (v as object) && typeof (v as z.ZodType).safeParse === 'function',
) as [string, z.ZodType][];

describe('şema sağlamlığı: doğrulama istisna fırlatmaz (API-2)', () => {
  it('en az 100 şema taranıyor', () => {
    expect(schemas.length).toBeGreaterThan(100);
  });

  it.each(schemas)('%s', (_name, schema) => {
    // 1) Tüm yapraklar aynı bozuk değer
    for (const bad of BAD) {
      expect(() => schema.safeParse(build(schema, () => bad))).not.toThrow();
    }
    // 2) Tek yaprak bozuk, diğerleri geçerli olabilecek bir sayı ("1")
    for (const p of leaves(schema)) {
      for (const bad of BAD) {
        expect(() => schema.safeParse(build(schema, (q) => (q === p ? bad : '1')))).not.toThrow();
      }
    }
    // 3) Kök değer olarak bozuk dizeler
    for (const bad of BAD) expect(() => schema.safeParse(bad)).not.toThrow();
  });
});

describe('tutar/miktar şemaları bozuk sayıyı reddeder (API-2)', () => {
  const amountSchemas = schemas.filter(([n]) => /(money|quantity|amount|percent|rate|cost)(string)?$/i.test(n) && !/schema$/i.test(n));
  it('tutar/miktar şemaları bulundu', () => {
    const names = amountSchemas.map(([n]) => n);
    for (const n of ['moneyString', 'positiveMoney', 'positiveQuantity', 'quantityString', 'percentString', 'rateString', 'unitCostString']) expect(names).toContain(n);
  });
  it.each(amountSchemas)('%s', (_n, s) => {
    for (const bad of BAD) expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it('geçerli değerler kabul edilir', () => {
    expect(moneyString.safeParse('1.5').success).toBe(true);
    expect(shared.positiveMoney.safeParse('0').success).toBe(false);
    expect(shared.positiveMoney.safeParse('0.01').success).toBe(true);
    expect(shared.positiveQuantity.safeParse('2.5').success).toBe(true);
  });
});

describe('tarih aralığı (API-4)', () => {
  it('isoDate 1900-01-01 … 2100-12-31 dışını reddeder', () => {
    expect(isoDate.safeParse('1900-01-01').success).toBe(true);
    expect(isoDate.safeParse('2100-12-31').success).toBe(true);
    expect(isoDate.safeParse('1899-12-31').success).toBe(false);
    expect(isoDate.safeParse('0001-01-01').success).toBe(false);
    expect(isoDate.safeParse('9999-12-31').success).toBe(false);
    expect(isoDate.safeParse('2101-01-01').success).toBe(false);
    expect(isoDate.safeParse('2024-02-30').success).toBe(false);
  });
});

describe('Türkçe doğrulama iletileri (API-9, UI-11)', () => {
  it('uzunluk ve tür iletileri Türkçe', () => {
    const r = z.object({ name: z.string().min(2), n: z.number().max(3), e: z.email() }).safeParse({ name: 'a', n: 9, e: 'x' });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => i.message);
    expect(msgs[0]).toBe('En az 2 karakter olmalı');
    expect(msgs[1]).toBe('En çok 3 olmalı');
    expect(msgs[2]).toBe('Geçersiz e-posta adresi');
    for (const m of msgs) expect(m).not.toMatch(/Too small|Too big|Invalid|expected/);
  });
  it('eksik alan ve tarih iletileri Türkçe', () => {
    const r = z.object({ a: z.string(), d: isoDate }).safeParse({ d: '2024-13-01' });
    const msgs = r.error!.issues.map((i) => i.message);
    expect(msgs).toContain('Zorunlu alan');
    expect(msgs).toContain('Geçersiz tarih');
  });
});
