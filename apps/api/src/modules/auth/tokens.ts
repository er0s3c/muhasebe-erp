import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { userTokens } from '../../db/schema';

export type TokenPurpose = 'verify_email' | 'reset_password';
export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  reset_password: 60 * 60 * 1000,
  verify_email: 3 * 24 * 60 * 60 * 1000,
};

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Yeni bir bağlantı jetonu üretir (yalnızca özeti saklanır); aynı amaçlı önceki kullanılmamış jetonlar geçersiz olur. */
export async function issueUserToken(db: Queryable, userId: string, purpose: TokenPurpose, ip?: string): Promise<string> {
  await db
    .update(userTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(userTokens.userId, userId), eq(userTokens.purpose, purpose), isNull(userTokens.usedAt)));
  const token = randomBytes(32).toString('base64url');
  await db.insert(userTokens).values({
    userId,
    purpose,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]),
    ip: ip ?? null,
  });
  return token;
}

/**
 * Jetonu TEK KULLANIMLIK tüketir: kullanılmamış ve süresi dolmamışsa tek atomik güncellemeyle işaretler ve
 * kullanıcı kimliğini döndürür; aksi halde null (bilinmeyen, süresi dolmuş ve kullanılmış aynı görünür).
 */
export async function consumeUserToken(db: Queryable, token: string, purpose: TokenPurpose): Promise<string | null> {
  const rows = await db
    .update(userTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(userTokens.tokenHash, sha256(token)),
        eq(userTokens.purpose, purpose),
        isNull(userTokens.usedAt),
        sql`${userTokens.expiresAt} > now()`,
      ),
    )
    .returning({ userId: userTokens.userId });
  return rows[0]?.userId ?? null;
}
