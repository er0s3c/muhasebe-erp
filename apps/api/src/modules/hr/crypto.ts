import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Personel kimlik/doğum tarihi/IBAN alanlarının uygulama düzeyinde şifrelenmesi (AES-256-GCM). Anahtar JWT_SECRET'ten HKDF ile
 * ayrı bir bağlam etiketiyle türetilir (MFA sırrı anahtarından farklıdır). Anahtar kaybı ya da değişimi şifreli alanları
 * okunamaz kılar: JWT_SECRET'i yedekle ve değiştirirsen önce alanları yeniden şifrele (docs/OPERATIONS.md).
 */
const encKey = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'erp-api', 'hr-personal-data-v1', 32));
const macKey = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'erp-api', 'hr-personal-data-hash-v1', 32));

export function encryptField(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptField(blob: string, secret: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Geçersiz şifreli değer');
  const decipher = createDecipheriv('aes-256-gcm', encKey(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Aynı kimliğin ikinci kez girilmesini yakalamak için (şirket bazında) deterministik HMAC. */
export function hashId(kind: string, value: string, secret: string): string {
  return createHmac('sha256', macKey(secret)).update(`${kind}:${value.replace(/\s+/g, '').toUpperCase()}`).digest('hex');
}

const last4 = (v: string) => v.replace(/\s+/g, '').slice(-4);
export const lastFour = last4;
export const maskTail = (tail: string | null) => (tail ? `••••${tail}` : null);
