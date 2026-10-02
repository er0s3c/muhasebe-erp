import { and, asc, desc, eq } from 'drizzle-orm';
import { resolveDatedParam, type CreateForeignParamInput, type ForeignParamKey } from '@erp/shared';
import type { Tx } from '../../db/client';
import { foreignWorkerParams, users } from '../../db/schema';
import { conflict, notFound } from '../../http/errors';

export interface ForeignCtx {
  companyId: string;
  userId: string;
  /** Şifreleme anahtarı kaynağı (JWT_SECRET). */
  secret: string;
}

/**
 * Yabancı işçi parametreleri (D5): tarihli, kaynak notlu, doğrulama alanlı, varsayılan KAPALI. Kodda/tohumda değer yoktur;
 * parametre yoksa ya da en yeni satır kapalıysa ilgili hesap/kayıt yapılmaz.
 */
export async function listParams(tx: Tx) {
  return tx.select().from(foreignWorkerParams).orderBy(asc(foreignWorkerParams.key), desc(foreignWorkerParams.effectiveFrom));
}

export async function createParam(tx: Tx, ctx: ForeignCtx, input: CreateForeignParamInput) {
  const [dup] = await tx
    .select({ id: foreignWorkerParams.id })
    .from(foreignWorkerParams)
    .where(and(eq(foreignWorkerParams.key, input.key), eq(foreignWorkerParams.effectiveFrom, input.effectiveFrom)));
  if (dup) throw conflict('Bu parametre için aynı başlangıç tarihli bir satır var', 'FOREIGN_PARAM_EXISTS');
  const [row] = await tx
    .insert(foreignWorkerParams)
    .values({
      companyId: ctx.companyId,
      key: input.key,
      value: input.value,
      currency: input.key === 'guarantee_amount' ? (input.currency ?? null) : null,
      effectiveFrom: input.effectiveFrom,
      enabled: input.enabled,
      sourceNote: input.sourceNote?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning();
  return row!;
}

/** Açma/kapama ve kaynak notu. Kaynak notu değişirse doğrulama sıfırlanır. */
export async function updateParam(tx: Tx, id: string, input: { enabled?: boolean; sourceNote?: string | null }) {
  const [cur] = await tx.select().from(foreignWorkerParams).where(eq(foreignWorkerParams.id, id)).for('update');
  if (!cur) throw notFound('Parametre');
  const noteChanged = input.sourceNote !== undefined && (input.sourceNote?.trim() || null) !== (cur.sourceNote ?? null);
  const [row] = await tx
    .update(foreignWorkerParams)
    .set({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.sourceNote !== undefined ? { sourceNote: input.sourceNote?.trim() || null } : {}),
      ...(noteChanged ? { verifiedBy: null, verifiedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(foreignWorkerParams.id, id))
    .returning();
  return row!;
}

export async function verifyParam(tx: Tx, id: string, userId: string, note: string | null | undefined) {
  const [u] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const [row] = await tx
    .update(foreignWorkerParams)
    .set({ verifiedBy: u?.email ?? userId, verifiedAt: new Date(), ...(note ? { sourceNote: note } : {}), updatedAt: new Date() })
    .where(eq(foreignWorkerParams.id, id))
    .returning();
  if (!row) throw notFound('Parametre');
  return row;
}

export async function deleteParam(tx: Tx, id: string) {
  const rows = await tx.delete(foreignWorkerParams).where(eq(foreignWorkerParams.id, id)).returning({ id: foreignWorkerParams.id });
  if (rows.length === 0) throw notFound('Parametre');
}

/** Belirli gün için geçerli (en yeni, açık) parametre satırı; yoksa null. */
export async function resolveParamAt(tx: Tx, key: ForeignParamKey, onDate: string) {
  const rows = await tx.select().from(foreignWorkerParams).where(eq(foreignWorkerParams.key, key));
  return resolveDatedParam(rows, key, onDate);
}

/** Uyarı günü: tanımsız/kapalıysa configured=false (dolmak üzere durumu üretilmez). */
export async function warningAt(tx: Tx, onDate: string) {
  const p = await resolveParamAt(tx, 'expiry_warning_days', onDate);
  return { days: p ? Number(p.value) : null, configured: !!p, verified: !!p?.verifiedAt, paramId: p?.id ?? null };
}
