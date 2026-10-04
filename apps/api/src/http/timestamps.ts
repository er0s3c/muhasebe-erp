/**
 * Ham SQL (`tx.execute`) sorgularında PostgreSQL `timestamptz` değerleri sürücüden metin olarak gelir
 * ("2026-10-04 05:25:12.446371+00"); Drizzle `select()` ise Date döndürür ve JSON'da ISO 8601 olur. Yanıtların tutarlı olması
 * için (ve tarayıcıların bu biçimi farklı ayrıştırmaması için) yanıt gövdesindeki bu biçimdeki metinler ISO 8601'e
 * (`toISOString()`, UTC "Z") çevrilir. Yalnızca tam olarak PostgreSQL zaman damgası biçimindeki metinler değişir; tarih
 * ("2026-10-04"), saat dilimsiz zaman damgası ve diğer metinler olduğu gibi kalır.
 */
const PG_TIMESTAMPTZ = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)([+-]\d{2})(?::?(\d{2}))?$/;

export function pgTimestampToIso(v: string): string | null {
  const m = PG_TIMESTAMPTZ.exec(v);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? '00'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const isPlain = (v: object) => {
  const p = Object.getPrototypeOf(v) as unknown;
  return p === Object.prototype || p === null;
};

/** Yazma sırasında kopyalayarak dönüştürür: değişiklik yoksa aynı nesne döner (paylaşılan nesneler değiştirilmez). */
export function isoTimestamps(value: unknown, depth = 0): unknown {
  if (depth > 32 || value === null) return value;
  if (typeof value === 'string') return value.length >= 22 && value.length <= 35 ? (pgTimestampToIso(value) ?? value) : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const next = isoTimestamps(value[i], depth + 1);
      if (next !== value[i]) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return out ?? value;
  }
  if (!isPlain(value)) return value;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(value)) {
    const next = isoTimestamps(v, depth + 1);
    if (next !== v) {
      out ??= { ...(value as Record<string, unknown>) };
      out[k] = next;
    }
  }
  return out ?? value;
}
