/** IBAN'ı boşluksuz büyük harfe çevirir. */
export const normalizeIban = (value: string) => value.replace(/\s+/g, '').toUpperCase();

/**
 * IBAN biçim ve ISO 13616 mod-97 denetimi (öneri 53). Ülke uzunlukları denetlenmez; yazım/aktarma hatalarını (rakam
 * değişimi, yer değişimi) yakalamak içindir, hesabın varlığını doğrulamaz.
 */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Ekranda gösterim: ülke kodu ve son dört hane dışındakiler gizlenir. */
export const maskIban = (countryCode: string, last4: string) => `${countryCode}•• •••• •••• ${last4}`;
