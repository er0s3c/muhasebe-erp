import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Queryable, Tx } from '../db/client';
import { companies, memberships } from '../db/schema';
import type { AuthUser } from '../http/context';

/**
 * Kurulumun sahibi olan kuruluş (lisans, güncelleme ve cihaz yönetimi bu kuruluşa aittir). `license_state.owner_org_id`
 * ilk şirket kurulurken (ya da lisans etkinleştirilirken) sabitlenir; sabitlenmemişse en eski şirketin kuruluşudur.
 * Kuruluş bazlı RLS'i aşan, yalnızca kimlik döndüren SECURITY DEFINER işlevden okunur (0080 migration'ı).
 */
export async function installationOwnerOrgId(db: Queryable): Promise<string | null> {
  const res = await db.execute<{ id: string | null }>(sql`select installation_owner_org() as id`);
  return res.rows[0]?.id ?? null;
}

/** Sahip kuruluş henüz sabitlenmemişse şimdiki değeri (en eski şirketin kuruluşu) sabitler. */
export async function pinInstallationOwner(db: Queryable): Promise<void> {
  await db.execute(sql`select claim_installation_owner()`);
}

/**
 * Kurulum yöneticisi: kurulumun sahibi kuruluşun bir şirketinde verilen rollerden birine sahip kullanıcı.
 * Başka bir kuruluşun (ör. açık kayıtla gelen) şirket sahibi kurulum yöneticisi SAYILMAZ.
 */
export async function isInstallationAdmin(
  tx: Tx,
  user: Pick<AuthUser, 'id' | 'orgId'>,
  roles: readonly string[] = ['owner'],
): Promise<boolean> {
  const owner = await installationOwnerOrgId(tx);
  if (!owner || owner !== user.orgId) return false;
  const [row] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(and(eq(memberships.userId, user.id), inArray(memberships.role, [...roles]), eq(companies.organizationId, owner)))
    .limit(1);
  return Boolean(row);
}
