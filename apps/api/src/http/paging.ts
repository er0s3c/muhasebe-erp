import { sql, type SQL } from 'drizzle-orm';
import type { PageQuery } from '@erp/shared';

export type { PageQuery };

/**
 * Liste sayfalama (API-7). Sayfa verilirse bir fazla satır istenir; fazla satır varsa yanıt `truncated: true` taşır.
 * Sayfa verilmezse (dışa aktarma, iç çağrılar) liste sınırsızdır.
 */
export const pageSql = (p?: PageQuery): SQL => (p ? sql`limit ${p.limit + 1} offset ${p.offset}` : sql``);

/** Sorgu sonucunu (limit+1 satır) sayfaya kırpar. */
export function paged<T>(rows: T[], p?: PageQuery): { rows: T[]; truncated: boolean } {
  if (!p) return { rows, truncated: false };
  return { rows: rows.slice(0, p.limit), truncated: rows.length > p.limit };
}

/** Bellekte süzülmüş tam listeden sayfa (sorgu sonrası süzme yapan listeler için). */
export function slicePage<T>(rows: T[], p?: PageQuery): { rows: T[]; truncated: boolean } {
  if (!p) return { rows, truncated: false };
  return { rows: rows.slice(p.offset, p.offset + p.limit), truncated: rows.length > p.offset + p.limit };
}

/** Ayrıştırılmış sorgudan sayfa parametrelerini alır. */
export const pageOf = (q: { limit: number; offset: number }): PageQuery => ({ limit: q.limit, offset: q.offset });
