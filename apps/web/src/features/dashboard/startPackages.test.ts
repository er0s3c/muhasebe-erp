import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_STARTS, SECTORS, SECTOR_PACKAGES } from '@erp/shared';
import { WIDGET_BY_ID } from './widgets';

describe('başlangıç paketleri (öneri 1, 2)', () => {
  it('her rolün panosu yalnız tanımlı kartları içerir ve Başlangıç kartıyla açılır; her sektörün paketi var', () => {
    for (const role of ROLES) {
      const widgets = ROLE_STARTS[role].widgets;
      expect(widgets[0], role).toBe('start');
      for (const id of widgets) expect(WIDGET_BY_ID.has(id), `${role}: ${id}`).toBe(true);
      expect(new Set(widgets).size, role).toBe(widgets.length);
    }
    for (const sector of SECTORS) expect(SECTOR_PACKAGES[sector].tasks.length, sector).toBeGreaterThan(0);
  });
});
