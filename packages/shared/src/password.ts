/**
 * Parola politikası: uzunluk şemalarda (en az 10 karakter); burada yaygın/tahmin edilebilir parolalar elenir.
 * Dış bir sızıntı hizmetine sorgu yapılmaz (gizlilik + çevrimdışı çalışma); liste bilinçli olarak kısa ve
 * yalnızca en sık kullanılan, 10+ karakterlik örnekleri içerir. Karşılaştırma büyük/küçük harf ve
 * harf-rakam dışı karakterlerden bağımsızdır ("Password-123!" ≈ "password123").
 */
const COMMON = new Set(
  `1234567890 0123456789 12345678910 123456789012 1234567890123 12345678901234 0987654321 9876543210
   qwertyuiop qwertyuiop1 qwertyuiopasdfghjkl asdfghjkl1 asdfghjklqwerty zxcvbnm123 qwerty1234 qwerty12345 qwerty123456
   1qaz2wsx3e 1qaz2wsx3edc 1q2w3e4r5t 1q2w3e4r5t6y 1q2w3e4r5t6y7u qazwsxedcrfv qazwsxedc123 1qazxsw23edc zaq12wsxcde3
   password12 password123 password1234 password12345 password123456 passw0rd123 p4ssw0rd12 pa55word123 passwordpassword
   iloveyou12 iloveyou123 iloveyou1234 welcome123 welcome1234 welcome12345 letmein1234 letmein12345
   administrator admin123456 admin1234567 administrator1 abc1234567 abcd123456 abcdefghij abcdefghijk abcdefghijkl
   aaaaaaaaaa bbbbbbbbbb 1111111111 2222222222 0000000000 9999999999 1212121212 1231231231 1122334455 1029384756
   sifre12345 sifre123456 sifre1234567 parola1234 parola12345 parola123456 sifresifre1 sifre12345678
   muhasebe123 muhasebe1234 muhasebe12345 muhasebe2024 muhasebe2025 muhasebe2026 erp1234567 erp123456789
   fenerbahce1907 fenerbahce19 galatasaray1905 galatasaray19 besiktas1903 besiktas1903 trabzonspor1967 trabzonspor61
   turkiye1923 turkiye12345 ataturk1881 ataturk1923 istanbul34 istanbul3434 ankara0606 lefkosa1974 girne1974 kktc1974 kibris1974
   changeme123 changeme1234 default1234 test123456 test1234567 testtest12 temp123456 guest12345 root123456 user123456
   monkey1234 dragon1234 football123 baseball123 master1234 sunshine123 princess123 superman123 michael1234 shadow1234
   computer123 internet123 whatever123 trustno1234 starwars123 freedom123 charlie123 jennifer123 hello12345 hello123456`
    .split(/\s+/)
    .filter(Boolean),
);

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9ğüşöçıİ]/g, '');

export interface PasswordContext {
  email?: string;
}

/** Yaygın, tek karakterli, art arda tuş dizisi ya da e-postayı içeren parolalar zayıf sayılır. */
export function isWeakPassword(password: string, ctx: PasswordContext = {}): boolean {
  const norm = normalize(password);
  if (COMMON.has(password.toLowerCase()) || COMMON.has(norm)) return true;
  if (/^(.)\1+$/.test(password)) return true;
  const local = ctx.email?.split('@')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  if (local.length >= 5 && norm.includes(local)) return true;
  return false;
}

export const WEAK_PASSWORD_MESSAGE = 'Bu şifre çok yaygın ya da tahmin edilebilir; daha özgün bir şifre seçin';
