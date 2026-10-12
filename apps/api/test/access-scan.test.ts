import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Kullanıcı bazlı modül erişiminin YAPISAL koruması: rol şablonuna (ROLE_PERMISSIONS) doğrudan bakmak, istek bağlamındaki etkin izin
 * kümesini atlatır ve bir kullanıcının kısıtını yok sayar. Bu tarama, kaynakta rol şablonuna yalnızca izinli dosyaların baktığını,
 * `hasPermission`ın bir rol değil izin KÜMESİ aldığını doğrular. Yeni bir izin denetimi `c.can/c.require` ya da
 * `hasPermission(access.permissions, …)` ile yazılmalıdır.
 */
const ROOT = join(__dirname, '..', '..', '..');
const SRC_DIRS = ['apps/api/src', 'apps/web/src', 'packages/shared/src'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = SRC_DIRS.flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: relative(ROOT, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }));

const usersOf = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.path).sort();

describe('izin denetimi merkezîdir (yapısal tarama)', () => {
  it('ROLE_PERMISSIONS yalnızca paylaşılan izin/erişim tanımlarında kullanılır', () => {
    expect(usersOf(/\bROLE_PERMISSIONS\b/)).toEqual(['packages/shared/src/module-access.ts', 'packages/shared/src/permissions.ts']);
  });

  it('rol varsayılanı yardımcıları yalnızca merkezi erişim kodunda (ipucu/rol adımı doğrulaması) kullanılır', () => {
    expect(usersOf(/\broleHasDefault\b/)).toEqual(['packages/shared/src/permissions.ts', 'apps/api/src/modules/access/effective.ts'].sort());
    expect(usersOf(/\broleDefaultPermissions\b/)).toEqual(
      ['apps/api/src/modules/access/company-roles.ts', 'apps/api/src/modules/access/routes.ts', 'apps/api/src/modules/approvals/service.ts', 'packages/shared/src/module-access.ts'].sort(),
    );
  });

  it('etkin izin kümesi yalnızca merkezi yerlerde ve bağlamı kuran kodlarda hesaplanır (effectivePermissions)', () => {
    expect(usersOf(/\beffectivePermissions\(/)).toEqual(['apps/api/src/modules/access/effective.ts', 'packages/shared/src/module-access.ts'].sort());
  });

  it('hasPermission bir rol değil izin kümesi alır; kaynakta `hasPermission(role…)` yoktur', () => {
    const bad = files.filter((f) => /\bhasPermission\(\s*(?:[\w.]*\.)?role\b/.test(f.text)).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('web izin kararını sunucunun etkin izin listesinden (navigation.permissions) verir; rol tablosunu bilmez', () => {
    const web = files.filter((f) => f.path.startsWith('apps/web/'));
    expect(web.filter((f) => /ROLE_PERMISSIONS|roleHasDefault|roleDefaultPermissions|effectivePermissions/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('API kodunda yetki kararı için doğrudan rol dizgesi karşılaştırması yoktur (yalnızca üyelik yönetimi ve erişim kuralları)', () => {
    const allow = new Set([
      'apps/api/src/modules/tenancy/members.ts',
      'apps/api/src/modules/access/company-roles.ts', // owner role assignment is membership management
      'apps/api/src/modules/tenancy/branches.ts', // owner branch scope cannot be restricted
      'apps/api/src/modules/tenancy/service.ts',
      'apps/api/src/modules/access/routes.ts',
      'apps/api/src/modules/access/effective.ts',
      'apps/api/src/modules/approvals/service.ts', // rol adımı: etkin izinle birlikte sınanır
      'apps/api/src/licensing/device-routes.ts',
      'apps/api/src/licensing/installation.ts',
      'apps/api/src/db/schema.ts',
      'apps/api/src/db/demo.ts',
    ]);
    const hits = files
      .filter((f) => f.path.startsWith('apps/api/src/') && !allow.has(f.path))
      .filter((f) => /\b(?:role|callerRole)\s*[!=]==\s*'(?:owner|admin|accountant|sales|site_manager|viewer)'/.test(f.text))
      .map((f) => f.path);
    expect(hits).toEqual([]);
  });
});
