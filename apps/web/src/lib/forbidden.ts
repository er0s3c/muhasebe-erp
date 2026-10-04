import { useSyncExternalStore } from 'react';

/**
 * Sorgu düzeyinde genel 403 işleyişi (UI-7): rota izin kapısından geçen bir sayfanın yan sorgularından biri 403
 * dönerse (rolün o veriye izni yoksa) sayfa sessizce "kayıt yok" göstermesin; kabuk, o sayfa için bir uyarı gösterir.
 * Bilerek izinsiz olabilen sorgular `meta: { allowForbidden: true }` ile bu uyarıdan çıkarılır.
 */
let forbiddenPath: string | null = null;
const listeners = new Set<() => void>();

export function reportForbidden() {
  const path = window.location.pathname;
  if (forbiddenPath === path) return;
  forbiddenPath = path;
  listeners.forEach((l) => l());
}

/** Başka sayfaya geçince uyarı sıfırlanır. */
export function clearForbidden(except: string) {
  if (forbiddenPath === null || forbiddenPath === except) return;
  forbiddenPath = null;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Verilen yolda 403 alan bir sorgu oldu mu. */
export function useForbiddenOn(pathname: string): boolean {
  return useSyncExternalStore(subscribe, () => forbiddenPath === pathname);
}
