import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { dec, toDbAmount } from '@erp/shared';
import type { AuthCtx } from '../../http/context';
import { allOpenItems } from '../parties/service';
import { forEachScope, resolveGroupAccess, type ExcludedMember } from './access';

const norm = (v: string | null | undefined) => (v ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export interface IntercompanyHint {
  company: { id: string; name: string };
  party: { id: string; code: string; name: string; taxNumber: string };
  /** Cari kartının vergi numarasının eşleştiği, aynı gruptaki diğer şirket. */
  matchedCompany: { id: string; name: string };
  /** Açık alacak/borç (defter para biriminde, `asOf` itibarıyla). */
  receivable: string;
  payable: string;
  currency: string;
}

/**
 * Şirketler arası işlem İPUCU: bir şirketin cari kartının vergi numarası, aynı gruptaki başka bir şirketin vergi numarasıyla
 * eşleşiyorsa listelenir. Yalnızca ipucudur; hiçbir kayıt otomatik oluşturulmaz, eliminasyon elle girilir.
 */
export async function intercompanyHints(app: FastifyInstance, ctx: AuthCtx, groupId: string, asOf: string): Promise<{ hints: IntercompanyHint[]; excluded: ExcludedMember[]; note: string }> {
  const access = await resolveGroupAccess(app, ctx, groupId);
  const byTax = new Map<string, { id: string; name: string }>();
  for (const s of access.scopes) {
    const t = norm(s.taxNumber);
    if (t) byTax.set(t, { id: s.companyId, name: s.name });
  }
  const hints: IntercompanyHint[] = [];
  const results = await forEachScope(ctx.tx, access, async (scope) => {
    const taxes = [...byTax.keys()].filter((t) => byTax.get(t)!.id !== scope.companyId);
    if (taxes.length === 0) return [];
    const rows = await ctx.tx.execute<{ id: string; code: string; name: string; tax_number: string }>(sql`
      select id, code, name, tax_number from parties
       where tax_number is not null and upper(regexp_replace(tax_number, '[^0-9A-Za-z]', '', 'g')) in (${sql.join(taxes.map((t) => sql`${t}`), sql`, `)})
       order by name`);
    if (rows.rows.length === 0) return [];
    const rec = await allOpenItems(ctx.tx, 'receivable', asOf);
    const pay = await allOpenItems(ctx.tx, 'payable', asOf);
    return rows.rows.map((p) => ({
      party: p,
      receivable: toDbAmount(rec.filter((i) => i.partyId === p.id).reduce((s, i) => s.plus(i.remainingBase), dec(0))),
      payable: toDbAmount(pay.filter((i) => i.partyId === p.id).reduce((s, i) => s.plus(i.remainingBase), dec(0))),
    }));
  });
  for (const r of results) {
    for (const h of r.value) {
      hints.push({
        company: { id: r.scope.companyId, name: r.scope.name },
        party: { id: h.party.id, code: h.party.code, name: h.party.name, taxNumber: h.party.tax_number },
        matchedCompany: byTax.get(norm(h.party.tax_number))!,
        receivable: h.receivable,
        payable: h.payable,
        currency: r.scope.baseCurrency,
      });
    }
  }
  return { hints, excluded: access.excluded, note: 'Yalnızca ipucu: vergi numarası eşleşmesi. Eliminasyon elle girilir; yöntem doğrulanmadı (LEGAL-NOTES §22).' };
}
