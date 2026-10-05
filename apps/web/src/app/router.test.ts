import { describe, expect, it } from 'vitest';
import type { RouteObject } from 'react-router-dom';
import { NAV_ITEMS, PERMISSIONS } from '@erp/shared';
import { router } from './router';
import type { RouteHandle } from './guards';

/** Uygulama kabuğu altındaki tüm sayfa rotaları: tam yol -> izin (handle). */
function collect(routes: readonly RouteObject[], base = ''): Map<string, RouteHandle | undefined> {
  const out = new Map<string, RouteHandle | undefined>();
  for (const r of routes) {
    const path = r.index ? base || '/' : r.path ? (r.path.startsWith('/') ? r.path : `${base.replace(/\/$/, '')}/${r.path}`) : base;
    if (r.lazy) out.set(path, r.handle as RouteHandle | undefined);
    if (r.children) for (const [k, v] of collect(r.children, path)) out.set(k, v);
  }
  return out;
}

describe('rota izinleri (UI-7)', () => {
  const pages = collect(router.routes);

  it('her tembel sayfa rotası izin bilgisini açıkça taşır ve izin gerçek bir izindir', () => {
    expect(pages.size).toBeGreaterThan(100);
    for (const [path, handle] of pages) {
      expect(handle, path).toBeDefined();
      if (handle!.permission !== null) expect(PERMISSIONS, path).toContain(handle!.permission);
    }
  });

  it('menüdeki her sayfanın rota izni menü izniyle aynı (menüde görünen sayfa yetki ekranı vermez)', () => {
    for (const item of NAV_ITEMS) {
      const pathname = item.path.split('?')[0]!;
      expect(pages.has(pathname), item.path).toBe(true);
      const pagePermission = pages.get(pathname)!.permission;
      if (item.path.includes('?')) {
        // Parametreli rotalar (örn. /workspace/operations?kind=...) genel sayfayı paylaşır; sayfa bileşeni kendi içinde izin kapısını işletir
        expect(pagePermission === null || pagePermission === item.permission, item.path).toBe(true);
        continue;
      }
      expect(pagePermission, item.path).toBe(item.permission ?? null);
    }
  });

  it('ayrıntı rotaları listesinin okuma iznini (ya da daha dar bir izni) ister', () => {
    for (const [path, handle] of pages) {
      if (!path.includes('/:')) continue;
      const list = path.replace(/\/:.*$/, '');
      const nav = NAV_ITEMS.find((n) => n.path === list);
      if (nav?.permission) expect(handle!.permission, path).toBe(nav.permission);
    }
  });
});
