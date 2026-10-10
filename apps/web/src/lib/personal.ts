import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useCMutation, useCQuery } from './queries';
import { useCompany, useSession } from './session';

/**
 * Kişisel arayüz tercihleri: favoriler, pano düzeni, tablo yoğunluğu. Sunucuda kullanıcı + şirket kapsamında saklanır
 * (cihazlar arası aynı görünür); iş verisi taşımaz. Son ziyaretler ise yalnız bu tarayıcıda tutulur.
 */
export type PreferenceKey = 'favorites' | 'dashboard.layout' | 'table.density';
type Preferences = Partial<Record<PreferenceKey, unknown>>;
const PREF_KEY = ['me', 'preferences'] as const;

export function usePreferences() {
  return useCQuery<{ preferences: Preferences }>([...PREF_KEY], '/api/me/preferences', { staleTime: 5 * 60_000 });
}

export function usePreference<T>(key: PreferenceKey, parse: (value: unknown) => T | null, fallback: T) {
  const { data, isLoading } = usePreferences();
  const company = useCompany();
  const qc = useQueryClient();
  const raw = data?.preferences?.[key];
  const value = raw === undefined ? fallback : (parse(raw) ?? fallback);
  const mutation = useCMutation<{ value: unknown }, T>((next, call) =>
    call(`/api/me/preferences/${encodeURIComponent(key)}`, { method: 'PUT', body: { value: next } }),
  );
  const save = useCallback(
    async (next: T) => {
      // İyimser güncelleme: yıldız/düzen anında değişir; hata olursa önceki değere dönülür
      const queryKey = [company.id, ...PREF_KEY];
      const snapshots = qc.getQueriesData<{ preferences: Preferences }>({ queryKey });
      qc.setQueriesData<{ preferences: Preferences }>({ queryKey }, old => ({ preferences: { ...old?.preferences, [key]: next } }));
      try {
        await mutation.mutateAsync(next);
      } catch (error) {
        for (const [k, v] of snapshots) qc.setQueryData(k, v);
        throw error;
      }
    },
    [company.id, key, mutation, qc],
  );
  return { value, save, loading: isLoading, saving: mutation.isPending };
}

// ---- Favoriler ----

export interface FavoriteItem {
  path: string;
  title: string;
}
export const FAVORITES_MAX = 20;

export function parseFavorites(value: unknown): FavoriteItem[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((v): v is FavoriteItem => !!v && typeof v.path === 'string' && v.path.startsWith('/') && typeof v.title === 'string')
    .slice(0, FAVORITES_MAX)
    .map(v => ({ path: v.path.slice(0, 300), title: v.title.slice(0, 80) }));
}

export function useFavorites() {
  const pref = usePreference<FavoriteItem[]>('favorites', parseFavorites, []);
  const isFavorite = (path: string) => pref.value.some(f => f.path === path);
  const toggle = (item: FavoriteItem) =>
    pref.save(
      isFavorite(item.path)
        ? pref.value.filter(f => f.path !== item.path)
        : [...pref.value, item].slice(-FAVORITES_MAX),
    );
  const move = (path: string, delta: -1 | 1) => {
    const list = [...pref.value];
    const from = list.findIndex(f => f.path === path);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return Promise.resolve();
    [list[from], list[to]] = [list[to]!, list[from]!];
    return pref.save(list);
  };
  const reorder = (paths: string[]) => {
    const byPath = new Map(pref.value.map(f => [f.path, f]));
    return pref.save(paths.flatMap(p => (byPath.has(p) ? [byPath.get(p)!] : [])));
  };
  return { favorites: pref.value, isFavorite, toggle, move, reorder, loading: pref.loading };
}

// ---- Son ziyaretler (yalnız bu tarayıcı) ----

export interface RecentItem {
  path: string;
  title: string;
  /** Kayıt türü: "Fatura", "Cari" ... */
  kind?: string;
  at: number;
}
const RECENT_MAX = 15;
const RECENT_EVENT = 'ada-recent-changed';
const recentKey = (userId: string, companyId: string) => `ada:recent:v1:${userId}:${companyId}`;

export function readRecent(key: string): RecentItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is RecentItem => !!v && typeof v.path === 'string' && typeof v.title === 'string' && typeof v.at === 'number')
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function pushRecent(key: string, item: Omit<RecentItem, 'at'>, now = Date.now()) {
  const next = [{ ...item, title: item.title.slice(0, 80), at: now }, ...readRecent(key).filter(r => r.path !== item.path)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* Depolama kapalıysa son ziyaretler tutulmaz; uygulama etkilenmez. */
  }
  window.dispatchEvent(new Event(RECENT_EVENT));
  return next;
}

function useRecentKey() {
  const { user } = useSession();
  const company = useCompany();
  return user ? recentKey(user.id, company.id) : null;
}

const cache = new Map<string, { raw: string | null; items: RecentItem[] }>();
function snapshot(key: string | null): RecentItem[] {
  if (!key) return EMPTY;
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return EMPTY;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.items;
  const items = readRecent(key);
  cache.set(key, { raw, items });
  return items;
}
const EMPTY: RecentItem[] = [];

export function useRecentItems(): RecentItem[] {
  const key = useRecentKey();
  return useSyncExternalStore(
    onChange => {
      window.addEventListener(RECENT_EVENT, onChange);
      window.addEventListener('storage', onChange);
      return () => {
        window.removeEventListener(RECENT_EVENT, onChange);
        window.removeEventListener('storage', onChange);
      };
    },
    () => snapshot(key),
    () => EMPTY,
  );
}

/** Kayıt/detay ekranı açıldığında son ziyaretlere yazar (başlık yüklenene dek `null` verilir). */
export function useRecordRecent(item: Omit<RecentItem, 'at'> | null | undefined) {
  const key = useRecentKey();
  const path = item?.path;
  const title = item?.title;
  const kind = item?.kind;
  useEffect(() => {
    if (!key || !path || !title) return;
    pushRecent(key, { path, title, ...(kind ? { kind } : {}) });
  }, [key, path, title, kind]);
}

// ---- Tablo yoğunluğu ----

export type TableDensity = 'comfortable' | 'compact';
export function useTableDensity() {
  return usePreference<TableDensity>('table.density', v => (v === 'compact' || v === 'comfortable' ? v : null), 'comfortable');
}
