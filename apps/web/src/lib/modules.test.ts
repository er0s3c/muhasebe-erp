import { describe, expect, it } from 'vitest';
import { MODULES } from '@erp/shared';
import tr from '../i18n/tr.json';
import { MODULE_LABEL_KEYS, moduleDescKey, moduleDescription, moduleName } from './modules';

const lookup = (key: string): unknown => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), tr);

describe('modül etiketleri (UI-5/UI-6)', () => {
  it('kayıttaki her modülün adı ve açıklaması tr.json içinde var', () => {
    for (const m of MODULES) {
      expect(MODULE_LABEL_KEYS[m.key], m.key).toBe(m.labelKey);
      expect(typeof lookup(m.labelKey), m.labelKey).toBe('string');
      const desc = moduleDescKey(m.key)!;
      expect(typeof lookup(desc), desc).toBe('string');
    }
  });

  it('ad ve açıklama ham anahtar değil, Türkçe metin döner', () => {
    for (const m of MODULES) {
      expect(moduleName(m.key)).not.toMatch(/^modules\./);
      expect(moduleDescription(m.key)).not.toBe('');
    }
    expect(moduleName('hr.payroll')).toBe('Bordro');
    expect(moduleName('yok.boyle')).toBe('yok.boyle');
  });
});
