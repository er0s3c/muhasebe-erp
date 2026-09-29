import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { accountTypeForCode, type CreateAccountInput, type UpdateAccountInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { accounts, journalLines } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { CHART_TEMPLATE } from './chart-template';

/**
 * Cari kontrol hesapları: bu hesaplara atılan her satır bir cariye bağlanmalıdır.
 * Alt hesaplar (120.001…) üst hesabın türünü devralır.
 */
const PARTY_CONTROL_CODES: Record<string, 'receivable' | 'payable'> = {
  '120': 'receivable',
  '320': 'payable',
};

export async function seedChartOfAccounts(tx: Tx, companyId: string): Promise<void> {
  const ids = new Map<string, string>(CHART_TEMPLATE.map((r) => [r.code, uuidv7()]));
  await tx.insert(accounts).values(
    CHART_TEMPLATE.map((r) => ({
      id: ids.get(r.code)!,
      companyId,
      code: r.code,
      name: r.name,
      type: accountTypeForCode(r.code),
      parentId: r.parentCode ? ids.get(r.parentCode)! : null,
      isPostable: r.isPostable,
      partyControl: PARTY_CONTROL_CODES[r.code] ?? null,
    })),
  );
}

export async function listAccounts(tx: Tx) {
  return tx.select().from(accounts).orderBy(asc(accounts.code));
}

/** "120.001" -> "120"; "120" -> "12"; "12" -> "1"; "1" -> null */
export function parentCodeOf(code: string): string | null {
  const dot = code.lastIndexOf('.');
  if (dot >= 0) return code.slice(0, dot);
  return code.length > 1 ? code.slice(0, code.length === 3 ? 2 : 1) : null;
}

export async function createAccount(tx: Tx, companyId: string, input: CreateAccountInput) {
  const parentCode = parentCodeOf(input.code);
  let parent: typeof accounts.$inferSelect | undefined;
  if (parentCode) {
    [parent] = await tx.select().from(accounts).where(eq(accounts.code, parentCode));
    if (!parent) {
      throw unprocessable(`Üst hesap bulunamadı: ${parentCode}`, 'PARENT_ACCOUNT_MISSING');
    }
    // Hareket görmüş hesabın altına alt hesap açılamaz: eski hareketler üst hesapta kalır.
    if (parent.isPostable) {
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(journalLines)
        .where(eq(journalLines.accountId, parent.id));
      if (used && used.n > 0) {
        throw unprocessable(
          `${parent.code} hesabında hareket var; alt hesap açılamaz`,
          'PARENT_ACCOUNT_HAS_MOVEMENTS',
        );
      }
    }
  }

  const [existing] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, input.code));
  if (existing) throw conflict(`${input.code} kodlu hesap zaten var`, 'ACCOUNT_CODE_TAKEN');

  const [created] = await tx
    .insert(accounts)
    .values({
      companyId,
      code: input.code,
      name: input.name,
      type: accountTypeForCode(input.code),
      parentId: parent?.id ?? null,
      currencyCode: input.currencyCode ?? parent?.currencyCode ?? null,
      partyControl: parent?.partyControl ?? null,
      isPostable: true,
    })
    .returning();

  if (parent?.isPostable) {
    await tx.update(accounts).set({ isPostable: false }).where(eq(accounts.id, parent.id));
  }
  return created!;
}

export async function updateAccount(tx: Tx, id: string, input: UpdateAccountInput) {
  const [updated] = await tx
    .update(accounts)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    })
    .where(eq(accounts.id, id))
    .returning();
  if (!updated) throw notFound('Hesap');
  return updated;
}

export async function getAccount(tx: Tx, id: string) {
  const [account] = await tx.select().from(accounts).where(and(eq(accounts.id, id)));
  if (!account) throw notFound('Hesap');
  return account;
}
