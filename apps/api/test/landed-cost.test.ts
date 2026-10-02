import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { asDb, asOwner, day, expectDbError, makeApp, thisYear } from './helpers';
import { x2Kit } from './x2-helpers';

/**
 * İthalat maliyet dağıtımı (Faz X4). Tutarlar kullanıcı girişidir; hesap eşlemesi (632 aktarım hesabı) DOĞRULANMAMIŞ varsayılandır:
 * bu testler davranışı (dağıtım aritmetiği, stok maliyeti, yevmiye dengesi, korumalar) sınar, yasal doğruluğu değil.
 */
describe('ithalat maliyet dağıtımı (Faz X4)', async () => {
  const { app, handle } = await makeApp();
  const k = x2Kit(app);

  /** Tedarikçiden iki stoklu kart alınır: A 10 × 100 = 1000, B 5 × 100 = 500 (aynı fatura). */
  async function world(name: string) {
    const ctx = await k.setup(name);
    const { c } = ctx;
    const sup = await k.mkParty(c, 'Dış Ticaret Ltd.', 'supplier');
    const forwarder = await k.mkParty(c, 'Nakliyat A.Ş.', 'supplier');
    const itemA = await k.mkItem(c, 'Seramik');
    const itemB = await k.mkItem(c, 'Fayans');
    const inv = await k.invPosted(c, {
      type: 'purchase', partyId: sup.id, invoiceDate: day(3, 2), externalNo: 'TF-1', warehouseId: ctx.main.id,
      lines: [k.invLine(itemA.id, '10', '100'), k.invLine(itemB.id, '5', '100')],
    });
    const ok = async (r: Promise<{ statusCode: number; body: string; json: () => any }>, code = 200) => {
      const res = await r;
      if (res.statusCode !== code) throw new Error(`beklenen ${code}, gelen ${res.statusCode}: ${res.body}`);
      return res.json();
    };
    const sources = async () => (await ok(c.get('/api/import-files/sources'))).sources as any[];
    const src = async (itemId: string) => (await sources()).find((s) => s.itemId === itemId)!;
    const save = async (body: Record<string, unknown>, id?: string, code = id ? 200 : 201) =>
      ok(id ? c.put(`/api/import-files/${id}`, body) : c.post('/api/import-files', body), code);
    const cost = (kind: string, amount: string, extra: Record<string, unknown> = {}) => ({ kind, description: `${kind} gideri`, amount, ...extra });
    /** A ve B satırlarıyla dosya: navlun 150 (miktara), gümrük vergisi 300 (değere). */
    async function twoLineFile(extra: Record<string, unknown> = {}, costLines?: unknown[]) {
      const a = await src(itemA.id);
      const b = await src(itemB.id);
      return save({
        name: 'Çin sevkiyatı', reference: 'BEYAN-1', fileDate: day(3, 10), method: 'value',
        lines: [{ sourceKind: 'invoice', sourceLineId: a.sourceLineId, weight: '50' }, { sourceKind: 'invoice', sourceLineId: b.sourceLineId, weight: '10' }],
        costLines: costLines ?? [cost('freight', '150', { method: 'quantity', partyId: forwarder.id }), cost('customs_duty', '300')],
        ...extra,
      });
    }
    const alloc = (id: string, body: Record<string, unknown> = {}) => c.post(`/api/import-files/${id}/allocate`, body);
    const post = (id: string, date = day(3, 15)) => c.post(`/api/import-files/${id}/post`, { date });
    const get = async (id: string) => ok(c.get(`/api/import-files/${id}`));
    const stockOf = async (itemId: string) => k.stockInfo(c, itemId);
    return { ...ctx, sup, forwarder, itemA, itemB, inv, ok, sources, src, save, cost, twoLineFile, alloc, post, get, stockOf };
  }

  const amountMap = (d: any) => {
    const lineNo = new Map(d.lines.map((l: any) => [l.id, l.lineNo]));
    const costNo = new Map(d.costLines.map((x: any) => [x.id, x.lineNo]));
    return Object.fromEntries(d.allocations.map((a: any) => [`${costNo.get(a.costLineId)}:${lineNo.get(a.fileLineId)}`, a.amount]));
  };

  it('kaynak satırlar: kayıtlı alış faturasının stoklu satırları listelenir, değer stok defterinden gelir, kullanılan satır çıkar', async () => {
    const w = await world('IthKaynak');
    const list = await w.sources();
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.itemId === w.itemA.id)).toMatchObject({ kind: 'invoice', quantity: '10.0000', value: '1000.0000', docNo: w.inv.invoice.invoiceNo, usedIn: null });
    // Taslak (kaydedilmemiş) fatura ve satış faturası aday değildir
    const draft = await w.c.post('/api/invoices', { type: 'purchase', partyId: w.sup.id, invoiceDate: day(3, 3), externalNo: 'TF-2', lines: [k.invLine(w.itemA.id, '1', '10')] });
    expect(draft.statusCode).toBe(201);
    expect(await w.sources()).toHaveLength(2);
    const f = await w.twoLineFile();
    expect(f.file.code).toBe(`ITH-${thisYear}-000001`);
    expect(await w.sources()).toHaveLength(0);
    // Aynı satır ikinci dosyaya alınamaz
    const a = w.inv.lines[0];
    const dup = await w.c.post('/api/import-files', { name: 'x', fileDate: day(3, 11), lines: [{ sourceKind: 'invoice', sourceLineId: a.id }] });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error.code).toBe('IMPORT_SOURCE_IN_USE');
  });

  it('değere/miktara göre dağıtım, birim maliyet öncesi/sonrası, kayıt: stok değeri artar, yevmiye dengeli, stok mutabakatı sıfır', async () => {
    const x = await world('IthKayit');
    const { c } = x;
    const f = await x.twoLineFile();
    expect(f.file.status).toBe('draft');
    expect(f.totals).toEqual({ goodsValue: '1500.0000', costTotal: '450.0000', landedValue: '1950.0000' });
    const al = await x.ok(x.alloc(f.file.id));
    expect(al.file.status).toBe('allocated');
    // navlun 150 miktara göre (10:5): 100/50; gümrük 300 değere göre (1000:500): 200/100
    expect(amountMap(al)).toEqual({ '1:1': '100.0000', '1:2': '50.0000', '2:1': '200.0000', '2:2': '100.0000' });
    const rep = await x.ok(c.get(`/api/import-files/${f.file.id}/report`));
    const a = rep.byItem.find((i: any) => i.itemId === x.itemA.id);
    expect(a).toMatchObject({ quantity: '10.0000', goodsValue: '1000.0000', allocated: '300.0000', landedValue: '1300.0000', unitBefore: '100.0000', unitAfter: '130.0000' });
    expect(rep.byItem.find((i: any) => i.itemId === x.itemB.id)).toMatchObject({ allocated: '150.0000', unitBefore: '100.0000', unitAfter: '130.0000' });
    expect(rep.byCost.map((r: any) => [r.kind, r.amount])).toEqual([['freight', '150.0000'], ['customs_duty', '300.0000']]);
    expect(rep.totals.allocated).toBe('450.0000');

    const before = await x.stockOf(x.itemA.id);
    expect(before).toMatchObject({ qty: '10.0000', value: '1000.0000' });
    const posted = await x.ok(x.post(f.file.id));
    expect(posted.file).toMatchObject({ status: 'posted', postDate: day(3, 15) });
    expect(posted.file.journalEntryNo).toBeTruthy();
    expect(posted.file.stockDocumentNo).toBeTruthy();
    // Miktar değişmez, değer artar
    expect(await x.stockOf(x.itemA.id)).toMatchObject({ qty: '10.0000', value: '1300.0000' });
    expect(await x.stockOf(x.itemB.id)).toMatchObject({ qty: '5.0000', value: '650.0000' });
    // Yevmiye: B 150 450 / A 632 450 (varsayılan aktarım hesabı); dengeli
    const je = await k.journalOf(c, posted.file.journalEntryId);
    expect(je.byCode('150')).toEqual([['150', 450, 0]]);
    expect(je.byCode('632')).toEqual([['632', 0, 450]]);
    expect(je.entry.status).toBe('posted');
    // Stok defteri ↔ muhasebe mutabakatı sıfır
    expect(await k.recon(c)).toMatchObject({ difference: '0.0000' });
    // Satır payı bölünmesi: tamamı stokta
    expect(posted.lines.map((l: any) => [l.stockedAmount, l.cogsAmount])).toEqual([['300.0000', '0.0000'], ['150.0000', '0.0000']]);
    // Geçmiş: oluşturma, kaydetme yok, dağıtım, kayıt
    expect(posted.events.map((e: any) => e.action)).toEqual(['created', 'allocated', 'posted']);
    // Muhasebeleşen dosya değiştirilemez
    const edit = await c.put(`/api/import-files/${f.file.id}`, { name: 'y', fileDate: day(3, 10), lines: [], costLines: [] });
    expect(edit.statusCode).toBe(422);
    expect(edit.json().error.code).toBe('IMPORT_NOT_DRAFT');
  });

  it('ağırlığa göre ve elle dağıtım; kuruş yuvarlaması son satırda toplanır', async () => {
    const x = await world('IthYontem');
    const f = await x.twoLineFile({}, [x.cost('freight', '100', { method: 'weight' }), x.cost('insurance', '10', { method: 'quantity' }), x.cost('other', '100', { method: 'manual' })]);
    const manual = { '3': { '1': '70', '2': '30' } };
    const al = await x.ok(x.alloc(f.file.id, { manual }));
    // ağırlık 50:10 → 83.33 / 16.67; miktar 10:5 → 6.67 / 3.33; elle 70/30
    expect(amountMap(al)).toEqual({ '1:1': '83.3300', '1:2': '16.6700', '2:1': '6.6700', '2:2': '3.3300', '3:1': '70.0000', '3:2': '30.0000' });
    for (const [no, total] of [[1, 100], [2, 10], [3, 100]] as const) {
      const sum = Object.entries(amountMap(al)).filter(([key]) => key.startsWith(`${no}:`)).reduce((s, [, v]) => s + Number(v), 0);
      expect(Math.round(sum * 100) / 100).toBe(total);
    }
    // Üç eşit satır: 33.33 + 33.33 + 33.34
    const y = await world('IthKurus');
    const inv3 = await k.invPosted(y.c, { type: 'purchase', partyId: y.sup.id, invoiceDate: day(3, 3), externalNo: 'TF-3', warehouseId: y.main.id, lines: [k.invLine(y.itemA.id, '1', '10'), k.invLine(y.itemA.id, '1', '10'), k.invLine(y.itemA.id, '1', '10')] });
    const f3 = await y.save({ name: 'üç', fileDate: day(3, 10), method: 'quantity', lines: inv3.lines.map((l: any) => ({ sourceKind: 'invoice', sourceLineId: l.id })), costLines: [y.cost('freight', '100')] });
    const al3 = await y.ok(y.alloc(f3.file.id));
    expect(Object.values(amountMap(al3))).toEqual(['33.3300', '33.3300', '33.3400']);
  });

  it('dağıtım hataları: ağırlık eksik, elle toplam tutmaz, taban sıfır; boş dosya dağıtılamaz', async () => {
    const x = await world('IthHata');
    const f = await x.twoLineFile({}, [x.cost('freight', '100', { method: 'weight' })]);
    // ağırlığı sil: yeniden kaydet
    expect((await x.sources()).find((r) => r.itemId === x.itemA.id)).toBeUndefined(); // dosyadaki satırlar artık aday değil
    const line = f.lines.map((l: any) => ({ sourceKind: l.sourceKind, sourceLineId: l.sourceLineId, weight: l.lineNo === 1 ? null : l.weight }));
    const g = await x.save({ name: 'w', fileDate: day(3, 10), method: 'weight', lines: line, costLines: [x.cost('freight', '100', { method: 'weight' })] }, f.file.id);
    const r1 = await x.alloc(g.file.id);
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error.code).toBe('IMPORT_ALLOC_WEIGHT_MISSING');
    const h = await x.save({ name: 'm', fileDate: day(3, 10), method: 'manual', lines: line, costLines: [x.cost('freight', '100')] }, f.file.id);
    const r2 = await x.alloc(h.file.id, { manual: { '1': { '1': '60', '2': '30' } } });
    expect(r2.statusCode).toBe(422);
    expect(r2.json().error.code).toBe('IMPORT_ALLOC_MANUAL_MISMATCH');
    const empty = await x.save({ name: 'boş', fileDate: day(3, 10), lines: [], costLines: [] });
    const r3 = await x.alloc(empty.file.id);
    expect(r3.statusCode).toBe(422);
    expect(r3.json().error.code).toBe('IMPORT_NO_LINES');
  });

  it('yabancı para maliyeti verilen kurla çevrilir; kur yoksa kayıtlı kur; kaydedilir', async () => {
    const x = await world('IthKur');
    const f = await x.twoLineFile({}, [x.cost('freight', '5', { currencyCode: 'GBP', fxRate: '40' })]);
    expect(f.costLines[0]).toMatchObject({ currencyCode: 'GBP', amount: '5.0000', fxRate: '40.00000000', amountBase: '200.0000' });
    expect(f.totals.costTotal).toBe('200.0000');
    // Kur verilmeden ve kayıtlı kur yokken hata; kayıtlı kur girilince o kur kullanılır
    const noRate = await x.c.put(`/api/import-files/${f.file.id}`, { name: 'k', fileDate: day(3, 10), lines: [], costLines: [x.cost('freight', '5', { currencyCode: 'EUR' })] });
    expect(noRate.statusCode).toBe(422);
    expect(noRate.json().error.code).toBe('FX_RATE_MISSING');
    await x.ok(x.c.put('/api/exchange-rates', { rateDate: day(3, 10), currencyCode: 'EUR', quoteCode: 'TRY', buy: '36' }));
    const ok = await x.save({ name: 'k', fileDate: day(3, 10), lines: f.lines.map((l: any) => ({ sourceKind: l.sourceKind, sourceLineId: l.sourceLineId })), costLines: [x.cost('freight', '5', { currencyCode: 'EUR' })] }, f.file.id);
    expect(ok.costLines[0].amountBase).toBe('180.0000');
    await x.ok(x.alloc(ok.file.id));
    const posted = await x.ok(x.post(ok.file.id));
    expect(posted.file.status).toBe('posted');
    expect((await k.journalOf(x.c, posted.file.journalEntryId)).byCode('150')).toEqual([['150', 180, 0]]);
  });

  it('satılmış mal: payın elde kalan miktara düşen kısmı stoğa, kalanı satılan mal maliyetine (621) gider', async () => {
    const x = await world('IthSatilmis');
    // A'dan 4 adet sat (sarf): eldeki 6
    const cust = await k.mkParty(x.c, 'Müşteri');
    await k.invPosted(x.c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 5), warehouseId: x.main.id, lines: [k.invLine(x.itemA.id, '4', '200')] });
    expect(await x.stockOf(x.itemA.id)).toMatchObject({ qty: '6.0000', value: '600.0000' });
    const a = await x.src(x.itemA.id);
    const f = await x.save({ name: 'k', fileDate: day(3, 10), lines: [{ sourceKind: 'invoice', sourceLineId: a.sourceLineId }], costLines: [x.cost('customs_duty', '100')] });
    await x.ok(x.alloc(f.file.id));
    const p = await x.ok(x.post(f.file.id));
    expect(p.lines[0]).toMatchObject({ stockedAmount: '60.0000', cogsAmount: '40.0000' });
    expect(await x.stockOf(x.itemA.id)).toMatchObject({ qty: '6.0000', value: '660.0000' });
    const je = await k.journalOf(x.c, p.file.journalEntryId);
    expect(je.byCode('150')).toEqual([['150', 60, 0]]);
    expect(je.byCode('621')).toEqual([['621', 40, 0]]);
    expect(je.byCode('632')).toEqual([['632', 0, 100]]);
    expect(await k.recon(x.c)).toMatchObject({ difference: '0.0000' });
  });

  it('iptal: stok ve yevmiye ters çevrilir, satırlar serbest kalır; sonradan hareket varsa engellenir', async () => {
    const x = await world('IthIptal');
    const f = await x.twoLineFile();
    await x.ok(x.alloc(f.file.id));
    await x.ok(x.post(f.file.id));
    const bad = await x.c.post(`/api/import-files/${f.file.id}/cancel`, { reason: '' });
    expect(bad.statusCode).toBe(400);
    const cancelled = await x.ok(x.c.post(`/api/import-files/${f.file.id}/cancel`, { reason: 'Yanlış beyan', date: day(3, 20) }));
    expect(cancelled.file).toMatchObject({ status: 'cancelled', cancelReason: 'Yanlış beyan' });
    expect(cancelled.file.cancelJournalEntryNo).toBeTruthy();
    expect(await x.stockOf(x.itemA.id)).toMatchObject({ qty: '10.0000', value: '1000.0000' });
    expect((await k.journalOf(x.c, cancelled.file.cancelJournalEntryId)).byCode('150')).toEqual([['150', 0, 450]]);
    expect(await k.recon(x.c)).toMatchObject({ difference: '0.0000' });
    expect(cancelled.events.map((e: any) => e.action)).toEqual(['created', 'allocated', 'posted', 'cancelled']);
    const again = await x.c.post(`/api/import-files/${f.file.id}/cancel`, { reason: 'tekrar' });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.code).toBe('IMPORT_ALREADY_CANCELLED');
    // Satırlar serbest: yeni dosyaya alınabilir
    expect(await x.sources()).toHaveLength(2);
    const f2 = await x.twoLineFile({ name: 'ikinci' });
    await x.ok(x.alloc(f2.file.id));
    await x.ok(x.post(f2.file.id, day(3, 25)));
    // Kayıttan sonra aynı kartta hareket: iptal engellenir
    const cust = await k.mkParty(x.c, 'Müşteri');
    await k.invPosted(x.c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 27), warehouseId: x.main.id, lines: [k.invLine(x.itemA.id, '1', '200')] });
    const blocked = await x.c.post(`/api/import-files/${f2.file.id}/cancel`, { reason: 'geç', date: day(3, 28) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('IMPORT_CANCEL_BLOCKED');
    expect((await x.get(f2.file.id)).file.status).toBe('posted');
    // Faturayı dosya varken iptal etmek de engellenir (sonradan stok hareketi)
    const invCancel = await x.c.post(`/api/invoices/${x.inv.invoice.id}/cancel`, { reason: 'Hatalı fatura' });
    expect(invCancel.statusCode).toBe(422);
  });

  it('durum kuralları: taslak dışı kaydedilemez, taslak muhasebeleşmez, dağıtım geri alınır, taslak/dağıtılmış iptal edilebilir', async () => {
    const x = await world('IthDurum');
    const f = await x.twoLineFile();
    const early = await x.post(f.file.id);
    expect(early.statusCode).toBe(422);
    expect(early.json().error.code).toBe('IMPORT_NOT_ALLOCATED');
    await x.ok(x.alloc(f.file.id));
    const again = await x.alloc(f.file.id);
    expect(again.json().error.code).toBe('IMPORT_NOT_DRAFT');
    const edit = await x.c.put(`/api/import-files/${f.file.id}`, { name: 'z', fileDate: day(3, 10), lines: [], costLines: [] });
    expect(edit.json().error.code).toBe('IMPORT_NOT_DRAFT');
    const reopened = await x.ok(x.c.post(`/api/import-files/${f.file.id}/reopen`));
    expect(reopened.file.status).toBe('draft');
    expect(reopened.allocations).toHaveLength(0);
    // Yeniden dağıt ve iptal et (muhasebe etkisi yok)
    await x.ok(x.alloc(f.file.id));
    const c1 = await x.ok(x.c.post(`/api/import-files/${f.file.id}/cancel`, { reason: 'vazgeçildi' }));
    expect(c1.file).toMatchObject({ status: 'cancelled', journalEntryId: null, cancelJournalEntryId: null });
    expect(await x.stockOf(x.itemA.id)).toMatchObject({ value: '1000.0000' });
    expect(c1.events.map((e: any) => e.action)).toEqual(['created', 'allocated', 'reopened', 'allocated', 'cancelled']);
    // Kayıt tarihi kaynaktan önce olamaz; kapalı olmayan dönem şartı
    const y = await world('IthTarih');
    const g = await y.twoLineFile();
    await y.ok(y.alloc(g.file.id));
    const early2 = await y.post(g.file.id, day(3, 1));
    expect(early2.statusCode).toBe(422);
    expect(early2.json().error.code).toBe('IMPORT_DATE_BEFORE_SOURCE');
  });

  it('irsaliye kaynağı: alış irsaliyesi satırı dosyaya alınır ve maliyeti artar', async () => {
    const x = await world('IthIrsaliye');
    const item = await k.mkItem(x.c, 'Mermer');
    const dn = await k.posted(x.c, { type: 'purchase', partyId: x.sup.id, noteDate: day(3, 4), externalNo: 'IRS-1', warehouseId: x.main.id, lines: [k.dline(item.id, '4', { unitCost: '25' })] });
    const s = (await x.sources()).find((r) => r.kind === 'delivery')!;
    expect(s).toMatchObject({ itemId: item.id, quantity: '4.0000', value: '100.0000' });
    const f = await x.save({ name: 'irs', fileDate: day(3, 10), lines: [{ sourceKind: 'delivery', sourceLineId: dn.lines[0].id }], costLines: [x.cost('brokerage', '40')] });
    await x.ok(x.alloc(f.file.id));
    await x.ok(x.post(f.file.id));
    expect(await x.stockOf(item.id)).toMatchObject({ qty: '4.0000', value: '140.0000' });
    // İrsaliye dosyadayken iptali engellenir (sonradan stok hareketi)
    const cancel = await x.c.post(`/api/delivery-notes/${dn.note.id}/cancel`, { reason: 'Hatalı irsaliye' });
    expect(cancel.statusCode).toBe(422);
  });

  it('veritabanı korumaları (tablo sahibi olarak): silme, geçiş, dağıtım toplamı, olay, taslak dışı satır, kaynak tekilliği', async () => {
    const x = await world('IthDb');
    const f = await x.twoLineFile();
    const id = f.file.id as string;
    await asOwner(async (q) => {
      expect((await expectDbError(q, `delete from import_files where id = $1`, [id])).code).toBe('ERP18');
      // Olaysız durum geçişi
      expect((await expectDbError(q, `update import_files set status = 'allocated', allocated_at = now() where id = $1`, [id])).code).toBe('ERP18');
    });
    await asOwner(async (q) => {
      expect((await expectDbError(q, `insert into import_file_events (id, company_id, import_file_id, action, from_status, to_status) values (gen_random_uuid(), $1, $2, 'x', 'draft', 'posted')`, [x.company.id, id])).code).toBe('ERP18');
      // Dağıtım yokken (toplam tutmaz) allocated'a geçiş
      await q(`insert into import_file_events (id, company_id, import_file_id, action, from_status, to_status) values (gen_random_uuid(), $1, $2, 'allocated', 'draft', 'allocated')`, [x.company.id, id]);
      const e = await expectDbError(q, `update import_files set status = 'allocated', allocated_at = now() where id = $1`, [id]);
      expect(e.code).toBe('ERP18');
      expect(e.message).toMatch(/toplam/);
    });
    await x.ok(x.alloc(id));
    await asOwner(async (q) => {
      // Dağıtılmış dosyada mal/maliyet satırı değişmez; dağıtım payı değişmez
      expect((await expectDbError(q, `update import_cost_lines set description = 'x' where import_file_id = $1`, [id])).code).toBe('ERP18');
      expect((await expectDbError(q, `delete from import_file_lines where import_file_id = $1`, [id])).code).toBe('ERP18');
      expect((await expectDbError(q, `update import_allocations set amount = 1 where import_file_id = $1`, [id])).code).toBe('ERP18');
      expect((await expectDbError(q, `update import_files set name = 'x' where id = $1`, [id])).code).toBe('ERP18');
      expect((await expectDbError(q, `update import_file_lines set quantity = 1 where import_file_id = $1`, [id])).code).toBe('ERP18');
      // Geçmiş değiştirilemez ve silinemez
      expect((await expectDbError(q, `update import_file_events set note = 'x' where import_file_id = $1`, [id])).code).toBe('ERP18');
      expect((await expectDbError(q, `delete from import_file_events where import_file_id = $1`, [id])).code).toBe('ERP18');
      // Aynı kaynak satır iki aktif dosyada olamaz (kısmi tekil indeks)
      const lines = await q(`select invoice_line_id from import_file_lines where import_file_id = $1 limit 1`, [id]);
      const f2 = await q(`insert into import_files (id, company_id, code, name, file_date) values (gen_random_uuid(), $1, 'ITH-X', 'x', current_date) returning id`, [x.company.id]);
      const e = await expectDbError(q, `insert into import_file_lines (id, company_id, import_file_id, line_no, source_kind, invoice_line_id, item_id, warehouse_id, source_doc_no, source_date, quantity, value_base)
        select gen_random_uuid(), company_id, $2, 1, source_kind, invoice_line_id, item_id, warehouse_id, source_doc_no, source_date, quantity, value_base from import_file_lines where import_file_id = $1 limit 1`, [id, f2.rows[0].id]);
      expect(e.code).toBe('23505');
      expect(lines.rows[0].invoice_line_id).toBeTruthy();
    });
    // Muhasebeleşme: satır payı eksik/yanlışsa geçiş reddedilir (kayıt payları yazılmadan)
    await asOwner(async (q) => {
      await q(`insert into import_file_events (id, company_id, import_file_id, action, from_status, to_status) values (gen_random_uuid(), $1, $2, 'posted', 'allocated', 'posted')`, [x.company.id, id]);
      const e = await expectDbError(q, `update import_files set status = 'posted', post_date = current_date, posted_at = now(), journal_entry_id = (select id from journal_entries where company_id = $1 limit 1) where id = $2`, [x.company.id, id]);
      expect(e.code).toBe('ERP18');
      expect(e.message).toMatch(/Satır payı/);
    });
  });

  it('RLS: başka şirket dosyayı göremez; yetkiler: izleyici okur, satış temsilcisi taslak hazırlar ama kaydedemez, muhasebeci hepsi', async () => {
    const x = await world('IthYetki');
    const f = await x.twoLineFile();
    const other = await k.setup('IthBaska');
    expect((await other.c.get(`/api/import-files/${f.file.id}`)).statusCode).toBe(404);
    expect((await other.c.get('/api/import-files')).json().files).toHaveLength(0);
    await asDb(handle, { companyId: other.company.id }, async (q) => {
      expect((await q(`select count(*)::int as n from import_files`)).rows[0].n).toBe(0);
      expect((await q(`select count(*)::int as n from import_file_lines`)).rows[0].n).toBe(0);
    });
    const viewer = await k.memberClient(x.c, x.company.id, 'viewer');
    expect((await viewer.get('/api/import-files')).statusCode).toBe(200);
    expect((await viewer.post('/api/import-files', { name: 'v', fileDate: day(3, 10) })).statusCode).toBe(403);
    const sales = await k.memberClient(x.c, x.company.id, 'sales');
    const draft = await sales.post('/api/import-files', { name: 's', fileDate: day(3, 10) });
    expect(draft.statusCode).toBe(201);
    await x.ok(x.alloc(f.file.id));
    expect((await sales.post(`/api/import-files/${f.file.id}/post`, { date: day(3, 15) })).statusCode).toBe(403);
    expect((await sales.post(`/api/import-files/${f.file.id}/cancel`, { reason: 'x' })).statusCode).toBe(403);
    const acc = await k.memberClient(x.c, x.company.id, 'accountant');
    expect((await acc.post(`/api/import-files/${f.file.id}/post`, { date: day(3, 15) })).statusCode).toBe(200);
    // Modül kapalıyken uçlar kapanır
    expect((await x.c.put('/api/company/modules/inventory.imports', { enabled: false })).statusCode).toBe(200);
    expect((await x.c.get('/api/import-files')).statusCode).toBe(403);
  });

  it('eşleme: import_cost_clearing varsayılan 632 ve Ayarlar’dan değişir; eksikse açık hata', async () => {
    const x = await world('IthEsleme');
    const m = (await x.ok(x.c.get('/api/account-mappings'))).mappings.find((r: any) => r.key === 'import_cost_clearing');
    expect(m.accountCode).toBe('632');
    const f = await x.twoLineFile();
    await x.ok(x.alloc(f.file.id));
    await asOwnerExec(`delete from account_mappings where company_id = $1 and key = 'import_cost_clearing'`, [x.company.id]);
    const r = await x.post(f.file.id);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('ACCOUNT_MAPPING_MISSING');
    // Ayarlar'dan başka hesaba eşlenince kayıt yapılır ve alacak o hesaba gider
    await x.ok(x.c.put('/api/account-mappings', { mappings: { import_cost_clearing: x.ids['740'] } }));
    const p = await x.ok(x.post(f.file.id));
    expect((await k.journalOf(x.c, p.file.journalEntryId)).byCode('740')).toEqual([['740', 0, 450]]);
  });

  it('maliyet kaleminde alacak hesabı seçilirse eşleme yerine o hesap kullanılır; cari kontrol hesabı reddedilir', async () => {
    const x = await world('IthHesap');
    const a = await x.src(x.itemA.id);
    const bad = await x.c.post('/api/import-files', { name: 'h', fileDate: day(3, 10), lines: [{ sourceKind: 'invoice', sourceLineId: a.sourceLineId }], costLines: [x.cost('freight', '90', { creditAccountId: x.ids['320'] })] });
    expect(bad.statusCode).toBe(422);
    const f = await x.save({ name: 'h', fileDate: day(3, 10), lines: [{ sourceKind: 'invoice', sourceLineId: a.sourceLineId }], costLines: [x.cost('freight', '90', { creditAccountId: x.ids['770'] }), x.cost('other', '10')] });
    await x.ok(x.alloc(f.file.id));
    const p = await x.ok(x.post(f.file.id));
    const je = await k.journalOf(x.c, p.file.journalEntryId);
    expect(je.byCode('770')).toEqual([['770', 0, 90]]);
    expect(je.byCode('632')).toEqual([['632', 0, 10]]);
    expect(je.byCode('150')).toEqual([['150', 100, 0]]);
    expect(je.lines.reduce((s: number, l: readonly [string, number, number]) => s + l[1] - l[2], 0)).toBe(0);
  });

  it('dışa aktarma ve yazdırma verisi: dosya raporu ve dosya listesi xlsx/csv', async () => {
    const x = await world('IthExport');
    const f = await x.twoLineFile();
    await x.ok(x.alloc(f.file.id));
    await x.ok(x.post(f.file.id));
    const res = await x.c.get(`/api/exports/import-file-report?id=${f.file.id}&format=xlsx`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/ithalat-maliyet-\d{4}-\d{2}-\d{2}\.xlsx/);
    const sheets = readXlsx(new Uint8Array(res.rawPayload));
    expect(sheets.map((s) => s.name)).toEqual(['Satırlar', 'Kartlar', 'Maliyet türleri']);
    const lines = sheets[0]!.rows.slice(4);
    expect(lines).toHaveLength(3); // 2 satır + toplam
    const csv = await x.c.get(`/api/exports/import-file-report?id=${f.file.id}&format=csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('Seramik');
    const list = await x.c.get('/api/exports/import-files?format=csv');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(f.file.code);
    const byItem = await x.ok(x.c.get('/api/import-files/reports/by-item'));
    expect(byItem.items).toHaveLength(2);
    expect(byItem.items.find((i: any) => i.itemCode === x.itemA.code)).toMatchObject({ fileCount: 1, allocated: '300.0000', unitBefore: '100.0000', unitAfter: '130.0000' });
    const itemX = await x.c.get('/api/exports/import-landed-items?format=csv');
    expect(itemX.statusCode).toBe(200);
  });
});

async function asOwnerExec(sql: string, params: unknown[]) {
  const { execAsOwner } = await import('./helpers');
  return execAsOwner(sql, params);
}
