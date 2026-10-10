import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, NAV_ITEMS } from '@erp/shared';
import { buildDisplayNavigation, findActiveNavigation, isPosFocusPath, NAV_MERGES, navigationDestination } from './navigation';

const mergedPath = (key: string, path: string) => NAV_MERGES.find(m => m.from.includes(key))?.path ?? path;

const source = NAV_GROUPS.map(group => ({
  ...group,
  items: NAV_ITEMS.filter(item => item.group === group.key),
}));

describe('permission-filtered navigation presentation', () => {
  it('keeps every existing destination once and leaves the input unchanged', () => {
    const original = JSON.stringify(source);
    const groups = buildDisplayNavigation(source);
    const paths = groups.flatMap(group => group.items.map(item => navigationDestination(item.path)));
    expect(new Set(paths)).toEqual(new Set(NAV_ITEMS.map(item => navigationDestination(mergedPath(item.key, item.path)))));
    expect(paths).toHaveLength(new Set(paths).size);
    expect(groups).toHaveLength(15);
    expect(JSON.stringify(source)).toBe(original);
    expect(groups[0]?.items.map(item => item.key)).toEqual(['dashboard', 'workspace', 'documents', 'notifications']);
  });

  it('moves alternate procurement modules into one group without inventing permissions', () => {
    for (const module of ['core.procurement', 'construction.procurement']) {
      const groups = buildDisplayNavigation(source.map(group => ({ ...group, items: group.items.filter(item => item.module === module) })));
      const procurement = groups.find(group => group.key === 'procurement');
      expect(procurement?.items.map(item => item.path)).toEqual(['/purchasing/requests', '/purchasing/rfqs', '/purchasing/orders', '/purchasing/matching', '/purchasing/replenishment']);
      expect(groups.find(group => group.key === 'reports')?.items[0]?.path).toBe('/reports/supplier-performance');
      expect(groups.flatMap(group => group.items).every(item => item.module === module)).toBe(true);
    }
  });

  it('does not create a manufacturing group from global integration links', () => {
    const groups = buildDisplayNavigation(source.map(group => ({ ...group, items: group.items.filter(item => item.module === 'core.integrations') })));
    expect(groups.map(group => group.key)).toEqual(['settings']);
    expect(groups[0]?.items.map(item => item.label)).toEqual(['Entegrasyonlar']);
    expect(buildDisplayNavigation([])).toEqual([]);
  });

  it('keeps different operations and chooses the deepest current destination', () => {
    const groups = buildDisplayNavigation(source);
    expect(findActiveNavigation(groups, '/workspace/operations', '')?.item.key).toBe('collection-work');
    expect(findActiveNavigation(groups, '/workspace/operations', '', 'site_report')?.item.key).toBe('site-operations');
    expect(findActiveNavigation(groups, '/workspace/operations', '?kind=collection')?.item.key).toBe('collection-work');
    expect(findActiveNavigation(groups, '/workspace/operations', '?kind=site_report')?.item.key).toBe('site-operations');
    expect(findActiveNavigation(groups, '/leather/models', '')?.item.key).toBe('leather-models');
    expect(findActiveNavigation(groups, '/parties/abc', '')?.item.key).toBe('parties');
    expect(navigationDestination('/workspace/operations?projectId=1&kind=rfi')).toBe(navigationDestination('/workspace/operations?kind=rfi&projectId=1'));
    expect(navigationDestination('/workspace/operations?kind=rfi')).not.toBe(navigationDestination('/workspace/operations?kind=collection'));
  });

  it('merges split settings/planning screens into one hub entry per topic', () => {
    const groups = buildDisplayNavigation(source);
    const all = groups.flatMap(group => group.items.map(item => ({ group: group.key, item })));
    for (const merge of NAV_MERGES) {
      const hits = all.filter(({ item }) => item.path === merge.path);
      expect(hits, merge.key).toHaveLength(1);
      expect(hits[0]).toMatchObject({ group: merge.group, item: { key: merge.key, label: merge.label } });
      for (const key of merge.from) expect(all.some(({ item }) => item.key === key)).toBe(false);
    }
    // Yalnız bir kaynağı görebilen kullanıcıya da birleşik öğe görünür (izin icat edilmez)
    const onlyForeign = buildDisplayNavigation(source.map(group => ({ ...group, items: group.items.filter(item => item.key === 'foreign-settings') })));
    expect(onlyForeign.flatMap(group => group.items.map(item => item.path))).toEqual(['/hr/settings']);
    expect(findActiveNavigation(groups, '/hr/settings', '?tab=social')?.item.key).toBe('hr-settings');
  });

  it('focuses only the live POS sale screen', () => {
    expect(isPosFocusPath('/pos')).toBe(true);
    for (const path of ['/pos/settings', '/pos/sessions', '/pos/sales/123', '/pos-other']) expect(isPosFocusPath(path)).toBe(false);
  });
});
