import { z } from 'zod';

/**
 * Zod'un varsayılan (İngilizce) doğrulama iletileri yerine kısa Türkçe iletiler (API-9, UI-11). Şemada açıkça verilen
 * ileti (`.min(2, 'Ad en az 2 karakter')`) her zaman önceliklidir; bu eşleme yalnızca iletisiz kurallar içindir.
 * Paylaşılan şemalar (`schemas/common`) yüklenince kurulur; böylece API yanıtları ve aynı şemaları kullanan web
 * formları aynı iletileri gösterir.
 */

const FORMAT_NAMES: Record<string, string> = {
  email: 'e-posta adresi',
  url: 'adres (URL)',
  uuid: 'kimlik',
  guid: 'kimlik',
  date: 'tarih',
  datetime: 'tarih ve saat',
  time: 'saat',
  duration: 'süre',
  ipv4: 'IPv4 adresi',
  ipv6: 'IPv6 adresi',
  base64: 'base64 metni',
  base64url: 'base64 metni',
  json_string: 'JSON metni',
  e164: 'telefon numarası',
  jwt: 'belirteç',
  regex: 'biçim',
};

const TYPE_NAMES: Record<string, string> = {
  string: 'metin',
  number: 'sayı',
  int: 'tam sayı',
  bigint: 'tam sayı',
  boolean: 'evet/hayır değeri',
  object: 'nesne',
  array: 'liste',
  date: 'tarih',
  null: 'boş değer',
};

type Issue = z.core.$ZodRawIssue;

function sizeUnit(origin: string | undefined): string {
  switch (origin) {
    case 'string':
      return ' karakter';
    case 'array':
    case 'set':
    case 'map':
      return ' öğe';
    case 'file':
      return ' bayt';
    default:
      return '';
  }
}

export function turkishZodMessage(issue: Issue): string {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) return 'Zorunlu alan';
      if (issue.expected === 'nan' || (issue.expected === 'number' && typeof issue.input === 'number')) return 'Geçersiz sayı';
      const t = TYPE_NAMES[issue.expected as string];
      return t ? `Geçersiz değer: ${t} bekleniyor` : 'Geçersiz değer';
    }
    case 'too_small': {
      const unit = sizeUnit(issue.origin as string | undefined);
      const min = String(issue.minimum);
      if (issue.origin === 'string' && Number(issue.minimum) === 1 && issue.inclusive !== false) return 'Boş bırakılamaz';
      if (issue.origin === 'array' && Number(issue.minimum) === 1 && issue.inclusive !== false) return 'En az bir öğe gerekli';
      if ((issue as { exact?: boolean }).exact) return `Tam ${min}${unit} olmalı`;
      return issue.inclusive === false ? `${min}${unit} değerinden büyük olmalı` : `En az ${min}${unit} olmalı`;
    }
    case 'too_big': {
      const unit = sizeUnit(issue.origin as string | undefined);
      const max = String(issue.maximum);
      if ((issue as { exact?: boolean }).exact) return `Tam ${max}${unit} olmalı`;
      return issue.inclusive === false ? `${max}${unit} değerinden küçük olmalı` : `En çok ${max}${unit} olmalı`;
    }
    case 'invalid_format': {
      const f = issue.format as string;
      if (f === 'starts_with') return `"${(issue as { prefix?: string }).prefix}" ile başlamalı`;
      if (f === 'ends_with') return `"${(issue as { suffix?: string }).suffix}" ile bitmeli`;
      if (f === 'includes') return `"${(issue as { includes?: string }).includes}" içermeli`;
      if (f === 'regex') return 'Geçersiz biçim';
      return `Geçersiz ${FORMAT_NAMES[f] ?? 'biçim'}`;
    }
    case 'not_multiple_of':
      return `${String(issue.divisor)} katı olmalı`;
    case 'unrecognized_keys':
      return `Tanınmayan alan: ${issue.keys.join(', ')}`;
    case 'invalid_value':
      return issue.values.length === 1 ? 'Geçersiz değer' : 'Geçersiz seçim';
    case 'invalid_union':
    case 'invalid_key':
    case 'invalid_element':
    case 'custom':
    default:
      return 'Geçersiz değer';
  }
}

let installed = false;

/** Türkçe iletileri zod'un genel yapılandırmasına kurar (birden çok çağrı zararsızdır). */
export function installZodTurkish(): void {
  if (installed) return;
  installed = true;
  z.config({ localeError: (issue) => turkishZodMessage(issue as Issue) });
}
