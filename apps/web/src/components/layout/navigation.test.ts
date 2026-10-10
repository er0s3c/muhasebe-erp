import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, NAV_ITEMS } from '@erp/shared';
import { buildDisplayNavigation, findActiveNavigation, isPosFocusPath, navigationDestination } from './navigation';

const source = NAV_GROUPS.map(group => ({
  ...group,
  items: NAV_ITEMS.filter(item => item.group === group.key),
}));

describe('permission-filtered navigation presentation', () => {
  it('keeps every existing destination once and leaves the input unchanged', () => {
    const original = JSON.stringify(source);
    const groups = buildDisplayNavigation(source);
    const paths = groups.flatMap(group => group.items.map(item => navigationDestination(item.path)));
    expect(new Set(paths)).toEqual(new Set(NAV_ITEMS.map(item => navigationDestination(item.path))));
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
    expect(groups[0]?.items.map(item => item.label)).toEqual(['Kanal bağlantıları', 'API ve webhook']);
    expect(buildDisplayNavigation([])).toEqual([]);
  });

  it('keeps different operations and chooses the deepest current destination', () => {
    const groups = buildDisplayNavigation(source);
    expect(findActiveNavigation(groups, '/workspace/operations', '?kind=collection')?.item.key).toBe('collection-work');
    expect(findActiveNavigation(groups, '/workspace/operations', '?kind=site_report')?.item.key).toBe('site-operations');
    expect(findActiveNavigation(groups, '/leather/models', '')?.item.key).toBe('leather-models');
    expect(findActiveNavigation(groups, '/parties/abc', '')?.item.key).toBe('parties');
    expect(navigationDestination('/workspace/operations?projectId=1&kind=rfi')).toBe(navigationDestination('/workspace/operations?kind=rfi&projectId=1'));
    expect(navigationDestination('/workspace/operations?kind=rfi')).not.toBe(navigationDestination('/workspace/operations?kind=collection'));
  });

  it('focuses only the live POS sale screen', () => {
    expect(isPosFocusPath('/pos')).toBe(true);
    for (const path of ['/pos/settings', '/pos/sessions', '/pos/sales/123', '/pos-other']) expect(isPosFocusPath(path)).toBe(false);
  });
});
