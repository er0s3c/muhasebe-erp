import { describe, expect, it } from 'vitest';
import {
  activationCodePrefix,
  base32Decode,
  base32Encode,
  computeFingerprint,
  formatActivationCode,
  generateActivationCode,
  generateTotpSecret,
  hashActivationCode,
  hotp,
  normalizeActivationCode,
  otpauthUri,
  totpCounter,
  verifyTotp,
} from '../src';

describe('TOTP (RFC 6238 ekli test vektörleri, HMAC-SHA1, 6 hane)', () => {
  const secret = Buffer.from('12345678901234567890');
  const cases: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [t, code] of cases) {
    it(`t=${t} -> ${code}`, () => expect(hotp(secret, totpCounter(t * 1000))).toBe(code));
  }

  it('base32 gidiş-dönüş; verifyTotp ±1 adım kabul eder, dışını ve biçimi bozuk kodu reddeder, sayaç döndürür', () => {
    const b32 = base32Encode(secret);
    expect(base32Decode(b32).equals(secret)).toBe(true);
    const now = 1111111109 * 1000;
    expect(verifyTotp(b32, '081804', now)).toBe(totpCounter(now));
    expect(verifyTotp(b32, '081804', now + 30_000)).toBe(totpCounter(now)); // bir adım sonrası hâlâ kabul
    expect(verifyTotp(b32, '081804', now + 90_000)).toBeNull();
    expect(verifyTotp(b32, '12345', now)).toBeNull();
    expect(verifyTotp(b32, 'abcdef', now)).toBeNull();
    expect(() => base32Decode('1!')).toThrow();
  });

  it('gizli anahtar üretimi ve otpauth URI', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri(s, 'ben@ornek.com', 'Muhasebe Lisans')).toContain(`secret=${s}`);
  });
});

describe('etkinleştirme kodu', () => {
  it('biçim: 5x5 grup, 125 bit; normalizasyon büyük/küçük harf, tire ve karışan karakterleri düzeltir', () => {
    const code = generateActivationCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    const norm = normalizeActivationCode(code)!;
    expect(norm).toHaveLength(25);
    expect(formatActivationCode(norm)).toBe(code);
    expect(normalizeActivationCode(code.toLowerCase().replaceAll('-', ' '))).toBe(norm);
    expect(normalizeActivationCode('O'.repeat(25))).toBe('0'.repeat(25));
    expect(normalizeActivationCode('kısa')).toBeNull();
    expect(normalizeActivationCode('U'.repeat(25))).toBeNull(); // Crockford alfabesinde U yok
  });

  it('özet deterministik, prefix kısa ve koddan geri üretilemez uzunlukta değil', () => {
    const n = normalizeActivationCode(generateActivationCode())!;
    expect(hashActivationCode(n)).toBe(hashActivationCode(n));
    expect(hashActivationCode(n)).toMatch(/^[0-9a-f]{64}$/);
    expect(activationCodePrefix(n)).toHaveLength(5);
    const other = normalizeActivationCode(generateActivationCode())!;
    expect(hashActivationCode(other)).not.toBe(hashActivationCode(n));
    // Kodlar çakışmaz (125 bit)
    const set = new Set(Array.from({ length: 500 }, () => generateActivationCode()));
    expect(set.size).toBe(500);
  });
});

describe('sunucu parmak izi', () => {
  it('kararlı, girdiye duyarlı ve ham kimlikleri içermez', () => {
    const a = computeFingerprint('ABC123', '7623409829129200177');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFingerprint(' abc123\n', '7623409829129200177')).toBe(a); // boşluk/büyük harf normalleştirilir
    expect(computeFingerprint('abc124', '7623409829129200177')).not.toBe(a);
    expect(computeFingerprint('abc123', '7623409829129200178')).not.toBe(a);
    expect(computeFingerprint(null, '1')).toBe(computeFingerprint('', '1'));
    expect(a).not.toContain('abc123');
  });
});
