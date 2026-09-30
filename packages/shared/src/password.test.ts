import { describe, expect, it } from 'vitest';
import { registerSchema } from './schemas/auth';
import { changePasswordSchema } from './schemas/company';
import { isWeakPassword } from './password';

describe('parola politikası', () => {
  it('yaygın parolaları büyük/küçük harf ve ayraçtan bağımsız reddeder', () => {
    for (const p of ['1234567890', 'Password123', 'password-123!', 'QWERTYUIOP', 'Sifre-12345', 'iloveyou123', 'aaaaaaaaaaaa']) {
      expect(isWeakPassword(p), p).toBe(true);
    }
  });

  it('e-posta kullanıcı adını içeren parolayı reddeder (kısa adlar hariç)', () => {
    expect(isWeakPassword('mehmet.demir-2026!', { email: 'mehmet.demir@firma.com' })).toBe(true);
    expect(isWeakPassword('Tasarim-Yolu-4471', { email: 'mehmet.demir@firma.com' })).toBe(false);
    expect(isWeakPassword('Ali-2026-xyzzy!', { email: 'ali@firma.com' })).toBe(false);
  });

  it('özgün parolaları kabul eder', () => {
    for (const p of ['Sifre-12345-xyz', 'Yeni-Sifre-98765', 'Demo-Sifre-123', 'kirmizi-Bulut-84!']) {
      expect(isWeakPassword(p), p).toBe(false);
    }
  });

  it('kayıt ve şifre değiştirme şemaları zayıf parolayı Türkçe mesajla reddeder', () => {
    const reg = registerSchema.safeParse({ email: 'a@b.co', password: 'password123', fullName: 'Ab Cd', organizationName: 'Ab Ltd' });
    expect(reg.success).toBe(false);
    expect(JSON.stringify(reg.error?.issues)).toContain('çok yaygın');
    expect(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: '1234567890' }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'Yeni-Sifre-98765' }).success).toBe(true);
  });
});
