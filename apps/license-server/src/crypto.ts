import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** Yönetici TOTP sırlarını diskte şifreler (AES-256-GCM; anahtar `LICENSE_DATA_KEY`'den HKDF ile türetilir). */
const keyOf = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'erp-license-admin', 'totp-secret-v1', 32));

export function encryptSecret(plain: string, dataKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(dataKey), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptSecret(blob: string, dataKey: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Geçersiz şifreli değer');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(dataKey), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
