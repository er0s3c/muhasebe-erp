import { matchRoutes, type RouteObject } from 'react-router-dom';

const done = new Set<string>();

/**
 * Menü bağlantısının üzerine gelindiğinde/odaklanıldığında hedef sayfanın kod parçasını önceden indirir.
 * Router kendi `lazy` çağrısını yine yapar; modül tarayıcı önbelleğinde olduğundan geçiş anında olur.
 */
export function preloadRoute(path: string) {
  const pathname = path.split('?')[0]!;
  if (done.has(pathname)) return;
  done.add(pathname);
  // Döngüsel import olmasın diye router çalışma anında alınır (zaten yüklüdür).
  void import('../app/router')
    .then(({ router }) => {
      const matches = matchRoutes(router.routes as RouteObject[], pathname) ?? [];
      for (const match of matches) {
        const lazy = match.route.lazy;
        if (typeof lazy === 'function') void (lazy as () => Promise<unknown>)().catch(() => done.delete(pathname));
      }
    })
    .catch(() => done.delete(pathname));
}
