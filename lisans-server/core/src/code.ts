import { createHash, randomInt } from 'node:crypto';

/**
 * Etkinleştirme kodu: 25 karakter Crockford base32 (125 bit), 5'li gruplar: `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`.
 * I, L, O, U karışıklık yaratmadığı için kullanılmaz. Satıcı yalnızca özetini saklar.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 25;

export function generateActivationCode(): string {
  const chars = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]!);
  return [0, 5, 10, 15, 20].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

/** Kullanıcı girdisini kanonik biçime getirir (büyük harf, tire/boşluk yok, O→0, I/L→1); geçersizse null. */
export function normalizeActivationCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== CODE_LENGTH || ![...cleaned].every((c) => ALPHABET.includes(c))) return null;
  return cleaned;
}

export const hashActivationCode = (normalized: string): string => createHash('sha256').update(`erp-code-v1|${normalized}`).digest('hex');

/** Panelde gösterilecek, koddan geri üretilemeyen kısa ipucu (ilk 5 karakter). */
export const activationCodePrefix = (normalized: string): string => normalized.slice(0, 5);

export const formatActivationCode = (normalized: string): string => normalized.match(/.{5}/g)!.join('-');
