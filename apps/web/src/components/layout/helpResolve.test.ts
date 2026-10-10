import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NAV_ITEMS } from '@erp/shared';
import { describe, expect, it } from 'vitest';
import { NAV_GROUP_HELP, NAV_ITEM_HELP } from './navHelpData';
import { resolveHelpEntry, routeHelpKey } from './helpResolve';

const data = { NAV_GROUP_HELP, NAV_ITEM_HELP };
const SRC = join(__dirname, '..', '..');
function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('sayfa rehberi ("i") kapsamı', () => {
  it('menüdeki her öğenin kendi rehber metni vardır', () => {
    const missing = NAV_ITEMS.filter(item => !NAV_ITEM_HELP[item.key]).map(item => item.key);
    expect(missing).toEqual([]);
  });

  it('kaynakta kullanılan her helpKey için rehber kaydı vardır', () => {
    const keys = new Set<string>();
    for (const file of walk(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/helpKey=(?:"([^"]+)"|\{'([^']+)'\})/g)) keys.add(m[1] ?? m[2]!);
      for (const m of readFileSync(file, 'utf8').matchAll(/helpKey=\{[^}]*\?\s*'([^']+)'\s*:\s*'([^']+)'\s*\}/g)) { keys.add(m[1]!); keys.add(m[2]!); }
    }
    expect(keys.size).toBeGreaterThan(20);
    expect([...keys].filter(k => !NAV_ITEM_HELP[k] && !NAV_GROUP_HELP[k])).toEqual([]);
  });

  it('detay/editör yolları kesin desenle eşlenir; liste yolları desenin önünde kalır', () => {
    expect(routeHelpKey('/parties/019b')).toBe('party-detail');
    expect(routeHelpKey('/parties/aging')).toBe('party-aging');
    expect(routeHelpKey('/invoices/new')).toBe('invoice-editor');
    expect(routeHelpKey('/invoices/sales')).toBe('sales-invoices');
    expect(routeHelpKey('/hr/payroll/abc/slip/def')).toBe('payroll-slip');
    expect(routeHelpKey('/hr/payroll/settings')).toBe('payroll-settings');
    expect(routeHelpKey('/hr/payroll/abc')).toBe('payroll-run');
  });

  it('rehberi olmayan ekran ilgisiz bir modülün metnini değil, grubunun rehberini gösterir', () => {
    // Eski "içerir" eşleşmesi "Hesaplar" başlığını başka bir modüle bağlayabiliyordu
    const entry = resolveHelpEntry(data, { pathname: '/inventory/unknown-screen', title: 'Hesaplar' });
    expect(entry.title).toBe('Hesaplar');
    expect(entry.description).toBe(NAV_GROUP_HELP.stock!.description);
  });

  it('açık helpKey ve açık help yol eşleşmesinin önüne geçer', () => {
    expect(resolveHelpEntry(data, { pathname: '/', helpKey: 'dashboard' }).title).toBe(NAV_ITEM_HELP.dashboard!.title);
    const help = { title: 'Özel', description: 'x' };
    expect(resolveHelpEntry(data, { pathname: '/parties', help })).toBe(help);
  });
});
