import { asc, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_COST_CODES,
  type CreateCostCodeInput,
  type UpdateCostCodeInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { costCodes } from '../../db/schema';
import { conflict, notFound } from '../../http/errors';

/** Yeni şirkete varsayılan maliyet kodlarını yazar (mevcut şirketler için migration 0026). */
export async function seedCostCodes(tx: Tx, companyId: string): Promise<void> {
  await tx.insert(costCodes).values(DEFAULT_COST_CODES.map((c) => ({ companyId, ...c }))).onConflictDoNothing();
}

export async function listCostCodes(tx: Tx) {
  return tx.select().from(costCodes).orderBy(asc(costCodes.code));
}

export async function createCostCode(tx: Tx, companyId: string, input: CreateCostCodeInput) {
  const [dup] = await tx.select({ id: costCodes.id }).from(costCodes).where(eq(sql`lower(${costCodes.code})`, input.code.toLowerCase()));
  if (dup) throw conflict(`${input.code} maliyet kodu zaten var`, 'COST_CODE_EXISTS');
  const [row] = await tx.insert(costCodes).values({ companyId, ...input }).returning();
  return row!;
}

export async function updateCostCode(tx: Tx, id: string, input: UpdateCostCodeInput) {
  const [row] = await tx.update(costCodes).set(input).where(eq(costCodes.id, id)).returning();
  if (!row) throw notFound('Maliyet kodu');
  return row;
}

/** Hareket görmüş kod silinemez (yabancı anahtar); pasifleştirilir. */
export async function deleteCostCode(tx: Tx, id: string) {
  const used = await tx.execute<{ n: number }>(sql`select count(*)::int as n from journal_lines where cost_code_id = ${id}`);
  if ((used.rows[0]?.n ?? 0) > 0) throw conflict('Bu maliyet kodunda kayıt var; silinemez, pasifleştirin', 'COST_CODE_HAS_POSTINGS');
  const [row] = await tx.delete(costCodes).where(eq(costCodes.id, id)).returning({ id: costCodes.id });
  if (!row) throw notFound('Maliyet kodu');
}
