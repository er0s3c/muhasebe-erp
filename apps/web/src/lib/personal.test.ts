// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseFavorites, pushRecent, readRecent } from './personal';

beforeEach(() => localStorage.clear());

describe('son ziyaretler ve favoriler', () => {
  it('son ziyareti başa alır, tekrarı tekilleştirir ve en çok 15 kayıt tutar', () => {
    const key = 'ada:recent:v1:u:c';
    for (let i = 0; i < 20; i++) pushRecent(key, { path: `/parties/${i}`, title: `Cari ${i}` }, 1000 + i);
    pushRecent(key, { path: '/parties/3', title: 'Cari 3', kind: 'Cari' }, 5000);
    const list = readRecent(key);
    expect(list).toHaveLength(15);
    expect(list[0]).toMatchObject({ path: '/parties/3', kind: 'Cari', at: 5000 });
    expect(list.filter(r => r.path === '/parties/3')).toHaveLength(1);
  });

  it('bozuk depolama verisini yok sayar', () => {
    localStorage.setItem('k', '{bozuk');
    expect(readRecent('k')).toEqual([]);
  });

  it('favori listesinde yalnız iç yolları kabul eder', () => {
    expect(parseFavorites([{ path: '/invoices/sales', title: 'Satış' }, { path: 'https://x.test', title: 'Dış' }, { title: 'yolsuz' }])).toEqual([
      { path: '/invoices/sales', title: 'Satış' },
    ]);
    expect(parseFavorites('x')).toBeNull();
  });
});
