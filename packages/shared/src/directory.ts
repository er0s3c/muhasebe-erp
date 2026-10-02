/**
 * Rehber (X6) saf yardımcıları: telefon/e-posta eşleme anahtarı (yinelenen kişi ipucu), etiket normalizasyonu, birleştirme planı,
 * ajanda kovası (gecikmiş/bugün/yaklaşan) ve vCard 3.0 çıktısı. Kimlik no / doğum tarihi gibi hassas tanımlayıcılar rehberde YOKTUR.
 */

/** Telefonu karşılaştırma anahtarına çevirir: yalnız rakamlar, son 10 hane (ülke/alan kodu farkını yutar). 7 haneden kısa ise null. */
export function phoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

export function emailKey(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

/** Etiketleri kırpar, boşları atar, büyük/küçük harf duyarsız tekilleştirir (ilk yazım korunur), sınırlar. */
export function normalizeTags(raw: readonly string[] | string | null | undefined): string[] {
  const list = typeof raw === 'string' ? raw.split(/[,;\n]/) : [...(raw ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list) {
    const tag = t.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
    const key = tag.toLocaleLowerCase('tr-TR');
    if (tag === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export interface ContactFields {
  fullName: string;
  title: string | null;
  organizationId: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  email2: string | null;
  address: string | null;
  partyId: string | null;
  employeeId: string | null;
  projectId: string | null;
  tags: string[];
  note: string | null;
}

/**
 * İki kişiyi birleştirme planı: `keep` kişisinin dolu alanları korunur, boş alanlar `drop`'tan doldurulur; farklı telefon/e-posta
 * ikinci alana (boşsa) taşınır, sığmayan atılır; etiketler birleşir; notlar iki not arasında ayrı satırlar olarak eklenir.
 */
export function planContactMerge(keep: ContactFields, drop: ContactFields): { merged: ContactFields; conflicts: string[] } {
  const conflicts: string[] = [];
  const pick = <T>(a: T | null, b: T | null, field: string): T | null => {
    if (a !== null && a !== undefined && a !== ('' as unknown as T)) {
      if (b !== null && b !== undefined && b !== a) conflicts.push(field);
      return a;
    }
    return b ?? null;
  };
  const pair = (a1: string | null, a2: string | null, b1: string | null, b2: string | null, key: (v: string | null) => string | null): [string | null, string | null] => {
    const vals: string[] = [];
    const keys = new Set<string>();
    for (const v of [a1, a2, b1, b2]) {
      if (!v) continue;
      const k = key(v) ?? v.toLowerCase();
      if (keys.has(k)) continue;
      keys.add(k);
      vals.push(v);
    }
    return [vals[0] ?? null, vals[1] ?? null];
  };
  const [phone, phone2] = pair(keep.phone, keep.phone2, drop.phone, drop.phone2, phoneKey);
  const [email, email2] = pair(keep.email, keep.email2, drop.email, drop.email2, emailKey);
  const notes = [keep.note, drop.note].filter((n): n is string => !!n && n.trim() !== '');
  return {
    merged: {
      fullName: keep.fullName,
      title: pick(keep.title, drop.title, 'title'),
      organizationId: pick(keep.organizationId, drop.organizationId, 'organizationId'),
      phone,
      phone2,
      email,
      email2,
      address: pick(keep.address, drop.address, 'address'),
      partyId: pick(keep.partyId, drop.partyId, 'partyId'),
      employeeId: pick(keep.employeeId, drop.employeeId, 'employeeId'),
      projectId: pick(keep.projectId, drop.projectId, 'projectId'),
      tags: normalizeTags([...keep.tags, ...drop.tags]),
      note: notes.length ? [...new Set(notes)].join('\n').slice(0, 1000) : null,
    },
    conflicts,
  };
}

// --- Ajanda ------------------------------------------------------------------------------------------------

export type AgendaBucket = 'overdue' | 'today' | 'upcoming' | 'later' | 'closed';
/** "Yaklaşan" penceresi: yarından başlayarak bu kadar gün. */
export const AGENDA_UPCOMING_DAYS = 7;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Açık kalem: tarihine göre gecikmiş / bugün / yaklaşan (yarından 7 gün) / daha ileri; kapalı (bitti/iptal) kalem 'closed'. */
export function agendaBucket(item: { status: string; dueDate: string }, today: string): AgendaBucket {
  if (item.status !== 'open') return 'closed';
  if (item.dueDate < today) return 'overdue';
  if (item.dueDate === today) return 'today';
  return item.dueDate <= addDaysIso(today, AGENDA_UPCOMING_DAYS) ? 'upcoming' : 'later';
}

// --- vCard 3.0 -----------------------------------------------------------------------------------------------

export interface VCardContact {
  fullName: string;
  title?: string | null;
  organizationName?: string | null;
  phone?: string | null;
  phone2?: string | null;
  email?: string | null;
  email2?: string | null;
  address?: string | null;
  tags?: readonly string[];
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');

/** RFC 6350/2425: 75 sütundan uzun satırlar bir boşlukla devam eder. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join('\r\n');
}

/** Tek kişi için vCard 3.0 bloğu (CRLF). Serbest not/görüşme notları DAHİL EDİLMEZ. */
export function buildVCard(c: VCardContact): string {
  const name = c.fullName.trim();
  const parts = name.split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1]! : '';
  const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : name;
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(family)};${esc(given)};;;`, `FN:${esc(name)}`];
  if (c.organizationName) lines.push(`ORG:${esc(c.organizationName)}`);
  if (c.title) lines.push(`TITLE:${esc(c.title)}`);
  for (const [i, t] of [c.phone, c.phone2].entries()) if (t) lines.push(`TEL;TYPE=${i === 0 ? 'WORK,VOICE' : 'CELL,VOICE'}:${t.replace(/[\r\n]/g, ' ')}`);
  for (const e of [c.email, c.email2]) if (e) lines.push(`EMAIL;TYPE=INTERNET:${e.replace(/[\r\n]/g, ' ')}`);
  if (c.address) lines.push(`ADR;TYPE=WORK:;;${esc(c.address)};;;;`);
  if (c.tags && c.tags.length) lines.push(`CATEGORIES:${c.tags.map(esc).join(',')}`);
  lines.push('END:VCARD');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export const buildVCards = (list: readonly VCardContact[]): string => list.map(buildVCard).join('');
