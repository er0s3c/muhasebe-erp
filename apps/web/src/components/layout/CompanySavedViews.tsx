import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../lib/session';
import { useActiveBranch } from '../../lib/branch';
import { useCMutation, useCQuery } from '../../lib/queries';
import { errorMessage } from '../../lib/errors';
import { readSavedViews, sanitizeViewFilters, SavedViews, savedViewsKey, type SavedViewItem, type ViewFilters } from '../ui/SavedViews';

const BRANCH_SCOPE = /^(all|unassigned|[0-9a-f-]{36})$/;

/**
 * Sunucuda saklanan kayıtlı görünümler (öneri 5): kullanıcı, şirket, şube seçimi ve ekran kapsamında; başka cihazda da açılır,
 * ekiple paylaşılabilir. Eski sürümün bu tarayıcıda tuttuğu görünümler ilk açılışta bir kez sunucuya taşınır.
 */
export function CompanySavedViews({ page, filters, onApply }: { page: string; filters: ViewFilters; onApply: (filters: ViewFilters) => void }) {
  const { user, activeCompany } = useSession();
  const activeBranch = useActiveBranch(activeCompany?.id ?? 'none');
  const branchScope = BRANCH_SCOPE.test(activeBranch) ? activeBranch : 'all';
  const ready = Boolean(user && activeCompany);
  const queryKey = ['saved-views', page, branchScope];
  const query = useCQuery<{ views: SavedViewItem[] }>(queryKey, ready ? `/api/saved-views?page=${encodeURIComponent(page)}&branchScope=${encodeURIComponent(branchScope)}` : null);
  const create = useCMutation((body: { name: string; filters: ViewFilters; shared: boolean }, call) =>
    call('/api/saved-views', { method: 'POST', body: { page, branchScope, ...body } }), [['saved-views', page]]);
  const update = useCMutation((v: { id: string; shared: boolean }, call) =>
    call(`/api/saved-views/${v.id}`, { method: 'PATCH', body: { shared: v.shared } }), [['saved-views', page]]);
  const remove = useCMutation((id: string, call) => call(`/api/saved-views/${id}`, { method: 'DELETE' }), [['saved-views', page]]);
  const [error, setError] = useState<string>();

  // Ekranın bugünkü filtre alanlarına uymayan görünüm (alan adı/türü değişmiş) listede gösterilmez
  const template = JSON.stringify(Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, typeof v])));
  const views = useMemo(() => (query.data?.views ?? []).flatMap((view) => {
    const safe = sanitizeViewFilters(view.filters, filters);
    return safe ? [{ ...view, filters: safe }] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [query.data, template]);

  // Bir kerelik taşıma: yalnız sunucu listesi geldikten sonra; başarısız olursa yerel görünümler korunur
  const migrated = useRef('');
  const scopeKey = user && activeCompany ? savedViewsKey([user.id, activeCompany.id, activeBranch, page]) : '';
  useEffect(() => {
    if (!scopeKey || !query.data || migrated.current === scopeKey) return;
    migrated.current = scopeKey;
    const local = readSavedViews(scopeKey, filters);
    if (!local.length) return;
    const existing = new Set(query.data.views.filter((view) => view.mine).map((view) => view.name));
    void (async () => {
      try {
        for (const view of local.filter((v) => !existing.has(v.name))) await create.mutateAsync({ name: view.name, filters: view.filters, shared: false });
        localStorage.removeItem(scopeKey);
      } catch { /* taşınamayan görünüm yerelde kalır; sonraki açılışta yeniden denenir */ migrated.current = ''; }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, query.data]);

  if (!ready) return null;
  return <SavedViews
    views={views}
    onApply={onApply}
    busy={create.isPending}
    error={error}
    onSave={async (name, shared) => {
      setError(undefined);
      try { await create.mutateAsync({ name, filters, shared }); return true; }
      catch (e) { setError(errorMessage(e)); return false; }
    }}
    onShare={(id, shared) => update.mutate({ id, shared }, { onError: (e) => setError(errorMessage(e)) })}
    onRemove={(id) => remove.mutate(id, { onError: (e) => setError(errorMessage(e)) })}
  />;
}
