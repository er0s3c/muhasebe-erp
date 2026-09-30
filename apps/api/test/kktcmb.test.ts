import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/http/errors';
import { kktcmbUrl, parseKktcmbXml } from '../src/modules/settings/kktcmb';
import { client, createCompany, makeApp, registerUser } from './helpers';

// Kurumun yayımladığı gerçek dosya (29/09/2026, duyuru 2026/182)
const SAMPLE = readFileSync(new URL('./fixtures/kktcmb-gunluk.xml', import.meta.url), 'utf8');

describe('Merkez Bankası XML ayrıştırıcı', () => {
  it('gerçek örnek dosyayı ayrıştırır', () => {
    const day = parseKktcmbXml(SAMPLE);
    expect(day.date).toBe('2026-09-29');
    expect(day.announcementNo).toBe('2026/182');
    expect(day.rates).toHaveLength(12);
    const gbp = day.rates.find((r) => r.symbol === 'GBP')!;
    expect(gbp).toMatchObject({
      name: 'İNGİLİZ STERLİNİ',
      unit: 1,
      buy: '64.72680000',
      sell: '65.06430000',
      effectiveBuy: '64.68150000',
      effectiveSell: '65.16180000',
    });
  });

  it('Birim=100 olan kurlar tek birime bölünür (JPY)', () => {
    const jpy = parseKktcmbXml(SAMPLE).rates.find((r) => r.symbol === 'JPY')!;
    expect(jpy.unit).toBe(100);
    // 31,05240 TL / 100 JPY = 0,310524 TL / 1 JPY
    expect(jpy.buy).toBe('0.31052400');
    expect(jpy.sell).toBe('0.31258000');
  });

  it('tek kayıtlı dosyayı da ayrıştırır (dizi olmayan durum)', () => {
    const one = `<?xml version="1.0"?><KKTCMB_Doviz_Kurlari><Kur_Tarihi>01/02/2024</Kur_Tarihi>
      <Resmi_Kurlar><Resmi_Kur><Birim>1</Birim><Sembol>EUR</Sembol><Isim>EURO</Isim>
      <Doviz_Alis>35.1</Doviz_Alis><Doviz_Satis>35.2</Doviz_Satis><Efektif_Alis>35.0</Efektif_Alis><Efektif_Satis>35.3</Efektif_Satis>
      </Resmi_Kur></Resmi_Kurlar></KKTCMB_Doviz_Kurlari>`;
    const day = parseKktcmbXml(one);
    expect(day.date).toBe('2024-02-01');
    expect(day.announcementNo).toBeNull();
    expect(day.rates).toHaveLength(1);
    expect(day.rates[0]!.buy).toBe('35.10000000');
  });

  const broken = (mutate: (s: string) => string) => () => parseKktcmbXml(mutate(SAMPLE));
  const invalid = { code: 'RATE_XML_INVALID' };

  it('bozuk ve şüpheli girdiyi reddeder', () => {
    expect(broken((s) => s.replace('<Kur_Tarihi>29/09/2026', '<Kur_Tarihi>31/02/2026'))).toThrow(expect.objectContaining(invalid));
    expect(broken((s) => s.replace('<Kur_Tarihi>29/09/2026</Kur_Tarihi>', ''))).toThrow(expect.objectContaining(invalid));
    expect(broken((s) => s.replace('<Doviz_Alis>64.72680</Doviz_Alis>', '<Doviz_Alis>abc</Doviz_Alis>'))).toThrow(expect.objectContaining(invalid));
    expect(broken((s) => s.replace('<Doviz_Alis>64.72680</Doviz_Alis>', '<Doviz_Alis>0</Doviz_Alis>'))).toThrow(expect.objectContaining(invalid));
    expect(broken((s) => s.replace('<Doviz_Alis>64.72680</Doviz_Alis>', '<Doviz_Alis>-5</Doviz_Alis>'))).toThrow(expect.objectContaining(invalid));
    expect(broken((s) => s.replace('<Birim>100</Birim>', '<Birim>0</Birim>'))).toThrow(expect.objectContaining(invalid));
    expect(broken((s) => s.replace('<Sembol>GBP</Sembol>', '<Sembol>gbp1</Sembol>'))).toThrow(expect.objectContaining(invalid));
    expect(broken((s) => s.replace('KKTCMB_Doviz_Kurlari', 'BaskaKok'))).toThrow(expect.objectContaining(invalid));
    expect(() => parseKktcmbXml('bu xml değil')).toThrow(expect.objectContaining(invalid));
  });

  it('DOCTYPE/ENTITY (XXE, varlık şişirme) içeren dosyayı reddeder', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>` + SAMPLE.split('?>')[1];
    expect(() => parseKktcmbXml(xxe)).toThrow(expect.objectContaining(invalid));
  });

  it('aşırı büyük dosyayı reddeder', () => {
    expect(() => parseKktcmbXml(SAMPLE + ' '.repeat(600_000))).toThrow(expect.objectContaining(invalid));
  });

  it('resmî adresi kurar; yalnızca sabit alan adı', () => {
    expect(kktcmbUrl()).toBe('https://www.mb.gov.ct.tr/kur/gunluk.xml');
    expect(kktcmbUrl('2026-09-29')).toBe('https://www.mb.gov.ct.tr/kur/tarih/20260929');
    expect(() => kktcmbUrl('2026-09-29/../../x')).toThrow();
    expect(() => kktcmbUrl('https://evil.example')).toThrow();
  });
});

describe('Merkez Bankası kurlarını içe aktarma (API)', async () => {
  const fetcher = vi.fn(async (_date?: string) => SAMPLE);
  const { app } = await makeApp({ rateFetcher: fetcher });

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    return { s, company, c: client(app, s.token, company.id) };
  }

  it('yüklenen XML dosyasından GBP/EUR/USD kurlarını yazar, kalanını atlar', async () => {
    const { c } = await setup('KurXml');
    const res = await c.post('/api/exchange-rates/import', { source: 'xml', xml: SAMPLE });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.date).toBe('2026-09-29');
    expect(body.announcementNo).toBe('2026/182');
    expect(body.imported.map((r: any) => r.currency).sort()).toEqual(['EUR', 'GBP', 'USD']);
    expect(body.skipped.sort()).toEqual(['AUD', 'CAD', 'CHF', 'DKK', 'JPY', 'KWD', 'NOK', 'SAR', 'SEK']);

    const rates = (await c.get('/api/exchange-rates?from=2026-09-29&to=2026-09-29')).json().rates;
    expect(rates).toHaveLength(3);
    expect(rates.find((r: any) => r.currencyCode === 'GBP')).toMatchObject({
      quoteCode: 'TRY',
      buy: '64.72680000',
      sell: '65.06430000',
      source: 'KKTCMB 2026/182',
    });
    const lookup = (await c.get('/api/exchange-rates/lookup?from=GBP&to=TRY&date=2026-09-29')).json();
    expect(lookup.rate).toBe('64.72680000');
  });

  it('aynı dosyayı tekrar yüklemek yinelenen kayıt oluşturmaz', async () => {
    const { c } = await setup('KurTekrar');
    await c.post('/api/exchange-rates/import', { source: 'xml', xml: SAMPLE });
    await c.post('/api/exchange-rates/import', { source: 'xml', xml: SAMPLE });
    expect((await c.get('/api/exchange-rates')).json().rates).toHaveLength(3);
  });

  it('resmî adresten çekme: tarih verilmezse günlük, verilirse tarihli istek', async () => {
    const { c } = await setup('KurFetch');
    fetcher.mockClear();
    expect((await c.post('/api/exchange-rates/import', { source: 'kktcmb' })).statusCode).toBe(200);
    expect(fetcher).toHaveBeenLastCalledWith(undefined);
    expect((await c.post('/api/exchange-rates/import', { source: 'kktcmb', date: '2026-09-29' })).statusCode).toBe(200);
    expect(fetcher).toHaveBeenLastCalledWith('2026-09-29');
    // Geçersiz tarih indirmeye hiç ulaşmaz
    fetcher.mockClear();
    expect((await c.post('/api/exchange-rates/import', { source: 'kktcmb', date: '2026-13-45' })).statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('kaynak erişilemezse 502 ve anlaşılır hata; bozuk yanıt 422', async () => {
    const { c } = await setup('KurHata');
    fetcher.mockRejectedValueOnce(new AppError(502, 'RATE_SOURCE_UNAVAILABLE', 'ulaşılamadı'));
    const down = await c.post('/api/exchange-rates/import', { source: 'kktcmb' });
    expect(down.statusCode).toBe(502);
    expect(down.json().error.code).toBe('RATE_SOURCE_UNAVAILABLE');

    fetcher.mockResolvedValueOnce('<html>hata sayfası</html>');
    const bad = await c.post('/api/exchange-rates/import', { source: 'kktcmb' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('RATE_XML_INVALID');
    expect((await c.get('/api/exchange-rates')).json().rates).toHaveLength(0);
  });

  it('desteklenen para birimi yoksa reddeder; yetkisiz rol içe aktaramaz', async () => {
    const { c, company } = await setup('KurYetki');
    const onlyJpy = SAMPLE.replace(/<Resmi_Kur>(?:(?!<\/Resmi_Kur>)[\s\S])*?<Sembol>(USD|EUR|GBP)<\/Sembol>[\s\S]*?<\/Resmi_Kur>/g, '');
    const none = await c.post('/api/exchange-rates/import', { source: 'xml', xml: onlyJpy });
    expect(none.statusCode).toBe(422);
    expect(none.json().error.code).toBe('RATE_XML_NO_SUPPORTED');

    await c.post('/api/company/members', { email: 'viewer-imp@example.com', fullName: 'İzleyici', role: 'viewer', password: 'Izleyici-12345', mustChangePassword: false });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'viewer-imp@example.com', password: 'Izleyici-12345' } })).json().accessToken;
    const res = await client(app, tok, company.id).post('/api/exchange-rates/import', { source: 'xml', xml: SAMPLE });
    expect(res.statusCode).toBe(403);
  });
});
