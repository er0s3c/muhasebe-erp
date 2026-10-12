import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asDb, asOwner, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser, TODAY_LOCAL } from './helpers';

/**
 * Rehber, ajanda ve görüşme notları (Faz X6). Rehber üçüncü kişilerin kişisel verisini tutar; testler gizlilik kurallarını
 * (not görünürlüğü, silme yasağı, anonimleştirme, günlüklü dışa aktarma) ve işlevleri sınar. Hukuki dayanaklar doğrulanmamıştır.
 */
const TODAY = TODAY_LOCAL;
const plus = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('rehber, ajanda ve görüşme notları (Faz X6)', async () => {
  const { app, handle } = await makeApp();

  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => {
    const res = await p;
    if (res.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, { sector: 'CONSTRUCTION' });
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const org = async (body: Record<string, unknown> = {}) => (await ok(c.post('/api/directory/organizations', { name: 'Örnek Bankası', category: 'Banka', ...body }), 201)).organization;
    const contact = async (body: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/directory/contacts', { fullName: 'Ahmet Yılmaz', phone: '0392 222 00 00', email: 'ahmet@ornek.com', ...body }), 201)).contact as Record<string, any>;
    return { s, company, c, orgId, org, contact };
  }

  it('kurum ve kişi açılır, aranır, etiketle süzülür; kişisel veri alanları kimlik/doğum tarihi içermez', async () => {
    const w = await world('RehberTemel');
    const o = await w.org();
    expect(o).toMatchObject({ name: 'Örnek Bankası', category: 'Banka', isArchived: false });
    const a = await w.contact({ organizationId: o.id, title: 'Şube müdürü', tags: ['Banka', 'banka', ' kredi '] });
    expect(a).toMatchObject({ fullName: 'Ahmet Yılmaz', organizationName: 'Örnek Bankası', tags: ['Banka', 'kredi'] });
    // Kimlik no / doğum tarihi alanı yok; gönderilse bile saklanmaz
    const extra = await w.c.post('/api/directory/contacts', { fullName: 'Fazla Alan', idNumber: '12345678901', birthDate: '1990-01-01' });
    expect(extra.statusCode).toBe(201);
    expect(JSON.stringify(extra.json())).not.toContain('12345678901');
    const cols = (await execAsOwner(`select column_name from information_schema.columns where table_name = 'directory_contacts'`)).rows.map((r) => r.column_name as string);
    expect(cols.some((c) => /id_?number|birth|national|tckn|iban/i.test(c))).toBe(false);

    await w.contact({ fullName: 'İsmail Çelik', phone: '0533 999 88 77', email: 'ismail@ornek.com', tags: ['usta'] });
    const all = (await ok(w.c.get('/api/directory/contacts'))).contacts as any[];
    expect(all.map((x) => x.fullName)).toEqual(['Ahmet Yılmaz', 'Fazla Alan', 'İsmail Çelik']);
    expect((await ok(w.c.get('/api/directory/contacts?q=ismail'))).contacts).toHaveLength(1); // Türkçe İ/i
    expect((await ok(w.c.get('/api/directory/contacts?q=999'))).contacts).toHaveLength(1);
    expect((await ok(w.c.get('/api/directory/contacts?tag=USTA'))).contacts).toHaveLength(1);
    expect((await ok(w.c.get(`/api/directory/contacts?organizationId=${o.id}`))).contacts).toHaveLength(1);
    expect((await ok(w.c.get('/api/directory/contacts/tags'))).tags).toEqual(['Banka', 'kredi', 'usta']);
    expect((await ok(w.c.get('/api/directory/organizations?q=banka'))).organizations[0]).toMatchObject({ contactCount: 1 });

    // Güncelle
    const upd = await ok(w.c.patch(`/api/directory/contacts/${a.id}`, { title: 'Müdür', phone2: '0533 000 00 00' }));
    expect(upd.contact).toMatchObject({ title: 'Müdür', phone2: '0533 000 00 00' });
    expect((await w.c.post('/api/directory/contacts', { fullName: 'A' })).statusCode).toBe(400);
    expect((await w.c.post('/api/directory/contacts', { fullName: 'Yanlış Kurum', organizationId: '019a0000-0000-7000-8000-000000000000' })).statusCode).toBe(404);
  });

  it('yinelenen kişi ipucu: aynı telefon (biçimden bağımsız) ya da e-posta; engellemez', async () => {
    const w = await world('RehberDup');
    const a = await w.contact({ fullName: 'Birinci', phone: '+90 392 222 00 00', email: 'Ortak@Ornek.com' });
    const r = await ok(w.c.post('/api/directory/contacts', { fullName: 'İkinci', phone: '0392-222-00-00', email: 'baska@ornek.com' }), 201);
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0]).toMatchObject({ id: a.id, matchedOn: 'phone' });
    const r2 = await ok(w.c.post('/api/directory/contacts', { fullName: 'Üçüncü', email: 'ortak@ornek.com' }), 201);
    expect(r2.duplicates.map((d: any) => d.id)).toContain(a.id);
    const none = await ok(w.c.post('/api/directory/contacts', { fullName: 'Tekil', phone: '0555 111 22 33' }), 201);
    expect(none.duplicates).toEqual([]);
    const probe = await ok(w.c.get('/api/directory/contacts/duplicates?phone=3922220000&excludeId=' + a.id));
    expect(probe.duplicates.map((d: any) => d.fullName).sort()).toEqual(['İkinci']);
    // Kısa telefon eşlenmez
    expect((await ok(w.c.get('/api/directory/contacts/duplicates?phone=123'))).duplicates).toEqual([]);
  });

  it('birleştirme: veriler taşınır, notlar/ajanda yeniden bağlanır, kaynak arşivlenir ve temizlenir; kısıtlar', async () => {
    const w = await world('RehberMerge');
    const keep = await w.contact({ fullName: 'Asıl Kişi', phone: '0392 111 11 11', email: null, tags: ['a'] });
    const drop = await w.contact({ fullName: 'Kopya Kişi', phone: '0392 222 22 22', email: 'kopya@ornek.com', address: 'Lefkoşa', tags: ['b'] });
    const n1 = (await ok(w.c.post('/api/directory/notes', { contactId: drop.id, kind: 'call', noteDate: TODAY, summary: 'Kopyaya not', visibility: 'private' }), 201)).note;
    await ok(w.c.post('/api/agenda', { title: 'Kopyayı ara', dueDate: TODAY, contactId: drop.id }), 201);
    const m = await ok(w.c.post(`/api/directory/contacts/${keep.id}/merge`, { mergeId: drop.id }));
    expect(m.contact).toMatchObject({ fullName: 'Asıl Kişi', phone: '0392 111 11 11', phone2: '0392 222 22 22', email: 'kopya@ornek.com', address: 'Lefkoşa', tags: ['a', 'b'] });
    expect(m.movedNotes).toBe(1);
    const dropAfter = (await ok(w.c.get(`/api/directory/contacts/${drop.id}`))).contact;
    expect(dropAfter).toMatchObject({ isArchived: true, mergedIntoId: keep.id, phone: null, email: null, address: null });
    expect((await ok(w.c.get(`/api/directory/notes?contactId=${keep.id}`))).notes.map((n: any) => n.id)).toEqual([n1.id]);
    expect((await ok(w.c.get(`/api/agenda?contactId=${keep.id}&scope=all`))).items).toHaveLength(1);
    // Birleştirilmiş kişi değişmez, ona not yazılamaz, yeniden etkinleştirilemez, tekrar birleştirilemez
    expect((await w.c.patch(`/api/directory/contacts/${drop.id}`, { title: 'x' })).statusCode).toBe(422);
    expect((await w.c.post('/api/directory/notes', { contactId: drop.id, kind: 'call', noteDate: TODAY, summary: 'x' })).statusCode).toBe(422);
    expect((await w.c.post(`/api/directory/contacts/${drop.id}/unarchive`)).statusCode).toBe(422);
    expect((await w.c.post(`/api/directory/contacts/${keep.id}/merge`, { mergeId: drop.id })).statusCode).toBe(422);
    expect((await w.c.post(`/api/directory/contacts/${keep.id}/merge`, { mergeId: keep.id })).statusCode).toBe(422);
    // İki farklı cariye bağlı kişiler birleştirilemez
    const p1 = (await ok(w.c.post('/api/parties', { name: 'Cari Bir', kind: 'customer' }), 201)).party;
    const p2 = (await ok(w.c.post('/api/parties', { name: 'Cari İki', kind: 'customer' }), 201)).party;
    const x = await w.contact({ fullName: 'Bağlı Bir', partyId: p1.id, phone: null, email: null });
    const y = await w.contact({ fullName: 'Bağlı İki', partyId: p2.id, phone: null, email: null });
    const bad = await w.c.post(`/api/directory/contacts/${x.id}/merge`, { mergeId: y.id });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('DIRECTORY_MERGE_CONFLICT');
  });

  it('silme yok: arşivle/geri al; sahip rolüyle ham SQL bile silemez; birleştirme/anonimleştirme yalnızca işlevlerle', async () => {
    const w = await world('RehberArsiv');
    const o = await w.org();
    const a = await w.contact({ organizationId: o.id });
    const arch = await ok(w.c.post(`/api/directory/contacts/${a.id}/archive`));
    expect(arch.contact.isArchived).toBe(true);
    expect((await ok(w.c.get('/api/directory/contacts'))).contacts).toHaveLength(0);
    expect((await ok(w.c.get('/api/directory/contacts?archived=archived'))).contacts).toHaveLength(1);
    expect((await ok(w.c.post(`/api/directory/contacts/${a.id}/unarchive`))).contact.isArchived).toBe(false);
    expect((await ok(w.c.post(`/api/directory/organizations/${o.id}/archive`))).organization.isArchived).toBe(true);
    expect((await ok(w.c.get('/api/directory/organizations'))).organizations).toHaveLength(0);
    const note = (await ok(w.c.post('/api/directory/notes', { contactId: a.id, kind: 'meeting', noteDate: TODAY, summary: 'Toplantı' }), 201)).note;
    const item = (await ok(w.c.post('/api/agenda', { title: 'Görev', dueDate: TODAY }), 201)).item;

    await asOwner(async (q) => {
      for (const [table, id] of [['directory_contacts', a.id], ['directory_organizations', o.id], ['directory_notes', note.id], ['agenda_items', item.id]] as const) {
        const err = await expectDbError(q, `delete from ${table} where id = $1`, [id]);
        expect(err.code, table).toBe('ERP21');
      }
      // Anonimleştirme/birleştirme alanları doğrudan yazılamaz
      let err = await expectDbError(q, `update directory_contacts set is_archived = true, archived_at = now(), anonymized_at = now(), anonymize_reason = 'x' where id = $1`, [a.id]);
      expect(err.code).toBe('ERP21');
      err = await expectDbError(q, `update directory_contacts set is_archived = true, archived_at = now(), merged_into_id = id where id = $1`, [a.id]);
      expect(err.code).toBe('ERP21');
      // Not metni anonimleştirme dışında başkası adına değişmez; yazar değişmez
      err = await expectDbError(q, `update directory_notes set author_id = company_id where id = $1`, [note.id]);
      expect(['ERP21', '23503']).toContain(err.code);
    });
    // Başka şirket (RLS): hiçbir şey görünmez
    const other = await world('RehberBaska');
    await asDb(handle, { companyId: other.company.id, orgId: other.orgId, userId: other.s.userId }, async (q) => {
      for (const t of ['directory_contacts', 'directory_organizations', 'directory_notes', 'agenda_items']) expect((await q(`select count(*)::int as n from ${t}`)).rows[0].n, t).toBe(0);
    });
    expect((await other.c.get(`/api/directory/contacts/${a.id}`)).statusCode).toBe(404);
  });

  it('görüşme notu görünürlüğü: özel not yalnızca yazarına (sahip dahil başkasına değil), paylaşılan not herkese; veritabanı politikası', async () => {
    const w = await world('RehberNot');
    const acct = await addMember(app, w.c, w.company.id, 'sales', 'Satis');
    const a = await w.contact();
    const priv = (await ok(w.c.post('/api/directory/notes', { contactId: a.id, kind: 'call', noteDate: TODAY, summary: 'Özel konuşma', projectId: null }), 201)).note;
    const shared = (await ok(w.c.post('/api/directory/notes', { contactId: a.id, kind: 'meeting', noteDate: TODAY, summary: 'Paylaşılan toplantı', visibility: 'shared' }), 201)).note;
    expect(priv).toMatchObject({ visibility: 'private', mine: true, kind: 'call' });
    // Yazar ikisini de görür
    expect((await ok(w.c.get(`/api/directory/notes?contactId=${a.id}`))).notes).toHaveLength(2);
    // Satış kullanıcısı yalnızca paylaşılanı görür; özel nota doğrudan erişim 404
    const seen = (await ok(acct.client.get(`/api/directory/notes?contactId=${a.id}`))).notes as any[];
    expect(seen.map((n) => n.summary)).toEqual(['Paylaşılan toplantı']);
    expect(seen[0].mine).toBe(false);
    expect((await acct.client.get(`/api/directory/notes/${priv.id}`)).statusCode).toBe(404);
    expect((await acct.client.patch(`/api/directory/notes/${priv.id}`, { summary: 'Ele geçirme' })).statusCode).toBe(404);
    // Paylaşılan notu yazarı dışında kimse düzenleyemez
    const edit = await acct.client.patch(`/api/directory/notes/${shared.id}`, { summary: 'Başkasının notu' });
    expect(edit.statusCode).toBe(422);
    expect(edit.json().error.code).toBe('DIRECTORY_NOTE_NOT_AUTHOR');
    // Yazar düzenler: düzenlendi işareti; geçmiş denetim izinde
    const upd = await ok(w.c.patch(`/api/directory/notes/${shared.id}`, { summary: 'Paylaşılan toplantı (güncel)', visibility: 'private' }));
    expect(upd.note.editedAt).not.toBeNull();
    expect((await ok(acct.client.get(`/api/directory/notes?contactId=${a.id}`))).notes).toHaveLength(0); // özel yapıldı
    const audit = (await execAsOwner(`select old_data->>'summary' as old, new_data->>'summary' as new from audit_log where table_name = 'directory_notes' and row_id = $1 and action = 'UPDATE'`, [shared.id])).rows;
    expect(audit).toEqual([{ old: 'Paylaşılan toplantı', new: 'Paylaşılan toplantı (güncel)' }]);
    // Veritabanı: erp_app bağlamında RLS politikası (API'den bağımsız)
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId, userId: acct.userId }, async (q) => {
      expect((await q(`select count(*)::int as n from directory_notes`)).rows[0].n).toBe(0);
    });
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId, userId: w.s.userId }, async (q) => {
      expect((await q(`select count(*)::int as n from directory_notes`)).rows[0].n).toBe(2);
      const err = await expectDbError(q, `insert into directory_notes (id, company_id, contact_id, kind, note_date, summary, visibility, author_id) values (gen_random_uuid(), $1, $2, 'call', current_date, 'sahte yazar', 'shared', $3)`, [w.company.id, a.id, acct.userId]);
      expect(err.code).toBe('ERP21');
    });
    // Not için kişi ya da kurum şart; geçersiz tür reddedilir; silme ucu yok
    expect((await w.c.post('/api/directory/notes', { kind: 'call', noteDate: TODAY, summary: 'x' })).statusCode).toBe(400);
    expect((await w.c.post('/api/directory/notes', { contactId: a.id, kind: 'sms', noteDate: TODAY, summary: 'x' })).statusCode).toBe(400);
    expect((await w.c.delete(`/api/directory/notes/${shared.id}`)).statusCode).toBe(404);
    // Kuruma not
    const o = await w.org({ name: 'Belediye' });
    const on = (await ok(w.c.post('/api/directory/notes', { organizationId: o.id, kind: 'email', noteDate: TODAY, summary: 'Ruhsat yazısı', visibility: 'shared' }), 201)).note;
    expect(on).toMatchObject({ organizationName: 'Belediye', contactId: null });
  });

  it('ajanda: bugün / yaklaşan / gecikmiş listeleri, durum geçişleri, saatli kalem, sahiplik kuralları', async () => {
    const w = await world('RehberAjanda');
    const sales = await addMember(app, w.c, w.company.id, 'sales', 'Satis');
    const acct = await addMember(app, w.c, w.company.id, 'accountant', 'Muh');
    const site = await addMember(app, w.c, w.company.id, 'viewer', 'Izle');
    const mk = (b: Record<string, unknown>, c = w.c) => ok(c.post('/api/agenda', { title: 'Görev', dueDate: TODAY, ...b }), 201).then((r) => r.item);
    const late = await mk({ title: 'Gecikmiş', dueDate: plus(-3) });
    const today = await mk({ title: 'Bugün', dueDate: TODAY, remindBeforeMinutes: 30 });
    const near = await mk({ title: 'Yaklaşan', dueDate: plus(5), kind: 'appointment', allDay: false, startTime: '14:30', endTime: '15:30' });
    const far = await mk({ title: 'Uzak', dueDate: plus(30) });
    const company = await mk({ title: 'Şirket görevi', dueDate: TODAY, ownerId: null });
    expect(near).toMatchObject({ allDay: false, startTime: '14:30', endTime: '15:30', kind: 'appointment' });
    expect(today.remindBeforeMinutes).toBe(30);

    const sum = await ok(w.c.get('/api/agenda/summary?scope=mine'));
    expect(sum.counts).toEqual({ overdue: 1, today: 1, upcoming: 1 });
    expect(sum.overdue.map((i: any) => i.title)).toEqual(['Gecikmiş']);
    expect(sum.upcoming.map((i: any) => i.title)).toEqual(['Yaklaşan']);
    expect((await ok(w.c.get('/api/agenda/summary?scope=company'))).counts).toEqual({ overdue: 0, today: 1, upcoming: 0 });
    expect((await ok(w.c.get('/api/agenda/summary?scope=all'))).counts).toEqual({ overdue: 1, today: 2, upcoming: 1 });
    // asOf ile başka bir günün görünümü
    const later = await ok(w.c.get(`/api/agenda/summary?scope=mine&asOf=${plus(10)}`));
    expect(later.counts).toEqual({ overdue: 3, today: 0, upcoming: 0 });
    // Tamamla / iptal / yeniden aç
    const done = await ok(w.c.post(`/api/agenda/${late.id}/complete`));
    expect(done.item.status).toBe('done');
    expect(done.item.completedAt).not.toBeNull();
    expect((await ok(w.c.get('/api/agenda/summary?scope=mine'))).counts.overdue).toBe(0);
    expect((await ok(w.c.post(`/api/agenda/${far.id}/cancel`))).item.status).toBe('cancelled');
    expect((await ok(w.c.post(`/api/agenda/${far.id}/reopen`))).item.status).toBe('open');
    expect((await ok(w.c.get(`/api/agenda?scope=mine&status=done`))).items).toHaveLength(1);
    // Doğrulama: saatli kalemde başlangıç şart, bitiş başlangıçtan sonra
    expect((await w.c.post('/api/agenda', { title: 'x', dueDate: TODAY, allDay: false })).statusCode).toBe(400);
    expect((await w.c.post('/api/agenda', { title: 'x', dueDate: TODAY, allDay: false, startTime: '10:00', endTime: '09:00' })).statusCode).toBe(400);
    // Güncelle: tüm günü saatliye çevir
    const upd = await ok(w.c.patch(`/api/agenda/${today.id}`, { allDay: false, startTime: '09:00' }));
    expect(upd.item).toMatchObject({ allDay: false, startTime: '09:00' });
    expect((await ok(w.c.patch(`/api/agenda/${today.id}`, { allDay: true }))).item).toMatchObject({ allDay: true, startTime: null });

    // Sahiplik: okuyucu (muhasebeci) kendi kalemini açar/düzenler; başkası/şirket adına açamaz
    const mine = await mk({ title: 'Muhasebeci görevi' }, acct.client);
    expect(mine.ownerId).toBe(acct.userId);
    expect((await acct.client.patch(`/api/agenda/${mine.id}`, { title: 'Güncel' })).statusCode).toBe(200);
    const accessPath = `/api/company/members/${acct.userId}/module-access`;
    expect((await w.c.put(accessPath, { operations: { 'operation.core.directory.create': 'deny', 'operation.core.directory.update': 'deny' } })).statusCode).toBe(200);
    expect((await acct.client.post('/api/agenda', { title: 'İşlem yasağı', dueDate: TODAY })).statusCode).toBe(403);
    expect((await acct.client.patch(`/api/agenda/${mine.id}`, { title: 'İşlem yasağı' })).statusCode).toBe(403);
    expect((await w.c.put(accessPath, { operations: { 'operation.core.directory.create': 'default', 'operation.core.directory.update': 'default' }, levels: { 'core.directory': 'read' } })).statusCode).toBe(200);
    expect((await acct.client.post('/api/agenda', { title: 'Salt okunur', dueDate: TODAY })).statusCode).toBe(403);
    expect((await w.c.put(accessPath, { levels: { 'core.directory': 'default' } })).statusCode).toBe(200);
    expect((await acct.client.post('/api/agenda', { title: 'x', dueDate: TODAY, ownerId: null })).statusCode).toBe(403);
    expect((await acct.client.post('/api/agenda', { title: 'x', dueDate: TODAY, ownerId: w.s.userId })).statusCode).toBe(403);
    expect((await acct.client.patch(`/api/agenda/${today.id}`, { title: 'Ele geçirme' })).statusCode).toBe(403); // sahibin kalemi
    expect((await acct.client.post(`/api/agenda/${today.id}/complete`)).statusCode).toBe(403);
    // Yönetici (satış) başkası ve şirket adına açar, hepsini düzenler
    const forAcct = await mk({ title: 'Satıştan atama', ownerId: acct.userId }, sales.client);
    expect(forAcct.ownerId).toBe(acct.userId);
    expect((await sales.client.patch(`/api/agenda/${mine.id}`, { title: 'Yönetici düzenledi' })).statusCode).toBe(200);
    expect((await ok(sales.client.get('/api/agenda?scope=all'))).items.length).toBeGreaterThan(5);
    // Okuyucu 'all' kapsamında yalnızca kendi + şirket kalemlerini görür
    const accItems = (await ok(acct.client.get('/api/agenda?scope=all'))).items as any[];
    expect(accItems.every((i) => i.ownerId === acct.userId || i.ownerId === null)).toBe(true);
    expect(accItems.map((i) => i.title)).toContain('Şirket görevi');
    expect(accItems.map((i) => i.title)).not.toContain('Bugün');
    // İzleyici rehbere hiç erişemez
    expect((await site.client.get('/api/agenda')).statusCode).toBe(403);
    expect((await site.client.get('/api/directory/contacts')).statusCode).toBe(403);
    // Silme ucu yok; iptal vardır
    expect((await w.c.delete(`/api/agenda/${company.id}`)).statusCode).toBe(404);
  });

  it('görüşme notundan tek tıkla takip görevi: bağlantılar nottan gelir, not metni başlığa kopyalanmaz; özel nota başkası görev açamaz', async () => {
    const w = await world('RehberTakip');
    const sales = await addMember(app, w.c, w.company.id, 'sales', 'Satis');
    const a = await w.contact();
    const priv = (await ok(w.c.post('/api/directory/notes', { contactId: a.id, kind: 'call', noteDate: TODAY, summary: 'GİZLİ-METİN' }), 201)).note;
    const fu = await ok(w.c.post(`/api/directory/notes/${priv.id}/follow-up`, { dueDate: plus(2) }), 201);
    expect(fu.item).toMatchObject({ kind: 'task', contactId: a.id, sourceNoteId: priv.id, dueDate: plus(2), title: 'Takip: Ahmet Yılmaz', ownerId: w.s.userId });
    expect(JSON.stringify(fu)).not.toContain('GİZLİ-METİN');
    const named = await ok(w.c.post(`/api/directory/notes/${priv.id}/follow-up`, { dueDate: plus(3), title: 'Teklifi gönder' }), 201);
    expect(named.item.title).toBe('Teklifi gönder');
    expect((await sales.client.post(`/api/directory/notes/${priv.id}/follow-up`, { dueDate: plus(2) })).statusCode).toBe(404);
  });

  it('izinler ve modül: izleyici hiç, muhasebeci yalnızca okur; modül kapalıyken uçlar 403', async () => {
    const w = await world('RehberYetki');
    const acct = await addMember(app, w.c, w.company.id, 'accountant', 'Muh');
    const sm = await addMember(app, w.c, w.company.id, 'site_manager', 'Saha');
    const a = await w.contact();
    expect((await acct.client.get('/api/directory/contacts')).statusCode).toBe(200);
    expect((await acct.client.get(`/api/directory/contacts/${a.id}`)).statusCode).toBe(200);
    expect((await acct.client.post('/api/directory/contacts', { fullName: 'Yetkisiz' })).statusCode).toBe(403);
    expect((await acct.client.patch(`/api/directory/contacts/${a.id}`, { title: 'x' })).statusCode).toBe(403);
    expect((await acct.client.post('/api/directory/organizations', { name: 'Yetkisiz Kurum' })).statusCode).toBe(403);
    expect((await acct.client.post('/api/directory/notes', { contactId: a.id, kind: 'call', noteDate: TODAY, summary: 'x' })).statusCode).toBe(403);
    expect((await acct.client.post(`/api/directory/contacts/${a.id}/archive`)).statusCode).toBe(403);
    expect((await acct.client.post(`/api/directory/contacts/${a.id}/anonymize`, { reason: 'deneme' })).statusCode).toBe(403);
    expect((await acct.client.get('/api/directory/contacts/export.vcf')).statusCode).toBe(403); // toplu dışa aktarma yönetim izni ister
    expect((await acct.client.get('/api/exports/directory-contacts')).statusCode).toBe(403);
    expect((await acct.client.get(`/api/directory/contacts/${a.id}/vcard`)).statusCode).toBe(200);
    expect((await sm.client.post('/api/directory/contacts', { fullName: 'Şantiye Kişisi' })).statusCode).toBe(201);
    // İlgili kişi dışa aktarması gizlilik izni ister (satış/şantiye değil)
    expect((await sm.client.post(`/api/privacy/contacts/${a.id}/export`, { reason: 'deneme' })).statusCode).toBe(403);
    // Modül kapatılınca
    await ok(w.c.put('/api/company/modules/core.directory', { enabled: false }));
    expect((await w.c.get('/api/directory/contacts')).statusCode).toBe(403);
    expect((await w.c.get('/api/agenda')).statusCode).toBe(403);
    const nav = (await ok(w.c.get('/api/navigation'))).groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(nav).not.toContain('agenda');
    await ok(w.c.put('/api/company/modules/core.directory', { enabled: true }));
    expect((await w.c.get('/api/directory/contacts')).statusCode).toBe(200);
    const nav2 = (await ok(w.c.get('/api/navigation'))).groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(nav2).toEqual(expect.arrayContaining(['directory-contacts', 'directory-orgs', 'agenda']));
  });

  it('cari ve proje bağlantıları: cariye/projeye göre "ilgili kişiler"; personel carisine bağlanamaz', async () => {
    const w = await world('RehberBaglanti');
    const party = (await ok(w.c.post('/api/parties', { name: 'Demir A.Ş.', kind: 'supplier' }), 201)).party;
    const project = (await ok(w.c.post('/api/projects', { code: 'P-1', name: 'Site', startDate: day(1, 1) }), 201)).project;
    const o = await w.org({ name: 'Demir A.Ş. kurumu', partyId: party.id });
    const direct = await w.contact({ fullName: 'Doğrudan Bağlı', partyId: party.id, projectId: project.id, phone: null, email: null });
    const viaOrg = await w.contact({ fullName: 'Kurum Üzerinden', organizationId: o.id, phone: null, email: null });
    await w.contact({ fullName: 'İlgisiz', phone: null, email: null });
    const byParty = (await ok(w.c.get(`/api/directory/contacts?partyId=${party.id}`))).contacts.map((c: any) => c.fullName).sort();
    expect(byParty).toEqual(['Doğrudan Bağlı', 'Kurum Üzerinden']);
    expect((await ok(w.c.get(`/api/directory/contacts?projectId=${project.id}`))).contacts.map((c: any) => c.id)).toEqual([direct.id]);
    expect(viaOrg.partyId).toBeNull();
    // Personel carisi
    const emp = (await ok(w.c.post('/api/employees', { fullName: 'Personel Kişi', hireDate: day(1, 1) }), 201)).employee;
    const ep = await ok(w.c.post(`/api/employee-ledger/employees/${emp.id}/open-party`), 201);
    const empPartyId = (ep.party ?? ep.employee)?.id ?? ep.partyId;
    expect(empPartyId).toBeTruthy();
    const bad = await w.c.post('/api/directory/contacts', { fullName: 'Personel Bağlı', partyId: empPartyId });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('DIRECTORY_RULE_VIOLATION');
  });

  it('içe aktarma: önizleme/onay, yinelenen atlama, yeni kurum açma; hatalıysa hiçbir şey yazılmaz', async () => {
    const w = await world('RehberImport');
    await w.contact({ fullName: 'Mevcut Kişi', phone: '0392 500 00 00', email: 'mevcut@ornek.com' });
    const o = await w.org({ name: 'Mevcut Kurum' });
    const rows = [
      { row: 2, cells: { fullName: 'Yeni Bir', organization: 'Mevcut Kurum', phone: '0533 100 00 01', email: 'yeni1@ornek.com', tags: 'usta; elektrik' } },
      { row: 3, cells: { fullName: 'Yeni İki', organization: 'Yeni Kurum A.Ş.', phone: '0533 100 00 02' } },
      { row: 4, cells: { fullName: 'Yinelenen', phone: '+90 392 500 00 00' } },
      { row: 5, cells: { fullName: 'Dosyada Yinelenen', email: 'YENI1@ornek.com' } },
    ];
    const pv = await ok(w.c.post('/api/imports/directory_contacts/preview', { rows, options: { skipDuplicates: true } }));
    expect(pv.counts).toEqual({ total: 4, ok: 2, skip: 2, error: 0 });
    expect(pv.canCommit).toBe(true);
    expect(pv.summary).toEqual(expect.arrayContaining([{ label: 'Açılacak yeni kurum', value: '1' }]));
    expect((await ok(w.c.get('/api/directory/contacts'))).contacts).toHaveLength(1); // önizleme yazmaz
    const strict = await ok(w.c.post('/api/imports/directory_contacts/preview', { rows, options: { skipDuplicates: false } }));
    expect(strict.canCommit).toBe(false);
    expect((await w.c.post('/api/imports/directory_contacts/commit', { rows, options: { skipDuplicates: false } })).statusCode).toBe(422);
    expect((await ok(w.c.get('/api/directory/contacts'))).contacts).toHaveLength(1);
    const done = await ok(w.c.post('/api/imports/directory_contacts/commit', { rows, options: { skipDuplicates: true } }));
    expect(done).toMatchObject({ created: 2, skipped: 2 });
    const list = (await ok(w.c.get('/api/directory/contacts'))).contacts as any[];
    expect(list.map((c) => c.fullName).sort()).toEqual(['Mevcut Kişi', 'Yeni Bir', 'Yeni İki']);
    expect(list.find((c) => c.fullName === 'Yeni Bir')).toMatchObject({ organizationId: o.id, tags: ['usta', 'elektrik'] });
    expect((await ok(w.c.get('/api/directory/organizations'))).organizations.map((x: any) => x.name)).toContain('Yeni Kurum A.Ş.');
    // Hatalı satır: e-posta geçersiz
    const bad = await ok(w.c.post('/api/imports/directory_contacts/preview', { rows: [{ row: 2, cells: { fullName: 'X', email: 'yanlis' } }], options: {} }));
    expect(bad.counts.error).toBe(1);
    // Şablon ve yetki
    expect((await w.c.get('/api/imports/directory_contacts/template?format=csv')).body).toContain('Ad soyad');
    const acct = await addMember(app, w.c, w.company.id, 'accountant', 'Muh');
    expect((await acct.client.post('/api/imports/directory_contacts/preview', { rows, options: {} })).statusCode).toBe(403);
  });

  it('vCard çıktısı: tek ve toplu; alan kaçışı; not ve anonim kişiler dışarıda', async () => {
    const w = await world('RehberVcf');
    const o = await w.org({ name: 'Örnek; Bankası, A.Ş.' });
    const a = await w.contact({ fullName: 'Ayşe Nur Kaya', title: 'Müdür', organizationId: o.id, tags: ['banka', 'kredi'], address: 'Girne, KKTC', note: 'SERBEST-NOT' });
    const b = await w.contact({ fullName: 'Silinecek Kişi', phone: '0555 000 11 22', email: null });
    await ok(w.c.post(`/api/directory/contacts/${b.id}/anonymize`, { reason: 'İlgili kişi talebi' }));
    const one = await w.c.get(`/api/directory/contacts/${a.id}/vcard`);
    expect(one.headers['content-type']).toContain('text/vcard');
    expect(one.body).toContain('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Kaya;Ayşe Nur;;;\r\nFN:Ayşe Nur Kaya');
    expect(one.body).toContain('ORG:Örnek\\; Bankası\\, A.Ş.');
    expect(one.body).toContain('TITLE:Müdür');
    expect(one.body).toContain('TEL;TYPE=WORK,VOICE:0392 222 00 00');
    expect(one.body).toContain('EMAIL;TYPE=INTERNET:ahmet@ornek.com');
    expect(one.body).toContain('CATEGORIES:banka,kredi');
    expect(one.body).not.toContain('SERBEST-NOT');
    const all = await w.c.get('/api/directory/contacts/export.vcf');
    expect(all.statusCode).toBe(200);
    expect(all.headers['content-disposition']).toMatch(/rehber-\d{4}-\d{2}-\d{2}\.vcf/);
    expect((all.body.match(/BEGIN:VCARD/g) ?? []).length).toBe(1); // anonim kişi yok
    expect(all.body).not.toContain('Anonim');
  });

  it('ilgili kişi talebi, dışa aktarma ve anonimleştirme: rehber kişisi özneyle talep, günlüklü dışa aktarma, gerekçeli anonimleştirme', async () => {
    const w = await world('RehberDsr');
    const sales = await addMember(app, w.c, w.company.id, 'sales', 'Satis');
    const a = await w.contact({ fullName: 'Mehmet Özkan', phone: '0533 777 66 55', email: 'mehmet@ornek.com', address: 'Gazimağusa', tags: ['usta'], note: 'Serbest kişi notu' });
    // Satış kullanıcısı kişiye paylaşılan not + özel not; sahip de özel not yazar
    await ok(sales.client.post('/api/directory/notes', { contactId: a.id, kind: 'call', noteDate: TODAY, summary: 'Satışçının özel notu', visibility: 'private' }), 201);
    await ok(sales.client.post('/api/directory/notes', { contactId: a.id, kind: 'meeting', noteDate: TODAY, summary: 'Paylaşılan görüşme', visibility: 'shared' }), 201);
    await ok(w.c.post('/api/directory/notes', { contactId: a.id, kind: 'email', noteDate: TODAY, summary: 'Sahibin özel notu' }), 201);
    await ok(w.c.post('/api/agenda', { title: 'Mehmet usta ile görüş', dueDate: plus(1), contactId: a.id, description: 'Ayrıntı' }), 201);

    // Envanter: rehber satırları tohumlanır, doğrulanmamış dayanak
    const inv = (await ok(w.c.get('/api/privacy/inventory'))).inventory as any[];
    for (const key of ['directory.contacts', 'directory.organizations', 'directory.notes', 'agenda.items']) {
      const row = inv.find((i) => i.key === key);
      expect(row, key).toBeTruthy();
      expect(row.legalBasis).toContain('doğrulanmadı');
      expect(row.verifiedAt).toBeNull();
    }
    expect(inv.find((i) => i.key === 'directory.contacts').fieldName).not.toMatch(/id_number|birth/);
    expect(inv.find((i) => i.key === 'directory.notes').isSensitive).toBe(true);

    // Talep: rehber kişisine yönelik; hem personel hem kişi verilemez; geçersiz kişi
    const req = (await ok(w.c.post('/api/privacy/requests', { contactId: a.id, requesterName: 'Mehmet Özkan', kind: 'access', description: 'Verilerimi istiyorum' }), 201)).request;
    expect(req).toMatchObject({ contactId: a.id, employeeId: null, status: 'open' });
    expect((await w.c.post('/api/privacy/requests', { contactId: a.id, employeeId: a.id, requesterName: 'Çift', kind: 'access' })).statusCode).toBe(400);
    expect((await w.c.post('/api/privacy/requests', { contactId: '019a0000-0000-7000-8000-000000000000', requesterName: 'Yok', kind: 'access' })).statusCode).toBe(404);
    const listed = (await ok(w.c.get('/api/privacy/requests'))).requests as any[];
    expect(listed.find((r) => r.id === req.id)).toMatchObject({ contactName: 'Mehmet Özkan', employeeId: null });
    // Personel öznesi hâlâ çalışır
    const emp = (await ok(w.c.post('/api/employees', { fullName: 'Personel Özne', hireDate: day(1, 1) }), 201)).employee;
    const ereq = (await ok(w.c.post('/api/privacy/requests', { employeeId: emp.id, requesterName: 'Personel Özne', kind: 'export' }), 201)).request;
    expect(ereq).toMatchObject({ employeeId: emp.id, contactId: null });
    expect((await ok(w.c.post(`/api/privacy/employees/${emp.id}/export`, { reason: 'Talep: dışa aktarma' }))).employee.fullName).toBe('Personel Özne');

    // Dışa aktarma: gerekçe şart; kişi + tüm notlar (başkasının özel notu dahil) + ajanda; günlüğe yazılır
    expect((await w.c.post(`/api/privacy/contacts/${a.id}/export`, { reason: 'x' })).statusCode).toBe(400);
    expect((await sales.client.post(`/api/privacy/contacts/${a.id}/export`, { reason: 'Talep 1' })).statusCode).toBe(403);
    const exp = await ok(w.c.post(`/api/privacy/contacts/${a.id}/export`, { reason: 'Talep: erişim (Mehmet Özkan)' }));
    expect(exp.contact).toMatchObject({ fullName: 'Mehmet Özkan', phone: '0533 777 66 55', email: 'mehmet@ornek.com', address: 'Gazimağusa', tags: ['usta'] });
    expect(exp.notes.map((n: any) => n.summary).sort()).toEqual(['Paylaşılan görüşme', 'Satışçının özel notu', 'Sahibin özel notu'].sort());
    expect(exp.agenda).toHaveLength(1);
    expect(exp.requests).toHaveLength(1);
    const log = (await ok(w.c.get(`/api/privacy/access-log?contactId=${a.id}`))).log as any[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ field: 'directory_export', reason: 'Talep: erişim (Mehmet Özkan)', contactName: 'Mehmet Özkan' });
    expect(exp.accessLog).toHaveLength(1); // dışa aktarma kendisinden önce günlüğe yazılır
    // Okumalar günlüğe yazılmaz
    await ok(w.c.get(`/api/directory/contacts/${a.id}`));
    await ok(w.c.get(`/api/directory/notes?contactId=${a.id}`));
    expect((await ok(w.c.get(`/api/privacy/access-log?contactId=${a.id}`))).log).toHaveLength(1);
    // Silme talebi yalnızca kaydedilir: veri yerinde kalır
    const er = (await ok(w.c.post('/api/privacy/requests', { contactId: a.id, requesterName: 'Mehmet Özkan', kind: 'erasure' }), 201)).request;
    await ok(w.c.post(`/api/privacy/requests/${er.id}/resolve`, { outcome: 'completed', resolutionNote: 'Anonimleştirildi' }));
    expect((await ok(w.c.get(`/api/directory/contacts/${a.id}`))).contact.fullName).toBe('Mehmet Özkan');

    // Anonimleştirme: gerekçe şart, izin şart
    expect((await w.c.post(`/api/directory/contacts/${a.id}/anonymize`, { reason: 'x' })).statusCode).toBe(400);
    const an = await ok(w.c.post(`/api/directory/contacts/${a.id}/anonymize`, { reason: 'Silme talebi (Mehmet Özkan)' }));
    expect(an.contact).toMatchObject({ fullName: 'Anonim kişi', phone: null, phone2: null, email: null, address: null, title: null, tags: [], note: null, isArchived: true });
    expect(an.contact.anonymizedAt).not.toBeNull();
    // Notların yapısı kalır, serbest metni (başkalarının özel notları dahil) temizlenir
    const rows = (await execAsOwner(`select kind, summary, visibility, cleared_at is not null as cleared from directory_notes where contact_id = $1 order by kind`, [a.id])).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.summary === '[Anonimleştirildi]' && r.cleared)).toBe(true);
    expect(rows.map((r) => r.visibility).sort()).toEqual(['private', 'private', 'shared']);
    const ag = (await ok(w.c.get(`/api/agenda?contactId=${a.id}&scope=all`))).items[0];
    expect(ag).toMatchObject({ title: '[Anonimleştirildi]', description: null });
    // Günlük, donmuş kişi
    const log2 = (await ok(w.c.get(`/api/privacy/access-log?contactId=${a.id}`))).log as any[];
    expect(log2.map((l) => l.field).sort()).toEqual(['directory_anonymize', 'directory_export']);
    expect((await w.c.patch(`/api/directory/contacts/${a.id}`, { title: 'x' })).statusCode).toBe(422);
    expect((await w.c.post(`/api/directory/contacts/${a.id}/anonymize`, { reason: 'tekrar deneme' })).statusCode).toBe(422);
    expect((await w.c.post(`/api/directory/contacts/${a.id}/unarchive`)).statusCode).toBe(422);
    expect((await w.c.post('/api/directory/notes', { contactId: a.id, kind: 'call', noteDate: TODAY, summary: 'x' })).statusCode).toBe(422);
    expect((await w.c.post('/api/agenda', { title: 'x', dueDate: TODAY, contactId: a.id })).statusCode).toBe(422);
    await asOwner(async (q) => {
      const err = await expectDbError(q, `update directory_notes set summary = 'geri yazma' where contact_id = $1`, [a.id]);
      expect(err.code).toBe('ERP21');
    });
    // Anonimleştirilmiş kişi dışa aktarılabilir (yer tutucu); talep kayıtları kalır
    const exp2 = await ok(w.c.post(`/api/privacy/contacts/${a.id}/export`, { reason: 'Sonuç kontrolü' }));
    expect(exp2.contact.fullName).toBe('Anonim kişi');
    expect(exp2.requests.length).toBe(2);
  });

  it('anonimleştirme cariye/personele bağlı kişide engellenir', async () => {
    const w = await world('RehberAnonEngel');
    const party = (await ok(w.c.post('/api/parties', { name: 'Bağlı Cari', kind: 'customer' }), 201)).party;
    const emp = (await ok(w.c.post('/api/employees', { fullName: 'Bağlı Personel', hireDate: day(1, 1) }), 201)).employee;
    const p = await w.contact({ fullName: 'Cariye Bağlı', partyId: party.id });
    const e = await w.contact({ fullName: 'Personele Bağlı', employeeId: emp.id });
    for (const c of [p, e]) {
      const r = await w.c.post(`/api/directory/contacts/${c.id}/anonymize`, { reason: 'Deneme talebi' });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('DIRECTORY_RULE_VIOLATION');
      expect((await ok(w.c.get(`/api/directory/contacts/${c.id}`))).contact.fullName).toBe(c.fullName);
    }
    // Bağlantı kaldırılınca anonimleştirilir
    await ok(w.c.patch(`/api/directory/contacts/${p.id}`, { partyId: null }));
    expect((await ok(w.c.post(`/api/directory/contacts/${p.id}/anonymize`, { reason: 'Bağlantı kalktı' }))).contact.fullName).toBe('Anonim kişi');
  });

  it('dışa aktarmalar: kişiler, kurumlar, ajanda (xlsx/csv) ve tam veri "Rehber" sayfası; notlar dosyada yok', async () => {
    const w = await world('RehberExport');
    const sales = await addMember(app, w.c, w.company.id, 'sales', 'Satis');
    const acct = await addMember(app, w.c, w.company.id, 'accountant', 'Muh');
    const o = await w.org({ name: 'Banka Şubesi' });
    const a = await w.contact({ organizationId: o.id, tags: ['banka'], note: 'KISI-NOTU-SERBEST' });
    await ok(w.c.post('/api/directory/notes', { contactId: a.id, kind: 'call', noteDate: TODAY, summary: 'GORUSME-OZETI', visibility: 'shared' }), 201);
    await ok(w.c.post('/api/agenda', { title: 'Benim görevim', dueDate: TODAY }), 201);
    await ok(sales.client.post('/api/agenda', { title: 'Satışçının görevi', dueDate: TODAY }), 201);
    const book = async (c: typeof w.c, url: string) => {
      const res = await c.get(url);
      if (res.statusCode !== 200) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
      return readXlsx(new Uint8Array(res.rawPayload));
    };
    const contacts = await book(w.c, '/api/exports/directory-contacts');
    expect(contacts[0]!.name).toBe('Kişiler');
    expect(contacts[0]!.rows.slice(3).flat().join(' ')).toContain('Ahmet Yılmaz');
    expect(JSON.stringify(contacts)).not.toContain('KISI-NOTU-SERBEST');
    expect(JSON.stringify(contacts)).not.toContain('GORUSME-OZETI');
    const csv = await w.c.get('/api/exports/directory-contacts?format=csv&tag=banka');
    expect(csv.body).toContain('Ahmet Yılmaz');
    expect(csv.body).not.toContain('KISI-NOTU-SERBEST');
    expect((await book(w.c, '/api/exports/directory-organizations'))[0]!.rows.flat().join(' ')).toContain('Banka Şubesi');
    // Ajanda: kendi + şirket; yönetici hepsi
    const mineOnly = JSON.stringify(await book(acct.client, '/api/exports/agenda'));
    expect(mineOnly).not.toContain('Benim görevim');
    expect(JSON.stringify(await book(w.c, '/api/exports/agenda'))).toContain('Satışçının görevi');
    // Tam veri: Rehber sayfaları yalnızca rehber yönetim izni olanın dosyasında
    const full = await book(w.c, '/api/exports/full-data');
    expect(full.map((s) => s.name)).toEqual(expect.arrayContaining(['Rehber', 'Rehber kurumları']));
    expect(JSON.stringify(full)).not.toContain('GORUSME-OZETI');
    const fullAcct = await book(acct.client, '/api/exports/full-data');
    expect(fullAcct.map((s) => s.name)).not.toContain('Rehber');
    // Başka şirkette sayfa yok
    const other = await world('RehberExportBaska');
    expect((await book(other.c, '/api/exports/full-data')).map((s) => s.name)).not.toContain('Rehber');
  });
});

describe('rehber saf yardımcılar (sunucu tarafı özet kontrolü)', () => {
  it('modül kaydı: core.directory tüm sektörlerde açık, requires boş', async () => {
    const { MODULES } = await import('@erp/shared');
    const m = MODULES.find((x) => x.key === 'core.directory');
    expect(m).toMatchObject({ sectors: 'all', status: 'available' });
    expect(m?.requires ?? []).toEqual([]);
  });
});
