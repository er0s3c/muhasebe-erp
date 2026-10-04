import { describe, expect, it } from 'vitest';
import { applyRate, currencySymbol, dec, formatMoney, formatTR, parseTR, roundMoney, sum, toDbAmount } from './money';
import { resolveEnabledModules, MODULES, type ModuleDef } from './module-registry';
import { hasPermission } from './permissions';
import { createJournalSchema, accountTypeForCode } from './schemas/ledger';
import { todayIso, formatDateTR } from './dates';

describe('para birimi simgeleri', () => {
  it('simge önde, negatifte işaret simgeden önce', () => {
    expect(formatMoney('1234.5', 'TRY')).toBe('₺1.234,50');
    expect(formatMoney('-1234.5', 'GBP')).toBe('-£1.234,50');
    expect(formatMoney('0', 'EUR')).toBe('€0,00');
    expect(formatMoney('12.3456', 'USD', 4)).toBe('$12,3456');
    expect(formatMoney(null, 'TRY')).toBe('');
    expect(formatMoney('', 'TRY')).toBe('');
  });

  it('bilinmeyen kod kodla gösterilir (sabit boşluk önekli); prototip anahtarları simge sanılmaz', () => {
    expect(formatMoney('5', 'CHF')).toBe('CHF\u00A05,00');
    expect(currencySymbol('CHF')).toBe('CHF');
    expect(currencySymbol('constructor')).toBe('constructor');
    expect(currencySymbol('TRY')).toBe('₺');
  });
});

describe('money', () => {
  it('float sapması yok: 0,1 + 0,2 = 0,3', () => {
    expect(sum(['0.1', '0.2']).toFixed(2)).toBe('0.30');
  });

  it('yarıya yukarı yuvarlar', () => {
    expect(roundMoney('1.005').toFixed(2)).toBe('1.01');
    expect(roundMoney('2.675').toFixed(2)).toBe('2.68');
  });

  it('tutar × kur küçük birime yuvarlanır', () => {
    expect(applyRate('100', '32.12345678').toFixed(2)).toBe('3212.35');
  });

  it('DB tutarı 4 ondalık', () => {
    expect(toDbAmount('12.5')).toBe('12.5000');
    expect(dec('1e-2').toFixed(4)).toBe('0.0100');
  });

  it('Türkçe biçimlendirme', () => {
    expect(formatTR('1234567.891')).toBe('1.234.567,89');
    expect(formatTR('-1234.5')).toBe('-1.234,50');
    expect(formatTR('0')).toBe('0,00');
    expect(formatTR(null)).toBe('');
  });

  it('Türkçe giriş ayrıştırma', () => {
    expect(parseTR('1.234,56')).toBe('1234.56');
    expect(parseTR('1234,5')).toBe('1234.5');
    expect(parseTR('1.234')).toBe('1234');
    expect(parseTR(',5')).toBe('0.5');
    expect(parseTR('abc')).toBeNull();
    expect(parseTR('')).toBeNull();
  });

  it('parseTR: binlik nokta, ondalık virgül; belirsiz giriş sessizce büyümez (UI-1/UI-2)', () => {
    const cases: [string, string | null][] = [
      ['250.000', '250000'],
      ['1.234,56', '1234.56'],
      ['12,5', '12.5'],
      ['1.234.567,8', '1234567.8'],
      ['250000', '250000'],
      ['12.5', '12.5'],
      ['12.50', '12.50'],
      ['0.75', '0.75'],
      ['1234.5', '1234.5'],
      ['1.500', '1500'],
      ['.5', '0.5'],
      ['12,', '12'],
      [' 1 250,5 ', '1250.5'],
      ['1\u00A0250,5', '1250.5'],
      ['-1.234,5', '-1234.5'],
      ['+7', '7'],
      ['-0', '0'],
      ['007,5', '7.5'],
      ['1.2.3', null],
      ['1.23,4', null],
      ['1,234.56', null],
      ['1,2,3', null],
      ['12.34.5', null],
      ['abc', null],
      ['1e5', null],
      ['-', null],
      [',', null],
      ['.', null],
      ['12-3', null],
      ['₺100', null],
    ];
    for (const [input, expected] of cases) expect(parseTR(input), input).toBe(expected);
  });
});

describe('dates', () => {
  it('ISO tarihi Türkçe biçime çevirir', () => {
    expect(formatDateTR('2026-03-05')).toBe('05.03.2026');
  });
  it('Lefkoşa saatiyle gün sınırı', () => {
    // 22:30 UTC = ertesi gün 00:30 (yaz saati UTC+3)
    expect(todayIso(new Date('2026-07-01T22:30:00Z'))).toBe('2026-07-02');
  });
});

describe('module registry', () => {
  it('çekirdek modüller her sektörde açık', () => {
    for (const sector of ['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE'] as const) {
      const enabled = resolveEnabledModules(sector);
      expect(enabled.has('core.ledger')).toBe(true);
      expect(enabled.has('core.settings')).toBe(true);
    }
  });

  it('planlanan modüller henüz kimseye açılmaz', () => {
    expect(resolveEnabledModules('RETAIL_MARKET').has('retail.pos')).toBe(false);
  });

  it('proje modülü yalnızca inşaat şirketine açılır', () => {
    expect(resolveEnabledModules('CONSTRUCTION').has('construction.projects')).toBe(true);
    expect(resolveEnabledModules('COMMERCE').has('construction.projects')).toBe(false);
    expect(resolveEnabledModules('RETAIL_MARKET').has('construction.projects')).toBe(false);
  });

  it('sektör yalıtımı: inşaatta market modülü yok, markette inşaat modülü yok', () => {
    const registry: ModuleDef[] = MODULES.map((m) => ({ ...m, status: 'available' as const }));
    const construction = resolveEnabledModules('CONSTRUCTION', [], registry);
    const retail = resolveEnabledModules('RETAIL_MARKET', [], registry);
    expect(construction.has('construction.projects')).toBe(true);
    expect(construction.has('retail.pos')).toBe(false);
    expect(retail.has('retail.pos')).toBe(true);
    expect(retail.has('construction.projects')).toBe(false);
  });

  it('istisna modülü kapatabilir ama sektöre uymayanı açamaz; kilitli modül kapanmaz', () => {
    const enabled = resolveEnabledModules('COMMERCE', [
      { module: 'core.settings', enabled: false },
      { module: 'core.dashboard', enabled: false },
      { module: 'core.treasury', enabled: false },
      { module: 'retail.pos', enabled: true },
    ]);
    expect(enabled.has('core.settings')).toBe(true);
    expect(enabled.has('core.dashboard')).toBe(true);
    expect(enabled.has('core.treasury')).toBe(false);
    expect(enabled.has('retail.pos')).toBe(false);
  });
});

describe('permissions', () => {
  it('muhasebeci yevmiye atar ama şirket yönetemez', () => {
    expect(hasPermission('accountant', 'ledger.post')).toBe(true);
    expect(hasPermission('accountant', 'company.manage')).toBe(false);
  });
  it('izleyici yalnızca okur', () => {
    expect(hasPermission('viewer', 'ledger.read')).toBe(true);
    expect(hasPermission('viewer', 'ledger.post')).toBe(false);
  });
  it('şantiye sorumlusu carileri okur (seçiciler için) ama yönetemez', () => {
    expect(hasPermission('site_manager', 'parties.read')).toBe(true);
    expect(hasPermission('site_manager', 'parties.manage')).toBe(false);
  });
});

describe('ledger schemas', () => {
  const line = { accountId: '0198f2c4-7b1a-7000-8000-000000000001', currency: 'TRY' as const };

  it('satırda hem borç hem alacak olamaz', () => {
    const r = createJournalSchema.safeParse({
      entryDate: '2026-03-05',
      description: 'x',
      lines: [
        { ...line, debit: '10', credit: '10' },
        { ...line, credit: '10' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('geçerli yevmiye kabul edilir', () => {
    const r = createJournalSchema.safeParse({
      entryDate: '2026-03-05',
      description: 'Açılış',
      lines: [
        { ...line, debit: '100' },
        { ...line, credit: '100' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('Tekdüzen sınıfından hesap türü', () => {
    expect(accountTypeForCode('100')).toBe('asset');
    expect(accountTypeForCode('320')).toBe('liability');
    expect(accountTypeForCode('500')).toBe('equity');
    expect(accountTypeForCode('600')).toBe('income');
    expect(accountTypeForCode('770')).toBe('cost');
  });
});
