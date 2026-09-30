import { sql } from 'drizzle-orm';
import type { Db } from './client';

export interface PreflightIssue {
  code: 'ROLE_SUPERUSER' | 'ROLE_BYPASSRLS' | 'ROLE_OWNS_TABLES' | 'TABLE_WITHOUT_RLS';
  message: string;
}

/**
 * Kiracı yalıtımı yalnızca çalışma zamanı rolünün RLS'e tabi olmasına dayanır. Yanlışlıkla sahip rolü
 * (`erp`) ya da bir süper kullanıcı bağlantısı verilirse RLS sessizce devre dışı kalır ve bir kiracı
 * ötekinin verisini görür. Bu denetim açılışta bunu yakalar.
 */
export async function checkRuntimeRole(db: Db): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];

  const role = await db.execute<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
  );
  const me = role.rows[0];
  if (me?.rolsuper) {
    issues.push({ code: 'ROLE_SUPERUSER', message: `'${me.rolname}' rolü süper kullanıcı; RLS uygulanmaz` });
  }
  if (me?.rolbypassrls) {
    issues.push({ code: 'ROLE_BYPASSRLS', message: `'${me.rolname}' rolü BYPASSRLS; RLS uygulanmaz` });
  }

  const owned = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and pg_get_userbyid(c.relowner) = current_user`);
  if ((owned.rows[0]?.n ?? 0) > 0) {
    issues.push({
      code: 'ROLE_OWNS_TABLES',
      message: `'${me?.rolname}' rolü tabloların sahibi; sahipler RLS'i atlar. DATABASE_URL şema sahibi değil çalışma zamanı rolünü (erp_app) göstermeli`,
    });
  }

  const unprotected = await db.execute<{ relname: string }>(sql`
    select c.relname from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity
    order by c.relname`);
  for (const r of unprotected.rows) {
    issues.push({ code: 'TABLE_WITHOUT_RLS', message: `'${r.relname}' tablosunda company_id var ama RLS kapalı` });
  }

  return issues;
}
