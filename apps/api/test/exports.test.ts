import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { readXlsx } from '../src/files/xlsx-read';
import { PASSWORD, client, createCompany, day, makeApp, registerUser, thisYear } from './helpers';

describe('raporlar ve dışa aktarma', async () => {
  const { app } = await makeApp();

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    return { s, company, c: client(app, s.token, company.id) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];

  async function memberClient(owner: C, companyId: string, role: string) {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: `${role} Kişi`, role, password: PASSWORD, mustChangePassword: false });
    if (add.statusCode !== 201) throw new Error(`member failed: ${add.body}`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    return client(app, login.json().accessToken as string, companyId);
  }
  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`istek başarısız (${res.statusCode}): ${res.body}`);
    return res.json();
  };
  const xlsx = async (c: C, url: string) => {
    const res = await c.get(url);
    if (res.statusCode !== 200) throw new Error(`dışa aktarma başarısız (${res.statusCode}): ${res.body}`);
    return { res, sheets: readXlsx(new Uint8Array(res.rawPayload)) };
  };

  /** Defterde her türden kayıt bulunan bir şirket. */
  async function books(name: string) {
    const { s, company, c } = await setup(name);
    await ok(c.put('/api/exchange-rates', { rateDate: day(9, 15), currencyCode: 'GBP', quoteCode: 'TRY', buy: '45' }));
    const cust = (await ok(c.post('/api/parties', { name: 'Ömer Çakır Ticaret', kind: 'customer' }))).party;
    const sarah = (await ok(c.post('/api/parties', { name: 'Sarah Thompson', kind: 'customer' }))).party;
    const sup = (await ok(c.post('/api/parties', { name: 'Demir Çelik A.Ş.', kind: 'supplier' }))).party;
    const item = (await ok(c.post('/api/items', { name: 'Dış cephe boyası', vatCode: 'KDV-16' }))).item;
    const wh = (await ok(c.get('/api/warehouses'))).warehouses[0].id as string;

    const invoice = (body: Record<string, unknown>) => ok(c.post('/api/invoices', { post: true, ...body }));
    await invoice({ type: 'purchase', partyId: sup.id, invoiceDate: day(3, 1), externalNo: 'T-1', warehouseId: wh, lines: [{ itemId: item.id, description: 'Boya', quantity: '10', unitPrice: '50', vatCode: 'KDV-16' }] });
    const sale = await invoice({ type: 'sales', partyId: cust.id, invoiceDate: day(4, 1), warehouseId: wh, lines: [{ itemId: item.id, description: 'Boya', quantity: '4', unitPrice: '100', vatCode: 'KDV-16' }] });
    await invoice({ type: 'sales_return', partyId: cust.id, invoiceDate: day(4, 10), warehouseId: wh, returnOfId: sale.invoice.id, lines: [{ itemId: item.id, description: 'Boya iadesi', quantity: '1', unitPrice: '100', vatCode: 'KDV-16', sourceLineId: sale.lines[0].id }] });
    const wrong = await invoice({ type: 'sales', partyId: cust.id, invoiceDate: day(5, 1), warehouseId: wh, lines: [{ itemId: item.id, description: 'Hatalı', quantity: '2', unitPrice: '100', vatCode: 'KDV-16' }] });
    await ok(c.post(`/api/invoices/${wrong.invoice.id}/cancel`, { reason: 'Hatalı fatura', date: day(5, 2) }));
    await invoice({ type: 'expense', partyId: sup.id, invoiceDate: day(6, 1), externalNo: 'G-1', lines: [{ description: 'Şantiye gideri', quantity: '1', unitPrice: '1000', vatCode: 'KDV-16' }] });
    const gbp = await invoice({ type: 'sales', partyId: sarah.id, invoiceDate: day(7, 1), currency: 'GBP', fxRate: '40', lines: [{ description: 'Danışmanlık', quantity: '1', unitPrice: '100' }] });
    const gbp2 = await invoice({ type: 'sales', partyId: sarah.id, invoiceDate: day(7, 2), currency: 'GBP', fxRate: '40', lines: [{ description: 'Danışmanlık 2', quantity: '1', unitPrice: '50' }] });

    const bank = (await ok(c.post('/api/treasury/accounts', { kind: 'bank', name: 'KTB GBP', currency: 'GBP' }))).account;
    const openItems = async () => (await ok(c.get(`/api/parties/${sarah.id}/open-items?asOf=${day(9, 15)}&type=receivable`))).receivable.items as { lineId: string; remaining: string; description: string }[];
    const items = await openItems();
    const receive = (lineId: string, amount: string) =>
      ok(c.post('/api/treasury/transactions', { type: 'receipt', date: day(9, 15), accountId: bank.id, amount, partyId: sarah.id, items: [{ lineId, amount, settleAmount: amount }] }));
    await receive(items.find((i) => i.remaining === '100.00')!.lineId, '100');
    // İkinci tahsilat 250 TL kur kârı üretir, sonra iptal edilir: rapor dışında kalmalı
    const second = (await openItems()).find((i) => i.remaining === '50.00')!;
    const cancelled = await receive(second.lineId, '50');
    await ok(c.post(`/api/treasury/transactions/${cancelled.transaction.id}/cancel`, { reason: 'Yanlış hesap', date: day(9, 16) }));
    void gbp;
    void gbp2;
    return { s, company, c, cust, sarah, sup, item, bank };
  }

  const tbRows = async (c: C) => {
    const tb = await ok(c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`));
    return { tb, by: Object.fromEntries((tb.rows as any[]).map((r) => [r.code, r])) as Record<string, { debit: string; credit: string; closing: string }> };
  };

  it('yevmiye defteri: sayfalama tutarlı, toplam borç = alacak = mizan toplamı, ters/iptal kayıtları dahil', async () => {
    const { c } = await books('Defter');
    const { tb } = await tbRows(c);
    const all = await ok(c.get(`/api/reports/journal-book?from=${day(1, 1)}&to=${day(12, 31)}&limit=1000`));
    expect(all.total).toBeGreaterThan(20);
    expect(all.lines).toHaveLength(all.total);
    expect(all.totals.debitBase).toBe(all.totals.creditBase);
    expect(Number(all.totals.debitBase)).toBe(Number(tb.totals.debit));

    // Sayfalar birleşince aynı sıra ve aynı satırlar
    const p1 = await ok(c.get(`/api/reports/journal-book?from=${day(1, 1)}&to=${day(12, 31)}&limit=7&offset=0`));
    const p2 = await ok(c.get(`/api/reports/journal-book?from=${day(1, 1)}&to=${day(12, 31)}&limit=7&offset=7`));
    expect(p1.total).toBe(all.total);
    expect([...p1.lines, ...p2.lines].map((l: any) => `${l.entryNo}/${l.lineNo}`)).toEqual(all.lines.slice(0, 14).map((l: any) => `${l.entryNo}/${l.lineNo}`));
    // Sıra: tarih, fiş no, satır no
    const keys = all.lines.map((l: any) => `${l.entryDate} ${l.entryNo} ${String(l.lineNo).padStart(4, '0')}`);
    expect(keys).toEqual([...keys].sort());

    // Aralık daraltılınca yalnızca o günün fişleri gelir
    const march = await ok(c.get(`/api/reports/journal-book?from=${day(3, 1)}&to=${day(3, 31)}`));
    expect(march.lines.every((l: any) => l.entryDate >= day(3, 1) && l.entryDate <= day(3, 31))).toBe(true);
    expect(march.total).toBeGreaterThan(0);
    expect(march.total).toBeLessThan(all.total);
  });

  it('kebir: her hesabın kapanışı mizan bakiyesiyle aynı; yürüyen bakiye tutarlı; hesap sayfalı ve kod süzgeçli', async () => {
    const { c } = await books('Kebir');
    const { by } = await tbRows(c);
    const gl = await ok(c.get(`/api/reports/general-ledger?from=${day(1, 1)}&to=${day(12, 31)}&limit=200`));
    expect(gl.total).toBe(gl.accounts.length);
    for (const a of gl.accounts as any[]) {
      expect(Number(a.closing)).toBe(Number(by[a.code]!.closing));
      const last = a.lines[a.lines.length - 1];
      expect(last.balance).toBe(a.closing);
      expect(Number(a.opening) + Number(a.debit) - Number(a.credit)).toBeCloseTo(Number(a.closing), 4);
    }
    // 120 alacak hesabı: KDV'li satış ve iade, cari alacak
    expect(gl.accounts.map((a: any) => a.code)).toEqual([...gl.accounts.map((a: any) => a.code)].sort());

    const page = await ok(c.get(`/api/reports/general-ledger?from=${day(1, 1)}&to=${day(12, 31)}&limit=3&offset=0`));
    expect(page.accounts).toHaveLength(3);
    expect(page.total).toBe(gl.total);
    const only6 = await ok(c.get(`/api/reports/general-ledger?from=${day(1, 1)}&to=${day(12, 31)}&codePrefix=6`));
    expect(only6.accounts.length).toBeGreaterThan(0);
    expect(only6.accounts.every((a: any) => a.code.startsWith('6'))).toBe(true);
    expect((await c.get(`/api/reports/general-ledger?from=${day(1, 1)}&to=${day(12, 31)}&codePrefix=%25`)).statusCode).toBe(400);

    // Dönem başı: 1 Nisan'dan başlayınca öncesindeki hareketler devir olur
    const late = await ok(c.get(`/api/reports/general-ledger?from=${day(4, 1)}&to=${day(12, 31)}&codePrefix=15`));
    const stock = late.accounts.find((a: any) => a.code.startsWith('15'));
    expect(Number(stock.opening)).toBeGreaterThan(0);
  });

  it('satış/alış raporu: her kırılımda toplam net, KDV özetindeki net tutarla aynı; iade düşer, iptal iptal tarihinde eksi', async () => {
    const { c } = await books('Satis');
    const vat = await ok(c.get(`/api/reports/vat-summary?from=${day(1, 1)}&to=${day(12, 31)}`));
    for (const groupBy of ['party', 'item', 'month', 'invoice']) {
      const s = await ok(c.get(`/api/reports/sales-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=${groupBy}`));
      const p = await ok(c.get(`/api/reports/purchase-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=${groupBy}`));
      expect(Number(s.totals.net), `satış ${groupBy}`).toBe(Number(vat.totals.salesNet));
      expect(Number(s.totals.vat), `satış KDV ${groupBy}`).toBe(Number(vat.totals.salesVat));
      expect(Number(p.totals.net), `alış ${groupBy}`).toBe(Number(vat.totals.purchaseNet));
      expect(Number(s.totals.gross)).toBeCloseTo(Number(s.totals.net) + Number(s.totals.vat), 2);
    }
    // 4×100 − 1×100 iade + 100 GBP × 40 + 50 GBP × 40 (iptal edilen 2×100 yok)
    const s = await ok(c.get(`/api/reports/sales-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=invoice`));
    expect(Number(s.totals.net)).toBe(300 + 4000 + 2000);
    // İptal edilen fatura kendi tarihinde (+) ve iptal tarihinde (−) iki satırdır; birbirini götürür (ACC-11)
    const cancelled = s.rows.filter((r: any) => r.cancellation);
    expect(cancelled).toHaveLength(1);
    const orig = s.rows.find((r: any) => r.invoiceId === cancelled[0].invoiceId && !r.cancellation);
    expect(Number(orig.net) + Number(cancelled[0].net)).toBe(0);
    expect(s.rows.filter((r: any) => r.invoiceId !== cancelled[0].invoiceId).map((r: any) => r.type)).toEqual(['sales', 'sales_return', 'sales', 'sales']);
    expect(s.rows.find((r: any) => r.type === 'sales_return').net).toBe('-100.0000');
    // Cari bazında: en yüksek net başta
    const byParty = await ok(c.get(`/api/reports/sales-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=party`));
    expect(byParty.rows.map((r: any) => r.label)).toEqual(['Sarah Thompson', 'Ömer Çakır Ticaret']);
    // Stok kartı bazında: kartsız satırlar ayrı satırda
    const byItem = await ok(c.get(`/api/reports/sales-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=item`));
    expect(byItem.rows.find((r: any) => r.key === '-').label).toMatch(/Kartsız/);
    expect(byItem.rows.find((r: any) => r.label === 'Dış cephe boyası')).toMatchObject({ qty: '3.0000', net: '300.0000' });
    // Ay bazında
    const byMonth = await ok(c.get(`/api/reports/sales-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=month`));
    // Mayıs: iptal satırı (eksi); iptal edilen fatura kendi ayında kalır
    expect(byMonth.rows.map((r: any) => r.key)).toEqual([`${thisYear}-04`, `${thisYear}-05`, `${thisYear}-07`]);
  });

  it('stok kârlılığı: toplam kâr = 600 − 610 − 621 hareketi; iade maliyeti düşer; kartsız satır maliyetsiz', async () => {
    const { c } = await books('Karlilik');
    const { by } = await tbRows(c);
    const net = (code: string, side: 'debit' | 'credit') => Number(by[code]?.[side] ?? 0);
    const revenue = net('600', 'credit') - net('600', 'debit');
    const returns = net('610', 'debit') - net('610', 'credit');
    const cogs = net('621', 'debit') - net('621', 'credit');
    const r = await ok(c.get(`/api/reports/item-profitability?from=${day(1, 1)}&to=${day(12, 31)}`));
    expect(Number(r.totals.sales)).toBe(revenue - returns);
    expect(Number(r.totals.cost)).toBe(cogs);
    expect(Number(r.totals.profit)).toBe(revenue - returns - cogs);
    const paint = r.rows.find((x: any) => x.name === 'Dış cephe boyası');
    // 4 satış − 1 iade = 3 ad; maliyet 3 × 50; satış 300
    expect(paint).toMatchObject({ qty: '3.0000', sales: '300.0000', cost: '150.0000', profit: '150.0000', marginPct: '50.00' });
    const services = r.rows.find((x: any) => x.itemId === null);
    expect(services).toMatchObject({ qty: null, cost: '0.0000', sales: '6000.0000' });
    expect(r.rows[0].name).toBe('Kartsız / serbest satırlar'); // en yüksek kâr başta
  });

  it('kambiyo raporu: gerçekleşen kur kârı 646 bakiyesine eşit; iptal edilen hareket rapor dışı', async () => {
    const { c } = await books('Kambiyo');
    const { by } = await tbRows(c);
    const r = await ok(c.get(`/api/reports/fx-differences?from=${day(1, 1)}&to=${day(12, 31)}`));
    // 100 GBP: fatura 4.000 TL, tahsilat 4.500 TL
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ type: 'receipt', gain: '500.0000', loss: '0.0000', net: '500.0000', currencyCode: 'GBP', partyName: 'Sarah Thompson' });
    expect(r.totals).toEqual({ gain: '500.0000', loss: '0.0000', net: '500.0000' });
    // İptal edilen 250 TL'lik kâr ters kayıtla defterde de sıfırlandı: GL = rapor
    expect(Number(by['646']!.credit) - Number(by['646']!.debit)).toBe(500);
    const none = await ok(c.get(`/api/reports/fx-differences?from=${day(1, 1)}&to=${day(8, 31)}`));
    expect(none.rows).toHaveLength(0);
  });

  it('dışa aktarma: xlsx dosyası okunur, sayı ve tarih türleri, dosya adı, CSV biçimi ve rapor içeriği', async () => {
    const { c } = await books('Cikti');
    const { res, sheets } = await xlsx(c, `/api/exports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="mizan-${day(1, 1)}_${day(12, 31)}.xlsx"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const rows = sheets[0]!.rows;
    expect(rows[0]![0]).toBe('Mizan');
    expect(rows[1]![0]).toContain('Deneme İnşaat Ltd.');
    expect(rows[3]).toEqual(['Kod', 'Hesap', 'Açılış (B-A)', 'Dönem Borç', 'Dönem Alacak', 'Bakiye (B-A)']);
    // Tutar sütunları defter para biriminin (TRY) simgeli hücre biçimini taşır; hücreler yine sayıdır
    const tbStyles = new TextDecoder().decode(unzipSync(new Uint8Array(res.rawPayload))['xl/styles.xml']);
    expect(tbStyles).toContain('formatCode="&quot;₺&quot;#,##0.00;[Red]-&quot;₺&quot;#,##0.00"');
    const { by } = await tbRows(c);
    const r120 = rows.find((r) => r[0] === '120')!;
    expect(Number(r120[3])).toBe(Number(by['120']!.debit));
    expect(rows[rows.length - 1]![0]).toBe('Toplam');
    // Yalnızca yaprak hesaplar
    const leaf = await xlsx(c, `/api/exports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&view=accounts`);
    expect(leaf.sheets[0]!.rows.length).toBeLessThan(rows.length);

    // CSV: başlık ilk satır, Türkçe biçim, BOM
    const csv = await c.get(`/api/exports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&format=csv`);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toContain('.csv"');
    expect(csv.body.startsWith('﻿"Kod";"Hesap";"Açılış (B-A)"')).toBe(true);
    expect(csv.body).toMatch(/"Toplam"/);

    // Yeni raporlar dosya olarak: yevmiye defteri satır sayısı JSON ile aynı
    const jb = await ok(c.get(`/api/reports/journal-book?from=${day(1, 1)}&to=${day(12, 31)}`));
    const book = await xlsx(c, `/api/exports/journal-book?from=${day(1, 1)}&to=${day(12, 31)}`);
    // başlık 4 satır + veri + toplam satırı
    expect(book.sheets[0]!.rows.length).toBe(4 + jb.total + 1);
    const cell = book.sheets[0]!.rows[4]!;
    expect(cell[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // tarih hücresi ISO'ya çevrilir
    const sr = await xlsx(c, `/api/exports/sales-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=invoice`);
    expect(sr.sheets[0]!.rows[3]).toContain('Fatura no');
    expect(sr.res.headers['content-disposition']).toContain(`satis-raporu-invoice-${day(1, 1)}_${day(12, 31)}.xlsx`);
    const fx = await xlsx(c, `/api/exports/fx-differences?from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(fx.sheets[0]!.rows.some((r) => r.includes('500'))).toBe(true);
    const pr = await xlsx(c, `/api/exports/item-profitability?from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(pr.sheets[0]!.rows.some((r) => r[1] === 'Dış cephe boyası' && r[7] === '50')).toBe(true);
    const gl = await xlsx(c, `/api/exports/general-ledger?from=${day(1, 1)}&to=${day(12, 31)}&codePrefix=1`);
    expect(gl.sheets[0]!.rows.some((r) => r[4] === 'Hesap toplamı / kapanış')).toBe(true);
  });

  it('mevcut raporların dışa aktarması: yaşlandırma, cari ekstre, açık kalemler, stok, KDV, hesap ekstresi', async () => {
    const { c, cust, item, bank } = await books('Mevcut');
    const aging = await xlsx(c, `/api/exports/party-aging?type=receivable&asOf=${day(12, 31)}`);
    expect(aging.sheets[0]!.rows[3]).toEqual(['Cari', 'Vadesi gelmemiş', '1–30 gün', '31–60 gün', '61–90 gün', '90+ gün', 'Avans / fazla ödeme', 'Net bakiye']);
    expect(aging.sheets[0]!.rows.some((r) => r[0]?.includes('Ömer Çakır Ticaret'))).toBe(true);
    expect(aging.res.headers['content-disposition']).toContain(`yaslandirma-alacak-${day(12, 31)}.xlsx`);

    const st = await xlsx(c, `/api/exports/party-statement?partyId=${cust.id}&from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(st.sheets[0]!.rows[1]![0]).toContain('Ömer Çakır Ticaret');
    expect(st.sheets[0]!.rows[4]![2]).toBe('Açılış bakiyesi');
    const open = await xlsx(c, `/api/exports/party-open-items?partyId=${cust.id}&asOf=${day(12, 31)}`);
    expect(open.sheets[0]!.rows.length).toBeGreaterThan(4);

    const stock = await xlsx(c, `/api/exports/stock-status?asOf=${day(12, 31)}`);
    const boya = stock.sheets[0]!.rows.find((r) => r[1] === 'Dış cephe boyası')!;
    expect(boya[3]).toBe('adet'); // birim etiketi
    expect(boya[4]).toBe('7'); // 10 alış − 3 net satış
    const card = await xlsx(c, `/api/exports/item-card?itemId=${item.id}&from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(card.sheets[0]!.rows[card.sheets[0]!.rows.length - 1]![3]).toBe('Kapanış bakiyesi');

    const vat = await xlsx(c, `/api/exports/vat-summary?from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(vat.sheets[0]!.rows[3]).toContain('Ödenecek KDV');
    const ts = await xlsx(c, `/api/exports/treasury-statement?accountId=${bank.id}&from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(ts.sheets[0]!.rows[3]).toContain('Bakiye (TRY)'); // dövizli hesapta defter bakiyesi de var
    const al = await xlsx(c, `/api/exports/account-ledger?accountId=${(await ok(c.get('/api/accounts'))).accounts.find((a: any) => a.code === '120').id}&from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(al.sheets[0]!.rows[1]![0]).toContain('120');
  });

  it('tam veri dışa aktarma: tüm sayfalar, satır sayıları tablolarla aynı, tarih süzgeci yalnızca hareket sayfalarını daraltır', async () => {
    const { c } = await books('Tam');
    const { sheets, res } = await xlsx(c, '/api/exports/full-data');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="tum-veriler-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(sheets.map((s) => s.name)).toEqual(['Cariler', 'Stok kartları', 'Hesap planı', 'Yevmiye satırları', 'Faturalar', 'Fatura satırları', 'İrsaliyeler', 'Satış teklif ve siparişleri', 'Fiyat listeleri', 'Cari özel fiyatlar', 'Seri no sicili', 'İthalat dosyaları', 'Gider fişleri', 'Kasa ve banka hesapları', 'Kasa ve banka hareketleri', 'Stok hareketleri']);
    const by = Object.fromEntries(sheets.map((s) => [s.name, s.rows.slice(4)]));
    expect(by['Cariler']).toHaveLength(3);
    expect(by['Cariler']!.map((r) => r[0]).every((v) => /^CR-/.test(v!))).toBe(true);
    expect(by['Stok kartları']).toHaveLength(1);
    expect(by['Hesap planı']!.length).toBe((await ok(c.get('/api/accounts'))).accounts.length);
    const jb = await ok(c.get(`/api/reports/journal-book?from=1900-01-01&to=2999-12-31`));
    expect(by['Yevmiye satırları']).toHaveLength(jb.total);
    const invoices = (await ok(c.get('/api/invoices?limit=500'))).invoices as any[];
    expect(by['Faturalar']).toHaveLength(invoices.length);
    expect(by['Kasa ve banka hesapları']).toHaveLength(1);
    expect(by['Kasa ve banka hareketleri']).toHaveLength(2); // biri iptal
    expect(by['Kasa ve banka hareketleri']!.map((r) => r[3]).sort()).toEqual(['Kaydedildi', 'İptal']);

    const narrow = await xlsx(c, `/api/exports/full-data?from=${day(4, 1)}&to=${day(4, 30)}`);
    const nb = Object.fromEntries(narrow.sheets.map((s) => [s.name, s.rows.slice(4)]));
    expect(nb['Faturalar']).toHaveLength(2); // Nisan: satış + iade
    expect(nb['Cariler']).toHaveLength(3); // kartlar süzgeçten etkilenmez
    expect(nb['Stok hareketleri']!.length).toBeLessThan(by['Stok hareketleri']!.length);
    // CSV yalnızca tek tablo içindir
    const csv = await c.get('/api/exports/full-data?format=csv');
    expect(csv.statusCode).toBe(400);
    expect(csv.json().error.code).toBe('EXPORT_FORMAT_UNSUPPORTED');
  });

  it('formül enjeksiyonu: "=" ile başlayan cari adı CSV\'de etkisizleştirilir, xlsx\'te metin kalır', async () => {
    const { c } = await setup('Enjeksiyon');
    const evil = '=HYPERLINK("http://kotu.example","tıkla")';
    const party = (await ok(c.post('/api/parties', { name: evil, kind: 'customer' }))).party;
    await ok(c.post('/api/invoices', { post: true, type: 'sales', partyId: party.id, invoiceDate: day(3, 1), lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '100' }] }));
    const sales = await c.get(`/api/exports/sales-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=party&format=csv`);
    // Hiçbir CSV hücresi doğrudan '=', '+' ya da '@' ile başlamamalı
    for (const line of sales.body.split('\r\n')) for (const cell of line.split(';')) expect(cell.replace(/^"/, '')).not.toMatch(/^[=+@]/);
    const { sheets } = await xlsx(c, `/api/exports/party-aging?type=receivable&asOf=${day(12, 31)}`);
    expect(sheets[0]!.rows[4]![0]).toContain(evil); // xlsx'te olduğu gibi, satır içi metin
    // Yevmiye defteri: cari adı ayrı sütunda ve '=' ile başlıyor → CSV'de kesme işaretli
    const book = await c.get(`/api/exports/journal-book?from=${day(1, 1)}&to=${day(12, 31)}&format=csv`);
    expect(book.body).toContain(`"'${evil.replace(/"/g, '""')}"`);
  });

  it('yetkiler: rapor ekranıyla aynı izin ve modül; tam veri yalnızca yetkililere; başka şirketin verisi görünmez', async () => {
    const { c, company, cust } = await books('Yetki');
    const acct = await memberClient(c, company.id, 'accountant');
    const viewer = await memberClient(c, company.id, 'viewer');
    const sales = await memberClient(c, company.id, 'sales');
    const sm = await memberClient(c, company.id, 'site_manager');
    const q = `from=${day(1, 1)}&to=${day(12, 31)}`;

    expect((await acct.get(`/api/exports/full-data`)).statusCode).toBe(200);
    expect((await acct.get(`/api/exports/journal-book?${q}`)).statusCode).toBe(200);
    expect((await c.get(`/api/exports/full-data`)).statusCode).toBe(200);
    // İzleyici raporları alır, tam veriyi almaz
    for (const url of [`trial-balance?${q}`, `journal-book?${q}`, `general-ledger?${q}`, `sales-report?${q}`, `item-profitability?${q}`, `fx-differences?${q}`, `vat-summary?${q}`, `stock-status?asOf=${day(12, 31)}`, `party-aging?asOf=${day(12, 31)}`]) {
      expect((await viewer.get(`/api/exports/${url}`)).statusCode, url).toBe(200);
    }
    expect((await viewer.get('/api/exports/full-data')).statusCode).toBe(403);
    // Satış: cari yaşlandırma (parties.read) evet; mizan/yevmiye defteri/KDV (reports.read) hayır
    expect((await sales.get(`/api/exports/party-aging?asOf=${day(12, 31)}`)).statusCode).toBe(200);
    expect((await sales.get(`/api/exports/party-statement?partyId=${cust.id}&${q}`)).statusCode).toBe(200);
    expect((await sales.get(`/api/exports/trial-balance?${q}`)).statusCode).toBe(403);
    expect((await sales.get(`/api/exports/journal-book?${q}`)).statusCode).toBe(403);
    expect((await sales.get(`/api/exports/sales-report?${q}`)).statusCode).toBe(403);
    expect((await sales.get('/api/exports/full-data')).statusCode).toBe(403);
    // Şantiye sorumlusu: yalnızca stok
    expect((await sm.get(`/api/exports/stock-status?asOf=${day(12, 31)}`)).statusCode).toBe(200);
    expect((await sm.get(`/api/exports/party-aging?asOf=${day(12, 31)}`)).statusCode).toBe(403);
    expect((await sm.get('/api/exports/full-data')).statusCode).toBe(403);
    // Yeni JSON uçları da aynı izinle
    expect((await sales.get(`/api/reports/journal-book?${q}`)).statusCode).toBe(403);
    expect((await sm.get(`/api/reports/fx-differences?${q}`)).statusCode).toBe(403);

    // Kimliksiz ve şirketsiz istek
    expect((await app.inject({ method: 'GET', url: `/api/exports/trial-balance?${q}` })).statusCode).toBe(401);
    // Başka şirketin kullanıcısı bu şirketin dosyasını alamaz; kendi şirketinde bu şirketin cari kimliği bulunamaz
    const other = await setup('Yabanci');
    const cross = await client(app, other.s.token, company.id).get(`/api/exports/trial-balance?${q}`);
    expect(cross.statusCode).toBe(403);
    expect((await other.c.get(`/api/exports/party-statement?partyId=${cust.id}&${q}`)).statusCode).toBe(404);
    const foreignSheets = await xlsx(other.c, '/api/exports/full-data');
    expect(foreignSheets.sheets.find((s) => s.name === 'Cariler')!.rows.slice(4)).toHaveLength(0);
    expect(foreignSheets.sheets.find((s) => s.name === 'Faturalar')!.rows.slice(4)).toHaveLength(0);
  });

  it('doğrulama: tarih biçimi, eksik alan, bilinmeyen biçim ve geçersiz kırılım reddedilir', async () => {
    const { c } = await setup('Dogrula');
    for (const url of ['/api/exports/trial-balance', '/api/exports/trial-balance?from=2026-13-01&to=2026-12-31', `/api/exports/sales-report?from=${day(1, 1)}&to=${day(12, 31)}&groupBy=weekly`, `/api/exports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&format=pdf`, '/api/exports/party-statement?partyId=abc&from=2026-01-01&to=2026-12-31']) {
      const res = await c.get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await c.get('/api/exports/olmayan-rapor')).statusCode).toBe(404);
    // Boş şirkette raporlar boş ama geçerli dosya verir
    const empty = await xlsx(c, `/api/exports/journal-book?from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(empty.sheets[0]!.rows.length).toBe(4 + 1); // başlıklar + boş toplam satırı
    const emptyFx = await ok(c.get(`/api/reports/fx-differences?from=${day(1, 1)}&to=${day(12, 31)}`));
    expect(emptyFx.rows).toEqual([]);
  });
});
