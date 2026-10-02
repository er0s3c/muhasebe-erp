import { describe, expect, it } from 'vitest';
import { IMPORT_FIELDS } from '@erp/shared';
import { writeXlsx } from '../src/files/xlsx-write';
import { client, createCompany, day, makeApp, registerUser } from './helpers';
import { x2Kit } from './x2-helpers';

describe('Excel ile fatura içe aktarma (X2)', async () => {
  const { app } = await makeApp();
  const k = x2Kit(app);

  /** Alan anahtarlı satır (cells) → API gövdesi. */
  type Cells = Record<string, string | undefined>;
  const rows = (list: Cells[]) => list.map((cells, i) => ({ row: i + 2, cells }));
  const preview = (c: any, kind: string, list: Cells[], options: Record<string, unknown> = {}) =>
    c.post(`/api/imports/${kind}/preview`, { rows: rows(list), options: { numberFormat: 'tr', ...options } });
  const commit = (c: any, kind: string, list: Cells[], options: Record<string, unknown> = {}) =>
    c.post(`/api/imports/${kind}/commit`, { rows: rows(list), options: { numberFormat: 'tr', ...options } });

  async function base(name: string) {
    const ctx = await k.setup(name);
    const { c } = ctx;
    const ali = await k.mkParty(c, 'Ali Yılmaz Ltd.', 'customer', { taxNumber: '1111111111' });
    const burak = await k.mkParty(c, 'Burak İnşaat', 'customer', { taxNumber: '2222222222' });
    const sup = await k.mkParty(c, 'Demir Çelik A.Ş.', 'supplier', { taxNumber: '3333333333' });
    const cim = await k.mkItem(c, 'Çimento 50 kg', { code: 'CIM-50', barcode: '869000001' });
    const kum = await k.mkItem(c, 'Kum');
    return { ...ctx, ali, burak, sup, cim, kum };
  }

  it('şablon indirme (xlsx/csv) ve eşleme önerisi: başlıklar alanlara otomatik eşlenir', async () => {
    const { c } = await base('FatSablon');
    const x = await c.get('/api/imports/sales_invoices/template?format=xlsx');
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.headers['content-disposition']).toContain('sablon-sales-invoices.xlsx');
    const csv = await c.get('/api/imports/purchase_invoices/template?format=csv');
    expect(csv.statusCode).toBe(200);
    const first = csv.body.replace(/^\uFEFF/, '').split(/\r?\n/)[0]!;
    expect(first.split(';').map((h) => h.replace(/"/g, ''))).toEqual(IMPORT_FIELDS.purchase_invoices.map((f) => f.label));

    // Müşterinin kendi başlıklarıyla bir xlsx → parse → eşleme önerisi
    const bytes = writeXlsx([{
      key: 'f', title: 'Faturalar', plain: true,
      columns: ['Fatura No', 'Tarih', 'Müşteri', 'VKN', 'Stok Kodu', 'Miktar', 'Birim Fiyat', 'KDV'].map((l) => ({ key: l, label: l, kind: 'text' as const })),
      rows: [{ 'Fatura No': 'A1', Tarih: '15.03.2026', 'Müşteri': 'Ali', VKN: '1', 'Stok Kodu': 'CIM-50', Miktar: '2', 'Birim Fiyat': '100', KDV: '16' }],
    }]);
    const parsed = (await c.post('/api/imports/sales_invoices/parse', { fileName: 'f.xlsx', contentBase64: Buffer.from(bytes).toString('base64') })).json();
    expect(parsed.headers).toEqual(['Fatura No', 'Tarih', 'Müşteri', 'VKN', 'Stok Kodu', 'Miktar', 'Birim Fiyat', 'KDV']);
    const idx = (key: string) => parsed.suggestedMapping[key];
    expect([idx('docNo'), idx('date'), idx('party'), idx('taxNumber'), idx('item'), idx('quantity'), idx('unitPrice'), idx('vatCode')]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('önizleme: cari (vergi no/kod/ünvan), stok (kod/barkod/ad), serbest satır, KDV kodu/oranı, devam satırı üst bilgiyi taşır; taslak yazılır, yevmiye yok', async () => {
    const x = await base('FatImport');
    const { c } = x;
    const lines = [
      { docNo: 'A-1', date: '15.03.2026', party: 'Ali Yılmaz Ltd.', item: 'CIM-50', quantity: '10', unitPrice: '240,50', vatCode: 'KDV-16' },
      { docNo: 'A-1', item: 'Kum', quantity: '2', unitPrice: '100', vatCode: '16', discountPct: '10' }, // üst bilgi önceki satırdan
      { docNo: 'A-1', lineDescription: 'Nakliye', quantity: '1', unitPrice: '500' }, // serbest satır, KDV yok
      { docNo: 'A-2', date: '2026-03-16', taxNumber: '2222222222', item: '869000001', quantity: '3', unitPrice: '240', dueDate: '16.04.2026' }, // vergi no + barkod; KDV kartın kodundan
    ];
    const pv = (await preview(c, 'sales_invoices', lines)).json();
    expect(pv.counts).toMatchObject({ total: 4, error: 0, ok: 4 });
    expect(pv.canCommit).toBe(true);
    expect(pv.rows[0].label).toBe('A-1 · Ali Yılmaz Ltd.');
    expect(pv.rows[3].label).toBe('A-2 · Burak İnşaat');
    expect(pv.summary).toEqual(expect.arrayContaining([{ label: 'Oluşacak taslak fatura', value: '2' }, { label: 'Fatura kalemi', value: '4' }]));

    const journalsBefore = (await c.get('/api/journal-entries')).json().entries.length;
    const done = await commit(c, 'sales_invoices', lines);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ created: 2, kind: 'sales_invoices', entries: [{ type: 'invoice', no: 'A-1' }, { type: 'invoice', no: 'A-2' }] });
    const list = (await c.get('/api/invoices?type=sales')).json();
    expect(list.invoices.every((i: any) => i.status === 'draft')).toBe(true);
    const a1 = (await c.get(`/api/invoices/${done.json().entries[0].id}`)).json();
    expect(a1.invoice).toMatchObject({ status: 'draft', externalNo: 'A-1', invoiceDate: '2026-03-15', netTotal: '3085.0000' });
    expect(a1.lines.map((l: any) => [l.description, l.quantity, l.vatCode])).toEqual([['Çimento 50 kg', '10.0000', 'KDV-16'], ['Kum', '2.0000', 'KDV-16'], ['Nakliye', '1.0000', null]]);
    const a2 = (await c.get(`/api/invoices/${done.json().entries[1].id}`)).json();
    expect(a2.invoice).toMatchObject({ dueDate: '2026-04-16', partyId: x.burak.id });
    expect(a2.lines[0].vatCode).toBe('KDV-16'); // kartın KDV kodu
    expect((await c.get('/api/journal-entries')).json().entries).toHaveLength(journalsBefore); // yevmiye yok

    // İçe aktarılan taslak normal akışla kaydedilir (stoklu satır: stok yeterli olmalı)
    expect((await c.post(`/api/invoices/${a2.invoice.id}/post`)).json().error.code).toBe('STOCK_INSUFFICIENT');
    await k.receipt(c, day(3, 1), x.main.id, x.cim.id, '10', '5');
    const posted = await c.post(`/api/invoices/${a2.invoice.id}/post`);
    expect(posted.statusCode).toBe(200);
    expect(posted.json().invoice.status).toBe('posted');
  });

  it('satır bazlı doğrulama: tek hata bile varsa hiçbir şey yazılmaz; eşleşmeyenler öneriyle listelenir; elle eşleme (partyMap/itemMap) çözer', async () => {
    const x = await base('FatHata');
    const { c } = x;
    const lines = [
      { docNo: 'B-1', date: '15.03.2026', party: 'Ali Yılmaz', item: 'CIM-50', quantity: '1', unitPrice: '10' }, // ünvan tam eşleşmez
      { docNo: 'B-2', date: '31.02.2026', party: 'Ali Yılmaz Ltd.', item: 'YOK-1', quantity: '1', unitPrice: '10' }, // bozuk tarih + bilinmeyen stok
      { docNo: 'B-3', date: '15.03.2026', party: 'Ali Yılmaz Ltd.', item: 'CIM-50', quantity: '0', unitPrice: '-5', vatCode: '99' },
      { docNo: '', date: '15.03.2026', party: 'Ali Yılmaz Ltd.', item: 'CIM-50', quantity: '1', unitPrice: '10' },
      { docNo: 'B-4', date: '15.03.2026', party: 'Ali Yılmaz Ltd.', item: 'CIM-50', quantity: '1', unitPrice: '10' },
      { docNo: 'B-4', date: '16.03.2026', quantity: '1', unitPrice: '10', item: 'CIM-50' }, // üst bilgi çelişkisi
    ];
    const res = await preview(c, 'sales_invoices', lines);
    expect(res.statusCode).toBe(200);
    const pv = res.json();
    expect(pv.canCommit).toBe(false);
    const codes = (i: number) => pv.rows[i].messages.map((m: any) => m.code);
    expect(codes(0)).toContain('PARTY_NOT_FOUND');
    expect(codes(1)).toEqual(expect.arrayContaining(['INVALID_DATE', 'ITEM_NOT_FOUND']));
    expect(codes(2)).toEqual(expect.arrayContaining(['QUANTITY_INVALID', 'VAT_CODE_UNKNOWN']));
    expect(codes(3)).toContain('DOC_NO_REQUIRED');
    expect(codes(5)).toContain('HEADER_CONFLICT');
    expect(pv.rows[4].status).toBe('ok');
    // Eşleşmeyenler öneriyle
    expect(pv.unmatched).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'party', text: 'Ali Yılmaz', rows: 1, candidates: [expect.objectContaining({ id: x.ali.id })] }),
      expect.objectContaining({ field: 'item', text: 'YOK-1', rows: 1 }),
    ]));
    // Hata varken commit hiçbir şey yazmaz
    const bad = await commit(c, 'sales_invoices', lines);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('IMPORT_INVALID');
    expect((await c.get('/api/invoices?type=sales')).json().total).toBe(0);

    // Elle eşleme: dosyadaki "Ali Yılmaz" metni → cari kartı; YOK-1 → Kum
    const fixed = [lines[0]!, { ...lines[1]!, date: '15.03.2026', item: 'YOK-1' }];
    const ok = await commit(c, 'sales_invoices', fixed, { partyMap: { 'Ali Yılmaz': x.ali.id }, itemMap: { 'YOK-1': x.kum.id } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().created).toBe(2);
    const inv = (await c.get(`/api/invoices/${ok.json().entries[0].id}`)).json();
    expect(inv.invoice.partyId).toBe(x.ali.id);
  });

  it('mükerrer: aynı cari + belge no atlanır (ya da seçeneğe göre hata); tekrar içe aktarma yeni fatura yazmaz', async () => {
    const x = await base('FatMukerrer');
    const { c } = x;
    const lines = [{ docNo: 'M-1', date: '15.03.2026', party: 'Ali Yılmaz Ltd.', item: 'CIM-50', quantity: '1', unitPrice: '10' }];
    expect((await commit(c, 'sales_invoices', lines)).statusCode).toBe(200);
    const again = (await preview(c, 'sales_invoices', lines)).json();
    expect(again.counts).toMatchObject({ skip: 1, ok: 0, error: 0 });
    expect(again.rows[0].messages[0].code).toBe('DUPLICATE');
    expect(again.canCommit).toBe(false);
    expect((await commit(c, 'sales_invoices', lines)).json().error.code).toBe('IMPORT_EMPTY');
    const strict = (await preview(c, 'sales_invoices', lines, { skipDuplicates: false })).json();
    expect(strict.rows[0].status).toBe('error');
    // Aynı numara başka cariye aittir: mükerrer değil
    const other = [{ ...lines[0]!, party: 'Burak İnşaat' }];
    expect((await preview(c, 'sales_invoices', other)).json().counts.ok).toBe(1);
    // Karışık dosya: biri mükerrer biri yeni: yalnızca yenisi yazılır
    const mixed = [lines[0]!, { ...lines[0]!, docNo: 'M-2' }];
    const m = await commit(c, 'sales_invoices', mixed);
    expect(m.statusCode).toBe(200);
    expect(m.json()).toMatchObject({ created: 1, skipped: 1 });
  });

  it('alış faturası: tedarikçi carisi şart, tedarikçi fatura no zorunlu kayıtta; KDV oranı tarihli kayıtlardan çözülür; ondalık biçimi', async () => {
    const x = await base('FatAlis');
    const { c } = x;
    const lines = [
      { docNo: 'TED-9', date: '15.03.2026', party: 'Demir Çelik A.Ş.', item: 'Kum', quantity: '1.000,5', unitPrice: '12,75', vatCode: '%16' },
      { docNo: 'TED-10', date: '15.03.2026', party: 'Ali Yılmaz Ltd.', item: 'Kum', quantity: '1', unitPrice: '10' }, // müşteri carisi
    ];
    const pv = (await preview(c, 'purchase_invoices', lines)).json();
    expect(pv.rows[0].status).toBe('ok');
    expect(pv.rows[1].messages.map((m: any) => m.code)).toContain('PARTY_KIND_MISMATCH');
    const done = await commit(c, 'purchase_invoices', [lines[0]!]);
    expect(done.statusCode).toBe(200);
    const inv = (await c.get(`/api/invoices/${done.json().entries[0].id}`)).json();
    expect(inv.invoice).toMatchObject({ type: 'purchase', status: 'draft', externalNo: 'TED-9' });
    expect(inv.lines[0]).toMatchObject({ quantity: '1000.5000', unitPrice: '12.750000', vatCode: 'KDV-16' });
    // Satış faturası olarak aynı tedarikçi reddedilir
    expect((await preview(c, 'sales_invoices', [lines[0]!])).json().rows[0].messages.map((m: any) => m.code)).toContain('PARTY_KIND_MISMATCH');
    // Belirsiz sayı biçimi (auto): "1.234" reddedilir, açık biçim seçilince kabul
    const amb = [{ ...lines[0]!, quantity: '1.234', docNo: 'TED-11' }];
    expect((await c.post('/api/imports/purchase_invoices/preview', { rows: rows(amb), options: { numberFormat: 'auto' } })).json().counts.error).toBe(1);
  });

  it('yetki, modül ve izolasyon: izleyici 403, satış rolü taslak içe aktarır, başka şirketin carisi eşleşmez, fatura modülü kapalıyken 403', async () => {
    const x = await base('FatYetki');
    const { c, company } = x;
    const viewer = await k.memberClient(c, company.id, 'viewer');
    const sales = await k.memberClient(c, company.id, 'sales');
    const lines = [{ docNo: 'Y-1', date: '15.03.2026', party: 'Ali Yılmaz Ltd.', item: 'CIM-50', quantity: '1', unitPrice: '10' }];
    expect((await preview(viewer, 'sales_invoices', lines)).statusCode).toBe(403);
    expect((await viewer.get('/api/imports/sales_invoices/template')).statusCode).toBe(403);
    expect((await commit(sales, 'sales_invoices', lines)).statusCode).toBe(200);

    const s2 = await registerUser(app, 'FatDis');
    const co2 = await createCompany(app, s2.token);
    const c2 = client(app, s2.token, co2.id);
    const pv = (await preview(c2, 'sales_invoices', lines)).json();
    expect(pv.rows[0].messages.map((m: any) => m.code)).toEqual(expect.arrayContaining(['PARTY_NOT_FOUND']));
    // Başka şirketin cari kimliği elle eşlemede de kabul edilmez
    const tricked = (await preview(c2, 'sales_invoices', lines, { partyMap: { 'Ali Yılmaz Ltd.': x.ali.id } })).json();
    expect(tricked.rows[0].messages.map((m: any) => m.code)).toContain('PARTY_NOT_FOUND');

    await c.put('/api/company/modules/invoices.orders', { enabled: false });
    expect((await c.put('/api/company/modules/core.invoices', { enabled: false })).statusCode).toBe(200);
    expect((await preview(c, 'sales_invoices', lines)).statusCode).toBe(403);
  });

  it('sınırlar: gövde/satır sayısı üst sınırı ve boş dosya', async () => {
    const { c } = await base('FatSinir');
    expect((await c.post('/api/imports/sales_invoices/preview', { rows: [], options: {} })).statusCode).toBe(400);
    const tooMany = Array.from({ length: 5001 }, (_, i) => ({ row: i + 2, cells: { docNo: `N${i}` } }));
    expect((await c.post('/api/imports/sales_invoices/preview', { rows: tooMany, options: {} })).statusCode).toBe(400);
    void day;
  });
});
