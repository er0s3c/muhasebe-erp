import { and, asc, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { ConstructionParamKind, CreateConstructionParamInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { constructionParams } from '../../db/schema';
import { notFound } from '../../http/errors';

export async function listParams(tx: Tx) {
  return tx.select().from(constructionParams).orderBy(asc(constructionParams.kind), desc(constructionParams.validFrom));
}

export async function createParam(tx: Tx, companyId: string, input: CreateConstructionParamInput) {
  const [row] = await tx
    .insert(constructionParams)
    .values({
      companyId,
      kind: input.kind,
      value: input.value,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      sourceNote: input.sourceNote ?? null,
    })
    .returning();
  return row!;
}

export async function verifyParam(tx: Tx, id: string, verifiedBy: string, sourceNote?: string) {
  const [row] = await tx
    .update(constructionParams)
    .set({ verifiedBy, verifiedAt: new Date(), ...(sourceNote ? { sourceNote } : {}) })
    .where(eq(constructionParams.id, id))
    .returning();
  if (!row) throw notFound('İnşaat parametresi');
  return row;
}

export async function deleteParam(tx: Tx, id: string) {
  const rows = await tx.delete(constructionParams).where(eq(constructionParams.id, id)).returning({ id: constructionParams.id });
  if (rows.length === 0) throw notFound('İnşaat parametresi');
}

/**
 * Tarihte geçerli parametre (en yeni başlangıç). Bulunamazsa null: çağıran 0 varsayar ya da hata verir.
 * `verified=false` olan değerler kullanılabilir ama ekranda "doğrulanmamış" rozetiyle gösterilir.
 */
export async function resolveParam(tx: Tx, kind: ConstructionParamKind, onDate: string) {
  const [row] = await tx
    .select()
    .from(constructionParams)
    .where(
      and(
        eq(constructionParams.kind, kind),
        lte(constructionParams.validFrom, onDate),
        or(isNull(constructionParams.validTo), gte(constructionParams.validTo, onDate)),
      ),
    )
    .orderBy(desc(constructionParams.validFrom))
    .limit(1);
  return row ? { value: row.value, verified: row.verifiedAt !== null, id: row.id } : null;
}
