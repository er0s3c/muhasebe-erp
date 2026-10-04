import { randomUUID } from 'node:crypto';
import { addDaysIso, previousMonths, todayIso } from '@erp/shared';
import { describe, expect, it } from 'vitest';
import type { MailMessage } from '../src/modules/mail/mailer';
import { scanAll, scanCompany, type ScanOptions } from '../src/modules/notifications/scan';
import { addMember, asDb, asOwner, client, createCompany, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

/**
 * Bildirim sistemi: uygulama içi bildirimler, tercihler, zamanlayıcı (tarama), kopya önleme / otomatik çözme, saklama ve isteğe bağlı
 * e-posta özeti. Gün sayıları ve eşikler YALNIZCA TEST DEĞERİDİR; kodda yasal süre yoktur. Bildirim metni GENELDİR: ad, belge no, tutar yok.
 */
const TODAY = todayIso();
const PAST = '2020-01-01';
/** Verilen günün öğlesi (UTC 12:00 = Nicosia 14:00/15:00): yerel tarih = TODAY + n. */
const at = (n = 0, time = '12:00:00') => new Date(`${addDaysIso(TODAY, n)}T${time}Z`);
const dayOf = (n: number) => addDaysIso(TODAY, n);

type Row = { id: string; kind: string; severity: string; title: string; body: string; link: string; count: number; readAt: string | null; dismissedAt: string | null; resolvedAt: string | null; createdAt: string };

describe('bildirim sistemi', async () => {
  const { app, handle } = await makeApp();

  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => {
    const res = await p;
    if (res.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  async function world(name: string, sector = 'CONSTRUCTION') {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, { sector });
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const scan = (opts: ScanOptions = {}) => scanCompany(handle.db, { companyId: company.id, orgId }, { wait: true, ...opts });
    type C = ReturnType<typeof client>;
    const rows = async (cl: C = c, qs = 'status=all'): Promise<Row[]> => (await ok(cl.get(`/api/notifications?${qs}`))).notifications;
    const active = async (cl: C = c) => rows(cl, 'status=active');
    const kinds = async (cl: C = c) => (await active(cl)).map((n) => n.kind).sort();
    const of = async (kind: string, cl: C = c) => (await active(cl)).find((n) => n.kind === kind);
    const party = async (n = 'Müşteri A.Ş.', kind = 'customer') => (await ok(c.post('/api/parties', { name: n, kind }), 201)).party as { id: string };
    const cheque = async (partyId: string, dueDate: string, extra: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/cheques', { direction: 'received', docType: 'cheque', docNo: `CK-${randomUUID().slice(0, 6)}`, bankName: 'Test Bankası', partyId, amount: '100', issueDate: PAST, dueDate, registerDate: TODAY, ...extra }), 201)).cheque as { id: string };
    const agenda = async (body: Record<string, unknown>, cl: C = c) => (await ok(cl.post('/api/agenda', { title: 'Görev', dueDate: TODAY, ...body }), 201)).item as { id: string };
    const prefs = async (preferences: Record<string, unknown>[], cl: C = c) => ok(cl.put('/api/notification-preferences', { preferences }));
    return { s, company, c, orgId, scan, rows, active, kinds, of, party, cheque, agenda, prefs };
  }

  // -------------------------------------------------------------------------------------------------------------------
  describe('kaynaklar (enjekte edilen günle)', () => {
    it('çek/senet vadesi: gün eşiği tercihle değişir; vadesi geçen kritik olur; metin genel (ad, numara, tutar yok)', async () => {
      const w = await world('NtfCek');
      const p = await w.party('Gizli Müşteri Ltd.');
      expect(await w.kinds()).toEqual([]);
      const near = await w.cheque(p.id, dayOf(3), { docNo: 'GIZLI-NO-123', amount: '98765.43' });
      await w.cheque(p.id, dayOf(20));
      const r1 = await w.scan();
      expect(r1).toMatchObject({ skipped: false, created: 1, failedKinds: [] });
      const n1 = (await w.of('cheque_due'))!;
      expect(n1).toMatchObject({ severity: 'warning', count: 1, link: '/treasury/cheques', readAt: null, resolvedAt: null });
      const text = `${n1.title} ${n1.body}`;
      for (const secret of ['Gizli Müşteri', 'GIZLI-NO-123', '98765', 'Test Bankası']) expect(text).not.toContain(secret);

      // Gün eşiği 30: ikinci çek de kapsanır (yeni durum → yeni bildirim, eskisi çözülür)
      await w.prefs([{ kind: 'cheque_due', leadDays: 30 }]);
      const r2 = await w.scan();
      expect(r2).toMatchObject({ created: 1, resolved: 1 });
      expect(await w.of('cheque_due')).toMatchObject({ count: 2, severity: 'warning' });
      expect((await w.active()).filter((x) => x.kind === 'cheque_due')).toHaveLength(1);

      // Vadesi geçmiş çek: kritik
      await w.cheque(p.id, dayOf(-2));
      await w.scan();
      expect(await w.of('cheque_due')).toMatchObject({ count: 3, severity: 'critical' });
      expect((await w.of('cheque_due'))!.body).toContain('vadesi geçen: 1');
      void near;
    });

    it('teminat mektubu: kaynak ayarı (uyarı günü) yoksa düz varsayılan; ayar varsa o; süresi geçen kritik', async () => {
      const w = await world('NtfTeminat');
      const letter = async (no: string, expiry: string | null) =>
        ok(w.c.post('/api/bank-guarantees', { direction: 'given', letterNo: no, bankName: 'Test Bankası', counterpartyName: 'İşveren', amount: '5000', currencyCode: 'TRY', issueDate: PAST, expiryDate: expiry }), 201);
      await letter('TM-1', dayOf(20));
      await letter('TM-2', null); // süresiz: asla
      await letter('TM-3', dayOf(200));
      await w.scan();
      expect(await w.of('guarantee_expiring')).toMatchObject({ count: 1, severity: 'warning', link: '/treasury/guarantees' }); // varsayılan 30 gün
      // Şirketin kendi ayarı 10 gün: 20 gün sonraki mektup artık kapsam dışı
      await ok(w.c.put('/api/bank-guarantees/settings', { guaranteeWarningDays: 10 }));
      await w.scan();
      expect(await w.of('guarantee_expiring')).toBeUndefined();
      // Kullanıcının tercihi ayarın önüne geçer
      await w.prefs([{ kind: 'guarantee_expiring', leadDays: 25 }]);
      await w.scan();
      expect(await w.of('guarantee_expiring')).toMatchObject({ count: 1 });
      // Süresi geçmiş ama kapatılmamış: kritik
      await letter('TM-4', dayOf(-1));
      await w.scan();
      expect(await w.of('guarantee_expiring')).toMatchObject({ count: 2, severity: 'critical' });
    });

    it('yabancı işçi belgesi: uyarı günü kullanıcı parametresinden; ayrılan personel ve iptal edilen belge sayılmaz; metinde ad/numara yok', async () => {
      const w = await world('NtfYabanci');
      const types = (await ok(w.c.get('/api/foreign-workers/doc-types'))).types as { id: string; code: string }[];
      const typeId = types.find((t) => t.code === 'WORK_PERMIT')!.id;
      const emp = async (fullName: string) => (await ok(w.c.post('/api/employees', { fullName, nationality: 'Test-Uyruk', hireDate: PAST }), 201)).employee as { id: string };
      const doc = async (employeeId: string, expiryDate: string, no = 'BELGE-0001') =>
        (await ok(w.c.post('/api/foreign-workers/documents', { employeeId, typeId, documentNo: no, issueDate: PAST, expiryDate }), 201)).doc as { id: string };
      const ali = await emp('Gizli Personel Ali');
      const veli = await emp('Gizli Personel Veli');
      await doc(ali.id, dayOf(20), 'PRM-SECRET-77');
      const veliDoc = await doc(veli.id, dayOf(10), 'PRM-SECRET-88');
      await w.scan();
      const n = (await w.of('foreign_doc_expiring'))!;
      expect(n).toMatchObject({ count: 2, severity: 'warning', link: '/hr/foreign-workers' }); // varsayılan 30 gün
      expect(`${n.title} ${n.body}`).not.toMatch(/Gizli|PRM-SECRET|Test-Uyruk/);
      // Kullanıcı parametresi (uyarı günü 15): yalnızca 10 gün sonraki belge
      await ok(w.c.post('/api/foreign-workers/params', { key: 'expiry_warning_days', value: '15', effectiveFrom: PAST, enabled: true }), 201);
      await w.scan();
      expect(await w.of('foreign_doc_expiring')).toMatchObject({ count: 1 });
      // İptal edilen belge sayılmaz
      await ok(w.c.post(`/api/foreign-workers/documents/${veliDoc.id}/revoke`, { reason: 'Test iptali' }));
      await w.scan();
      expect(await w.of('foreign_doc_expiring')).toBeUndefined();
      // Süresi dolmuş belge kritik; işten ayrılan personelin belgesi sayılmaz
      const eski = await emp('Gizli Personel Eski');
      await doc(eski.id, dayOf(-3), 'PRM-SECRET-99');
      await w.scan();
      expect(await w.of('foreign_doc_expiring')).toMatchObject({ severity: 'critical' });
      await execAsOwner(`update employees set status = 'left', leave_date = $2 where id = $1`, [eski.id, dayOf(-1)]);
      await w.scan();
      expect(await w.of('foreign_doc_expiring')).toBeUndefined();
    });

    it('ajanda: bugün/geciken kullanıcıya bağlıdır (başkasının kalemi bildirilmez, şirket ajandası herkese); tamamlanınca çözülür', async () => {
      const w = await world('NtfAjanda');
      const acct = await addMember(app, w.c, w.company.id, 'accountant');
      await w.agenda({ title: 'Benim görevim', dueDate: TODAY });
      await w.agenda({ title: 'Geciken', dueDate: dayOf(-3) });
      await w.agenda({ title: 'Gelecek', dueDate: dayOf(5) });
      await w.agenda({ title: 'Şirket ajandası', dueDate: TODAY, ownerId: null });
      await w.agenda({ title: 'Muhasebecinin', dueDate: TODAY, ownerId: acct.userId });
      await w.scan();
      // Sahip: kendi 2 (bugün + geciken) + şirket ajandası; muhasebecinin kalemi yok
      expect(await w.of('agenda_due')).toMatchObject({ count: 3, severity: 'warning', link: '/agenda' });
      // Muhasebeci: kendi 1 + şirket ajandası; sahibin kalemleri yok
      expect(await w.of('agenda_due', acct.client)).toMatchObject({ count: 2, severity: 'info' });
      expect((await w.of('agenda_due'))!.body).not.toContain('Benim görevim');
      // Tamamlanınca durum değişir → eski bildirim çözülür
      const items = (await ok(w.c.get('/api/agenda?scope=mine&status=open'))).items as { id: string; title: string }[];
      for (const i of items) await ok(w.c.post(`/api/agenda/${i.id}/complete`));
      await w.scan();
      expect(await w.of('agenda_due')).toMatchObject({ count: 1 }); // yalnızca şirket ajandası kaldı
      // Gün eşiği: 5 gün sonraki kalem 5 gün tercihle kapsanır
      await w.agenda({ title: 'Gelecek 2', dueDate: dayOf(5) });
      await w.prefs([{ kind: 'agenda_due', leadDays: 5 }]);
      await w.scan();
      expect(await w.of('agenda_due')).toMatchObject({ count: 2 });
    });

    it('ajanda hatırlatma ofseti (X6): hatırlatma anı gelince etkin, kalem bitince çözülür', async () => {
      const w = await world('NtfHatirlatma');
      await w.agenda({ title: 'Toplantı', dueDate: dayOf(2), allDay: false, startTime: '14:00', endTime: '15:00', remindBeforeMinutes: 60 });
      // 2 gün sonra 14:00, 60 dk önce: yerel 13:00 = UTC 10:00 (kış UTC+2) ya da 11:00 (yaz UTC+3); yerel saat enjekte edilen ana göredir
      const local = (n: number, hhmm: string) => {
        // Yerel duvar saatinden an: o günün 12:00Z'sinden başlayıp yerel saati eşleyene dek ayarla
        const base = at(n, '00:00:00');
        for (let h = 0; h < 30; h++) {
          const d = new Date(base.getTime() + h * 3_600_000);
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Nicosia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
          const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Nicosia' }).format(d);
          if (date === dayOf(n) && parts.startsWith(hhmm.slice(0, 2))) return d;
        }
        throw new Error('saat bulunamadı');
      };
      await w.scan({ now: local(2, '12:00') });
      expect(await w.of('agenda_reminder')).toBeUndefined(); // henüz erken (hatırlatma 13:00'te)
      await w.scan({ now: local(2, '13:00') });
      expect(await w.of('agenda_reminder')).toMatchObject({ count: 1, severity: 'info' });
      await w.scan({ now: local(2, '14:00') });
      expect(await w.of('agenda_reminder')).toMatchObject({ count: 1 });
      await w.scan({ now: local(2, '16:00') }); // kalem bitti
      expect(await w.of('agenda_reminder')).toBeUndefined();
    });

    it('onay bekleyen belge: yalnızca sıradaki adım kendisinde olan kullanıcıya; karar sonrası çözülür', async () => {
      const w = await world('NtfOnay');
      const acct = await addMember(app, w.c, w.company.id, 'accountant');
      const site = await addMember(app, w.c, w.company.id, 'site_manager');
      const reqId = randomUUID();
      await execAsOwner(
        `insert into approval_requests (id, company_id, doc_type, doc_id, amount, status, separate_requester, requested_by) values ($1, $2, 'purchase_request', $3, 500, 'pending', true, $4)`,
        [reqId, w.company.id, randomUUID(), w.s.userId],
      );
      await execAsOwner(`insert into approval_steps (id, company_id, request_id, step_no, approver_role, status) values (gen_random_uuid(), $1, $2, 1, 'accountant', 'pending')`, [w.company.id, reqId]);
      await w.scan();
      expect(await w.of('approval_pending', acct.client)).toMatchObject({ count: 1, severity: 'warning', link: '/approvals' });
      expect(await w.of('approval_pending')).toBeUndefined(); // sahip: adım muhasebeci rolünde
      expect(await w.of('approval_pending', site.client)).toBeUndefined();
      await ok(acct.client.post(`/api/approvals/${reqId}/decide`, { decision: 'approve' }));
      await w.scan();
      expect(await w.of('approval_pending', acct.client)).toBeUndefined();
    });

    it('lisans: yalnızca kurulumun sahibi kuruluşun şirket sahibine; eşik gün tercihle; tolerans ve kısıtlı kritik; denetim kapalıysa yok', async () => {
      const w = await world('NtfLisans');
      const acct = await addMember(app, w.c, w.company.id, 'accountant');
      const lic = (v: { enforced: boolean; state: string; daysUntilExpiry?: number | null }, ownerOrgId: string | null = w.orgId) => ({ license: async () => ({ ...v, ownerOrgId }) });
      await w.scan(lic({ enforced: false, state: 'active', daysUntilExpiry: 3 }));
      expect(await w.of('license_expiring')).toBeUndefined(); // denetim kapalı (geliştirme)
      await w.scan(lic({ enforced: true, state: 'active', daysUntilExpiry: 3 }, randomUUID()));
      expect(await w.of('license_expiring')).toBeUndefined(); // başka kuruluş kurulumun sahibi: bu şirkete lisans bildirimi yok
      await w.scan(lic({ enforced: true, state: 'active', daysUntilExpiry: 3 }));
      expect(await w.of('license_expiring')).toMatchObject({ severity: 'warning', link: '/settings/license', title: 'Lisansın bitmesine 3 gün kaldı' });
      expect(await w.of('license_expiring', acct.client)).toBeUndefined(); // yalnızca şirket sahibi
      await w.scan(lic({ enforced: true, state: 'active', daysUntilExpiry: 90 }));
      expect(await w.of('license_expiring')).toBeUndefined(); // varsayılan eşik 30 gün
      await w.prefs([{ kind: 'license_expiring', leadDays: 120 }]);
      await w.scan(lic({ enforced: true, state: 'active', daysUntilExpiry: 90 }));
      expect(await w.of('license_expiring')).toMatchObject({ severity: 'warning' });
      await w.scan(lic({ enforced: true, state: 'grace', daysUntilExpiry: -2 }));
      expect(await w.of('license_expiring')).toMatchObject({ severity: 'critical' });
      await w.scan(lic({ enforced: true, state: 'restricted' }));
      expect(await w.of('license_expiring')).toMatchObject({ severity: 'critical', title: 'Lisans kısıtlı modda' });
      await w.scan(lic({ enforced: true, state: 'unlicensed' })); // lisanssız: etkinleştirme akışı vardır, bildirim yok
      expect(await w.of('license_expiring')).toBeUndefined();
    });

    it('puantaj ve bordro: ay sonu geçen ama kapatılmayan/onaylanmayan ay; kapatınca çözülür', async () => {
      const w = await world('NtfAy');
      const prev = previousMonths(TODAY, 1)[0]!;
      const e = (await ok(w.c.post('/api/employees', { fullName: 'Aylık Personel', hireDate: PAST }), 201)).employee as { id: string };
      await ok(w.c.put('/api/attendance/entries', { entries: [{ employeeId: e.id, workDate: `${prev}-10`, dayType: 'worked', normalHours: '8' }] }));
      await w.scan();
      expect(await w.of('attendance_open')).toMatchObject({ count: 1, severity: 'warning', link: '/hr/attendance' });
      expect(await w.of('payroll_open')).toBeUndefined(); // puantaj kapanmadan bordro beklenmez
      await ok(w.c.post('/api/attendance/months/close', { month: prev }));
      await w.scan();
      expect(await w.of('attendance_open')).toBeUndefined();
      expect(await w.of('payroll_open')).toMatchObject({ count: 1, link: '/hr/payroll' }); // puantaj kapalı, bordro hiç yok
      // Taslak bordro hâlâ "açık"; iptal/onay dışı
      await execAsOwner(`insert into payroll_runs (id, company_id, number, month, status) values (gen_random_uuid(), $1, 'BRD-T1', $2, 'draft')`, [w.company.id, prev]);
      await w.scan();
      expect(await w.of('payroll_open')).toMatchObject({ count: 1 });
    });

    it('vadesi geçmiş alacak: gecikme eşiği; 90 günü aşan kritik; yalnızca sayı', async () => {
      const w = await world('NtfAlacak');
      const p1 = await w.party('Gizli Alıcı 1');
      const p2 = await w.party('Gizli Alıcı 2');
      const sale = (partyId: string, invoiceDate: string, dueDate: string) =>
        ok(w.c.post('/api/invoices', { post: true, type: 'sales', partyId, invoiceDate, dueDate, currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '1000' }] }), 201);
      await sale(p1.id, dayOf(-40), dayOf(-10));
      await sale(p2.id, dayOf(-5), dayOf(20)); // vadesi gelmemiş
      await w.scan();
      const n = (await w.of('receivable_overdue'))!;
      expect(n).toMatchObject({ count: 1, severity: 'warning', link: '/parties/aging' });
      expect(`${n.title} ${n.body}`).not.toMatch(/Gizli|1000/);
      await w.prefs([{ kind: 'receivable_overdue', leadDays: 15 }]); // 15 günden az gecikme sayılmaz
      await w.scan();
      expect(await w.of('receivable_overdue')).toBeUndefined();
      await w.prefs([{ kind: 'receivable_overdue', leadDays: 0 }]);
      await sale(p2.id, dayOf(-200), dayOf(-120));
      await w.scan();
      expect(await w.of('receivable_overdue')).toMatchObject({ count: 2, severity: 'critical' });
    });

    it('kritik stok ve eski taslak: sayı + yetkiye göre; eşik gün tercihle', async () => {
      const w = await world('NtfStok');
      const acct = await addMember(app, w.c, w.company.id, 'accountant');
      const sales = await addMember(app, w.c, w.company.id, 'sales');
      await ok(w.c.post('/api/items', { name: 'Çimento', minLevel: '10' }), 201);
      await ok(w.c.post('/api/items', { name: 'Bol stok' }), 201); // kritik seviye tanımsız
      const p = await w.party();
      const draft = await ok(w.c.post('/api/invoices', { type: 'sales', partyId: p.id, invoiceDate: TODAY, currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '10' }] }), 201);
      await w.scan();
      expect(await w.of('stock_below_min')).toMatchObject({ count: 1, severity: 'warning', link: '/inventory/status?low=1' });
      expect(await w.of('draft_stale')).toBeUndefined(); // taslak yeni
      // Taslağı 20 gün eskit
      await execAsOwner(`update invoices set created_at = now() - interval '20 days' where id = $1`, [draft.invoice?.id ?? draft.id]);
      await w.scan();
      expect(await w.of('draft_stale')).toMatchObject({ count: 1, severity: 'info', link: '/invoices/sales' });
      expect(await w.of('draft_stale', sales.client)).toMatchObject({ count: 1 }); // fatura hazırlar
      expect(await w.of('draft_stale', acct.client)).toMatchObject({ count: 1 });
      await w.prefs([{ kind: 'draft_stale', leadDays: 30 }]); // 30 günden eski değil
      await w.scan();
      expect(await w.of('draft_stale')).toBeUndefined();
      // Kritik seviye kalkınca çözülür
      const items = (await ok(w.c.get('/api/items'))).items as { id: string; name: string }[];
      await ok(w.c.patch(`/api/items/${items.find((i) => i.name === 'Çimento')!.id}`, { minLevel: null }));
      await w.scan();
      expect(await w.of('stock_below_min')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('yetki, modül ve kiracı yalıtımı', () => {
    it('kaynak izni olmayan kullanıcı o bildirimi almaz; modül kapalıysa kimse almaz ve açık bildirim çözülür', async () => {
      const w = await world('NtfYetki');
      const viewer = await addMember(app, w.c, w.company.id, 'viewer');
      const acct = await addMember(app, w.c, w.company.id, 'accountant');
      const sales = await addMember(app, w.c, w.company.id, 'sales');
      const types = (await ok(w.c.get('/api/foreign-workers/doc-types'))).types as { id: string; code: string }[];
      const e = (await ok(w.c.post('/api/employees', { fullName: 'Belgeli', nationality: 'Test-Uyruk', hireDate: PAST }), 201)).employee as { id: string };
      await ok(w.c.post('/api/foreign-workers/documents', { employeeId: e.id, typeId: types[0]!.id, documentNo: 'N-1', issueDate: PAST, expiryDate: dayOf(5) }), 201);
      const p = await w.party();
      await w.cheque(p.id, dayOf(2));
      await w.scan();
      // İzleyici: İK izni yok → yabancı işçi bildirimi yok; ama treasury.read var → çek bildirimi var
      expect(await w.kinds(viewer.client)).toEqual(['cheque_due']);
      expect(await w.kinds(acct.client)).toEqual(['cheque_due', 'foreign_doc_expiring']);
      // Satış: ne hazine ne İK izni
      expect(await w.kinds(sales.client)).toEqual([]);
      expect((await w.kinds()).sort()).toEqual(['cheque_due', 'foreign_doc_expiring']);
      // Modül kapat: hr.foreign kapalı → herkesten kalkar (çözülür)
      await ok(w.c.put('/api/company/modules/hr.foreign', { enabled: false }));
      const r = await w.scan();
      expect(r.resolved).toBeGreaterThanOrEqual(2);
      expect(await w.kinds(acct.client)).toEqual(['cheque_due']);
      expect(await w.kinds()).toEqual(['cheque_due']);
      // Çek modülü de kapanınca hiçbiri kalmaz
      await ok(w.c.put('/api/company/modules/treasury.cheques', { enabled: false }));
      await w.scan();
      expect(await w.kinds(viewer.client)).toEqual([]);
    });

    it('RLS: kullanıcı yalnızca kendi satırını görür; başka şirket ve başka kullanıcı satırları görünmez/yazılamaz', async () => {
      const a = await world('NtfRlsA');
      const b = await world('NtfRlsB');
      const acctA = await addMember(app, a.c, a.company.id, 'accountant');
      const pa = await a.party();
      await a.cheque(pa.id, dayOf(1));
      const pb = await b.party();
      await b.cheque(pb.id, dayOf(1));
      await a.scan();
      await b.scan();
      // API: herkes yalnızca kendisininkini görür
      const ownerA = await a.rows();
      const acctRows = await a.rows(acctA.client);
      const ownerB = await b.rows();
      expect(ownerA.map((n) => n.id).filter((id) => acctRows.some((r) => r.id === id))).toEqual([]);
      expect(ownerB.map((n) => n.id).filter((id) => ownerA.some((r) => r.id === id))).toEqual([]);
      // Başka kullanıcının bildirimini okundu/kapat → 404
      expect((await a.c.post(`/api/notifications/${acctRows[0]!.id}/read`)).statusCode).toBe(404);
      expect((await a.c.post(`/api/notifications/${acctRows[0]!.id}/dismiss`)).statusCode).toBe(404);
      // Ham SQL (erp_app, RLS bağlamı): şirket A + sahip kullanıcı
      await asDb(handle, { userId: a.s.userId, orgId: a.orgId, companyId: a.company.id }, async (q) => {
        const all = await q(`select user_id, company_id from notifications`);
        expect(all.rows.length).toBe(ownerA.length);
        expect(all.rows.every((r) => r.user_id === a.s.userId && r.company_id === a.company.id)).toBe(true);
        // Başka kullanıcı adına satır eklenemez (WITH CHECK)
        const e = await expectDbError(
          q,
          `insert into notifications (id, company_id, user_id, kind, severity, title, link, dedupe_key, bucket_date) values (gen_random_uuid(), $1, $2, 'cheque_due', 'info', 'x', '/x', 'k', current_date)`,
          [a.company.id, acctA.userId],
        );
        expect(e.code).toBe('42501');
        // Başka şirket adına da eklenemez
        const e2 = await expectDbError(
          q,
          `insert into notifications (id, company_id, user_id, kind, severity, title, link, dedupe_key, bucket_date) values (gen_random_uuid(), $1, $2, 'cheque_due', 'info', 'x', '/x', 'k', current_date)`,
          [b.company.id, a.s.userId],
        );
        expect(['42501', 'ERP25']).toContain(e2.code);
      });
      // Bağlam yoksa hiçbir satır görünmez
      await asDb(handle, {}, async (q) => expect((await q(`select 1 from notifications`)).rows).toEqual([]));
      // Muhasebeci bağlamında sahibin satırı görünmez
      await asDb(handle, { userId: acctA.userId, orgId: a.orgId, companyId: a.company.id }, async (q) => {
        const rowsSeen = await q(`select user_id from notifications`);
        expect(rowsSeen.rows.every((r) => r.user_id === acctA.userId)).toBe(true);
      });
      // Tercihler de kullanıcıya özeldir
      await a.prefs([{ kind: 'cheque_due', inApp: false }]);
      await asDb(handle, { userId: acctA.userId, orgId: a.orgId, companyId: a.company.id }, async (q) => expect((await q(`select 1 from notification_preferences`)).rows).toEqual([]));
    });

    it('üyelikten çıkarılan ya da pasifleştirilen kullanıcının açık bildirimleri çözülür (artık taranmaz); yeni üye ilk taramada alır', async () => {
      const w = await world('NtfUyelik');
      const a = await addMember(app, w.c, w.company.id, 'accountant');
      const b = await addMember(app, w.c, w.company.id, 'accountant', 'accountant2');
      await w.agenda({ ownerId: null }); // şirket ajandası: herkese
      await w.scan();
      expect(await w.kinds(a.client)).toEqual(['agenda_due']);
      expect(await w.kinds(b.client)).toEqual(['agenda_due']);
      // Pasifleştirme
      await execAsOwner(`update users set is_active = false where id = $1`, [a.userId]);
      // Üyelikten çıkarma
      await ok(w.c.delete(`/api/company/members/${b.userId}`));
      await w.scan();
      const state = (await execAsOwner(`select user_id, resolved_at is not null as resolved from notifications where company_id = $1 and user_id in ($2, $3)`, [w.company.id, a.userId, b.userId])).rows;
      expect(state).toHaveLength(2);
      expect(state.every((r) => r.resolved)).toBe(true);
      expect(await w.kinds()).toEqual(['agenda_due']); // sahip etkilenmez
      // Yeni üye ilk taramada alır
      const c = await addMember(app, w.c, w.company.id, 'accountant', 'accountant3');
      expect(await w.kinds(c.client)).toEqual([]);
      await w.scan();
      expect(await w.kinds(c.client)).toEqual(['agenda_due']);
    });

    it('scanAll: tüm şirketleri tek tek, her biri kendi bağlamında tarar (başka şirketin kaydı sızmaz)', async () => {
      const a = await world('NtfAllA');
      const b = await world('NtfAllB');
      await a.agenda({ title: 'A işi' });
      const r = await scanAll(handle.db, { wait: true });
      expect(r.errors).toBe(0);
      expect(r.companies).toBeGreaterThanOrEqual(2);
      expect(await a.of('agenda_due')).toMatchObject({ count: 1 });
      expect(await b.of('agenda_due')).toBeUndefined();
      expect(await b.rows()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('kopya önleme, çözme, okundu/kapat', () => {
    it('tarama tekrarı kopya üretmez; durum değişince yeni bildirim, eskisi çözülür; koşul kalkınca çözülür', async () => {
      const w = await world('NtfIdem');
      await w.agenda({ title: 'Bir', dueDate: TODAY });
      const r1 = await w.scan();
      const r2 = await w.scan();
      const r3 = await w.scan();
      expect([r1.created, r2.created, r3.created]).toEqual([1, 0, 0]);
      expect(await w.rows()).toHaveLength(1);
      // Yeni kalem: durum değişti → yeni satır, eski çözülür
      const two = await w.agenda({ title: 'İki', dueDate: TODAY });
      const r4 = await w.scan();
      expect(r4).toMatchObject({ created: 1, resolved: 1 });
      const all = await w.rows();
      expect(all).toHaveLength(2);
      expect(all.filter((n) => !n.resolvedAt)).toHaveLength(1);
      expect(all.filter((n) => n.resolvedAt)).toHaveLength(1);
      // Aynı gün eski duruma dönüş (A → B → A): çözülmüş satır yeniden açılır, kopya yok
      await ok(w.c.post(`/api/agenda/${two.id}/complete`));
      const r5 = await w.scan();
      expect(r5.created).toBe(0);
      expect(await w.rows()).toHaveLength(2);
      expect((await w.active()).map((n) => n.count)).toEqual([1]);
      // Koşul tümüyle kalkınca çözülür
      const open = (await ok(w.c.get('/api/agenda?scope=mine&status=open'))).items as { id: string }[];
      for (const i of open) await ok(w.c.post(`/api/agenda/${i.id}/complete`));
      await w.scan();
      expect(await w.active()).toEqual([]);
      expect((await w.rows()).every((n) => n.resolvedAt)).toBe(true);
    });

    it('okundu, kapat ve tümünü okundu: sayaç düşer; kapatılan durum aynı haliyle yeniden bildirilmez; durum değişirse bildirilir', async () => {
      const w = await world('NtfOkundu');
      const p = await w.party();
      await w.cheque(p.id, dayOf(1));
      await w.agenda({ title: 'Ajanda' });
      await w.scan();
      expect(await ok(w.c.get('/api/notifications/unread-count'))).toEqual({ count: 2, hasCritical: false });
      const all = await w.active();
      expect(all).toHaveLength(2);
      const chq = all.find((n) => n.kind === 'cheque_due')!;
      const agd = all.find((n) => n.kind === 'agenda_due')!;
      const first = (await ok(w.c.post(`/api/notifications/${chq.id}/read`))).notification;
      expect(first.readAt).toBeTruthy();
      expect((await ok(w.c.post(`/api/notifications/${chq.id}/read`))).notification.readAt).toBe(first.readAt); // tekrar zararsız
      expect((await ok(w.c.get('/api/notifications/unread-count'))).count).toBe(1);
      expect((await w.rows(w.c, 'status=unread')).map((n) => n.id)).toEqual([agd.id]);
      // Kapat: listeden kalkar; okundu da sayılır
      const dismissed = (await ok(w.c.post(`/api/notifications/${agd.id}/dismiss`))).notification;
      expect(dismissed.dismissedAt).toBeTruthy();
      expect(dismissed.readAt).toBeTruthy();
      expect((await w.active()).map((n) => n.id)).toEqual([chq.id]); // okunmuş ama kapatılmamış çek durur
      expect((await ok(w.c.get('/api/notifications/unread-count'))).count).toBe(0);
      expect((await w.rows()).length).toBe(2); // geçmişte durur
      // Aynı durum yeniden bildirilmez (kapatıldı)
      const r = await w.scan();
      expect(r.created).toBe(0);
      expect((await w.active()).map((n) => n.id)).toEqual([chq.id]);
      // Durum değişince (yeni ajanda kalemi) yeniden bildirilir
      await w.agenda({ title: 'Başka' });
      await w.scan();
      expect((await w.active()).map((n) => n.kind).sort()).toEqual(['agenda_due', 'cheque_due']);
      expect((await ok(w.c.get('/api/notifications/unread-count'))).count).toBe(1);
      expect(await ok(w.c.post('/api/notifications/read-all'))).toEqual({ updated: 1 });
      expect(await ok(w.c.post('/api/notifications/read-all'))).toEqual({ updated: 0 });
      expect((await ok(w.c.get('/api/notifications/unread-count'))).count).toBe(0);
      expect((await w.c.post(`/api/notifications/${randomUUID()}/read`)).statusCode).toBe(404);
      expect((await w.c.post('/api/notifications/bozuk-kimlik/read')).statusCode).toBe(400);
    });

    it('liste: tür süzgeci, sayfa sınırı (truncated) ve geçersiz parametre', async () => {
      const w = await world('NtfListe');
      const p = await w.party();
      await w.cheque(p.id, dayOf(1));
      await w.agenda({});
      await ok(w.c.post('/api/items', { name: 'Kritik kart', minLevel: '5' }), 201);
      await w.scan();
      expect(await w.kinds()).toEqual(['agenda_due', 'cheque_due', 'stock_below_min']);
      expect((await w.rows(w.c, 'status=active&kind=cheque_due')).map((n) => n.kind)).toEqual(['cheque_due']);
      const page = await ok(w.c.get('/api/notifications?limit=2'));
      expect(page.notifications).toHaveLength(2);
      expect(page.truncated).toBe(true);
      expect(page.unreadCount).toBe(3);
      const rest = await ok(w.c.get('/api/notifications?limit=2&offset=2'));
      expect(rest.notifications).toHaveLength(1);
      expect(rest.truncated).toBe(false);
      expect((await w.c.get('/api/notifications?kind=bilinmeyen')).statusCode).toBe(400);
      expect((await w.c.get('/api/notifications?limit=9999')).statusCode).toBe(400);
      // Kimlik doğrulama ve şirket başlığı
      expect((await app.inject({ method: 'GET', url: '/api/notifications' })).statusCode).toBe(401);
      expect((await client(app, w.s.token).get('/api/notifications')).statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('veritabanı koruyucusu (ERP25)', () => {
    it('içerik değiştirilemez; okundu/kapatıldı geri alınamaz; açık bildirim silinemez, kapanmış silinebilir; şirket üyesi olmayana eklenemez', async () => {
      const w = await world('NtfGuard');
      await w.agenda({});
      await w.scan();
      const id = (await w.active())[0]!.id;
      await asOwner(async (q) => {
        for (const col of ['title', 'body', 'link', 'kind', 'severity', 'dedupe_key']) {
          const e = await expectDbError(q, `update notifications set ${col} = ${col} || 'x' where id = $1`, [id]);
          expect(e.code, col).toBe('ERP25');
        }
        expect((await expectDbError(q, `update notifications set count = count + 1 where id = $1`, [id])).code).toBe('ERP25');
        expect((await expectDbError(q, `update notifications set user_id = $2 where id = $1`, [id, randomUUID()])).code).toMatch(/ERP25|23503/);
        expect((await expectDbError(q, `update notifications set bucket_date = bucket_date + 1 where id = $1`, [id])).code).toBe('ERP25');
        expect((await expectDbError(q, `update notifications set created_at = now() where id = $1`, [id])).code).toBe('ERP25');
        // Açık bildirim silinemez
        expect((await expectDbError(q, `delete from notifications where id = $1`, [id])).code).toBe('ERP25');
        // Okundu serbest; geri alınamaz
        await q(`update notifications set read_at = now() where id = $1`, [id]);
        expect((await expectDbError(q, `update notifications set read_at = null where id = $1`, [id])).code).toBe('ERP25');
        expect((await expectDbError(q, `update notifications set read_at = read_at + interval '1 minute' where id = $1`, [id])).code).toBe('ERP25');
        await q(`update notifications set dismissed_at = now() where id = $1`, [id]);
        expect((await expectDbError(q, `update notifications set dismissed_at = null where id = $1`, [id])).code).toBe('ERP25');
        // Çözüldü açılıp kapanabilir (koşul yeniden doğunca)
        await q(`update notifications set resolved_at = now() where id = $1`, [id]);
        await q(`update notifications set resolved_at = null where id = $1`, [id]);
        // Kapanmış (okunmuş) satır silinebilir
        await q(`delete from notifications where id = $1`, [id]);
        expect((await q(`select 1 from notifications where id = $1`, [id])).rows).toEqual([]);
        // Kapalı olarak ya da üye olmayana eklenemez
        const ins = (user: string, extra = '') =>
          `insert into notifications (id, company_id, user_id, kind, severity, title, link, dedupe_key, bucket_date${extra ? ', read_at' : ''}) values (gen_random_uuid(), '${w.company.id}', '${user}', 'cheque_due', 'info', 't', '/x', 'k', current_date${extra ? ', now()' : ''})`;
        expect((await expectDbError(q, ins(w.s.userId, 'read'))).code).toBe('ERP25');
        const stranger = await registerUser(app, 'NtfYabanci2');
        expect((await expectDbError(q, ins(stranger.userId))).code).toBe('ERP25');
      });
      // API'de ERP25 → 422 NOTIFICATION_RULE_VIOLATION eşlemesi
      const { mapError } = await import('../src/http/errors');
      expect(mapError(Object.assign(new Error('x'), { code: 'ERP25' }))?.code).toBe('NOTIFICATION_RULE_VIOLATION');
    });

    it('biçim kısıtları: bağlantı yalnızca iç yol; önem ve tür değerleri sınırlı; tercih kimliği sonradan değişmez', async () => {
      const w = await world('NtfBicim');
      await asOwner(async (q) => {
        const ins = (link: string, severity = 'info', kind = 'cheque_due') =>
          `insert into notifications (id, company_id, user_id, kind, severity, title, link, dedupe_key, bucket_date) values (gen_random_uuid(), '${w.company.id}', '${w.s.userId}', '${kind}', '${severity}', 't', '${link}', 'k', current_date)`;
        expect((await expectDbError(q, ins('//evil.example'))).code).toBe('23514');
        expect((await expectDbError(q, ins('https://evil.example'))).code).toBe('23514');
        expect((await expectDbError(q, ins('/ok', 'urgent'))).code).toBe('23514');
        expect((await expectDbError(q, ins('/ok', 'info', 'Bad Kind'))).code).toBe('23514');
        await q(ins('/ok'));
        await q(`insert into notification_preferences (company_id, user_id, kind) values ($1, $2, 'cheque_due')`, [w.company.id, w.s.userId]);
        expect((await expectDbError(q, `update notification_preferences set kind = 'agenda_due'`)).code).toBe('ERP25');
        expect((await expectDbError(q, `update notification_preferences set lead_days = 999`)).code).toBe('23514');
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('tercihler', () => {
    it('varsayılan: uygulama içi açık, e-posta kapalı; yalnızca kullanıcının alabileceği türler listelenir; kısmi güncelleme alanları korur', async () => {
      const w = await world('NtfTercih');
      const viewer = await addMember(app, w.c, w.company.id, 'viewer');
      const mine = await ok(w.c.get('/api/notification-preferences'));
      expect(mine.emailAvailable).toBe(false); // test uygulamasında SMTP yok
      const cheque = mine.kinds.find((k: any) => k.kind === 'cheque_due');
      expect(cheque).toMatchObject({ inApp: true, email: false, leadDays: null, leadDefault: 7, leadUnit: 'ahead', leadMin: 0, leadMax: 90, leadFromSetting: false });
      expect(mine.kinds.map((k: any) => k.kind)).toContain('license_expiring'); // sahip
      const v = await ok(viewer.client.get('/api/notification-preferences'));
      expect(v.kinds.map((k: any) => k.kind).sort()).toEqual(['approval_pending', 'cheque_due', 'guarantee_expiring', 'receivable_overdue', 'stock_below_min']);
      // Güncelle: yalnız e-posta; gün eşiği korunur
      await w.prefs([{ kind: 'cheque_due', leadDays: 12 }]);
      const after = await w.prefs([{ kind: 'cheque_due', email: true }]);
      expect(after.kinds.find((k: any) => k.kind === 'cheque_due')).toMatchObject({ inApp: true, email: true, leadDays: 12 });
      // Gün eşiğini kaldır
      const cleared = await w.prefs([{ kind: 'cheque_due', leadDays: null }]);
      expect(cleared.kinds.find((k: any) => k.kind === 'cheque_due')).toMatchObject({ leadDays: null, email: true });
      // Kullanıcıya özel: diğerinin tercihi değişmez
      const vcheque = (await ok(viewer.client.get('/api/notification-preferences'))).kinds.find((k: any) => k.kind === 'cheque_due');
      expect(vcheque).toMatchObject({ email: false, leadDays: null });
      // Kaynak ayarı varsa varsayılan olarak gösterilir
      await ok(w.c.put('/api/bank-guarantees/settings', { guaranteeWarningDays: 45 }));
      const g = (await ok(w.c.get('/api/notification-preferences'))).kinds.find((k: any) => k.kind === 'guarantee_expiring');
      expect(g).toMatchObject({ leadDefault: 45, leadFromSetting: true });
    });

    it('doğrulama: alınamayan tür 422, gün eşiği olmayan türe gün 422, aralık dışı 422/400; boş gövde 400', async () => {
      const w = await world('NtfTercihHata');
      const viewer = await addMember(app, w.c, w.company.id, 'viewer');
      const put = (cl: ReturnType<typeof client>, preferences: unknown) => cl.put('/api/notification-preferences', { preferences });
      expect((await put(viewer.client, [{ kind: 'foreign_doc_expiring', email: true }])).json().error.code).toBe('NOTIFICATION_KIND_UNAVAILABLE');
      expect((await put(w.c, [{ kind: 'stock_below_min', leadDays: 3 }])).json().error.code).toBe('NOTIFICATION_LEAD_NOT_SUPPORTED');
      expect((await put(w.c, [{ kind: 'cheque_due', leadDays: 91 }])).json().error.code).toBe('NOTIFICATION_LEAD_RANGE');
      expect((await put(w.c, [{ kind: 'license_expiring', leadDays: 0 }])).json().error.code).toBe('NOTIFICATION_LEAD_RANGE'); // en az 1
      expect((await put(w.c, [])).statusCode).toBe(400);
      expect((await put(w.c, [{ kind: 'yok' }])).statusCode).toBe(400);
      // Hatalı istek hiçbir şeyi değiştirmez (tek işlem)
      const bad = await put(w.c, [{ kind: 'cheque_due', email: true }, { kind: 'cheque_due', leadDays: 999 }]);
      expect(bad.statusCode).toBe(400);
      expect((await ok(w.c.get('/api/notification-preferences'))).kinds.find((k: any) => k.kind === 'cheque_due').email).toBe(false);
    });

    it('uygulama içini kapatmak o türü üretmez ve açık olanı hemen çözer; yeniden açınca aynı gün çözülmüş satır geri gelir', async () => {
      const w = await world('NtfTercihKapat');
      await w.agenda({});
      await w.scan();
      expect(await w.kinds()).toEqual(['agenda_due']);
      await w.prefs([{ kind: 'agenda_due', inApp: false }]);
      expect(await w.kinds()).toEqual([]); // hemen
      await w.agenda({ title: 'Yeni' });
      const r = await w.scan();
      expect(r.created).toBe(0);
      expect(await w.kinds()).toEqual([]);
      await w.prefs([{ kind: 'agenda_due', inApp: true }]);
      await w.scan();
      expect(await w.kinds()).toEqual(['agenda_due']);
      expect((await w.of('agenda_due'))!.count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('saklama (budama)', () => {
    it('süresi dolan kapanmış bildirimler silinir; açık, yeni ve başka şirketin satırlarına dokunulmaz', async () => {
      const a = await world('NtfBudaA');
      const b = await world('NtfBudaB');
      await a.agenda({});
      await a.scan();
      await b.agenda({});
      await b.scan();
      const open = (await a.active())[0]!;
      // Eski ve kapanmış satırlar: önce açık eklenir (koruyucu gereği), sonra kapanış zamanı geçmişe çekilir
      const seed = async (cid: string, uid: string, key: string, column: 'read_at' | 'resolved_at' | 'dismissed_at', daysAgo: number) => {
        await execAsOwner(
          `insert into notifications (id, company_id, user_id, kind, severity, title, link, dedupe_key, bucket_date, created_at) values (gen_random_uuid(), $1, $2, 'cheque_due', 'info', 't', '/x', $3, current_date - 200, now() - interval '200 days')`,
          [cid, uid, key],
        );
        // Koşul zaten kalkmış (çözülmüş) ve o günden beri kapalı: tarama bu satırları yeniden çözmez
        await execAsOwner(`update notifications set ${column === 'resolved_at' ? '' : `${column} = now() - ($3::int * interval '1 day'),`} resolved_at = now() - ($3::int * interval '1 day') where company_id = $1 and dedupe_key = $2`, [cid, key, daysAgo]);
      };
      await seed(a.company.id, a.s.userId, 'old-read', 'read_at', 120);
      await seed(a.company.id, a.s.userId, 'old-resolved', 'resolved_at', 100);
      await seed(a.company.id, a.s.userId, 'old-dismissed', 'dismissed_at', 95);
      await seed(a.company.id, a.s.userId, 'recent-read', 'read_at', 10);
      await seed(b.company.id, b.s.userId, 'b-old-read', 'read_at', 120);
      // Açık ama çok eski (okunmamış, çözülmemiş): silinmez
      await execAsOwner(
        `insert into notifications (id, company_id, user_id, kind, severity, title, link, dedupe_key, bucket_date, created_at) values (gen_random_uuid(), $1, $2, 'cheque_due', 'info', 't', '/x', 'old-open', current_date - 300, now() - interval '300 days')`,
        [a.company.id, a.s.userId],
      );
      const r = await a.scan({ retentionDays: 90 });
      expect(r.pruned).toBe(3);
      const keys = (await execAsOwner(`select dedupe_key from notifications where company_id = $1 order by 1`, [a.company.id])).rows.map((x) => x.dedupe_key as string);
      expect(keys).toContain('old-open');
      expect(keys).toContain('recent-read');
      expect(keys).not.toContain('old-read');
      expect(keys).not.toContain('old-resolved');
      expect(keys).not.toContain('old-dismissed');
      expect((await a.active()).map((n) => n.id)).toContain(open.id);
      // Başka şirketin eski satırı bu taramada silinmedi
      expect((await execAsOwner(`select count(*)::int as n from notifications where company_id = $1 and dedupe_key = 'b-old-read'`, [b.company.id])).rows[0].n).toBe(1);
      expect((await b.scan({ retentionDays: 90 })).pruned).toBe(1);
      // Uygulama rolü doğrudan silemez (yalnızca notification_prune işlevi)
      await asDb(handle, { userId: a.s.userId, orgId: a.orgId, companyId: a.company.id }, async (q) => {
        expect((await expectDbError(q, `delete from notifications`)).code).toBe('42501');
        expect((await expectDbError(q, `select notification_prune(0)`)).code).toBe('ERP25');
      });
    });
  });

  describe('uzun süren durum', () => {
    it('okunmuş ama koşulu süren bildirim saklama süresi sonunda silinir ve sonraki taramada yeniden (okunmamış) doğar', async () => {
      const w = await world('NtfUzun');
      await w.agenda({});
      expect((await w.scan()).created).toBe(1);
      const id = (await w.active())[0]!.id;
      // 100 gün önce okunmuş say (koruyucu gereği okundu işareti yalnızca boştan doluya yazılır)
      await execAsOwner(`update notifications set read_at = now() - interval '100 days' where id = $1`, [id]);
      const r2 = await w.scan({ retentionDays: 90 });
      expect(r2).toMatchObject({ created: 0, pruned: 1 });
      expect(await w.rows()).toEqual([]);
      const r3 = await w.scan({ retentionDays: 90 });
      expect(r3.created).toBe(1);
      expect(await w.of('agenda_due')).toMatchObject({ readAt: null, count: 1 });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('e-posta özeti', () => {
    const base = 'https://erp.ornek.test';
    const hour = (h: number, n = 0) => new Date(`${addDaysIso(TODAY, n)}T${String(h).padStart(2, '0')}:00:00Z`); // UTC; yerel saat = h+2/h+3
    const mailOpts = (sent: MailMessage[], extra: Partial<ScanOptions> = {}): ScanOptions => ({ enqueueMail: (m) => sent.push(m), baseUrl: base, digestHour: 0, ...extra });

    it('tercih açıkken günde en çok bir özet: tür başına sayı + bağlantı; ad, numara, tutar yok; ertesi gün yeniden', async () => {
      const w = await world('NtfEposta');
      const p = await w.party('Gizli Müşteri Ltd.');
      await w.cheque(p.id, dayOf(2), { docNo: 'GIZLI-NO-5', amount: '77777.77' });
      await w.agenda({ title: 'Özel görüşme: Ali Bey ile' });
      await w.prefs([{ kind: 'cheque_due', email: true }]); // yalnız çek özetlenir
      const sent: MailMessage[] = [];
      const r1 = await w.scan(mailOpts(sent));
      expect(r1.digests).toBe(1);
      expect(sent).toHaveLength(1);
      const m = sent[0]!;
      expect(m.to).toBe(w.s.email);
      expect(m.subject).toBe('Bildirim özeti: 1 okunmamış bildirim');
      expect(m.text).toContain('Vadesi gelen ya da geçen çek/senet: 1');
      expect(m.text).toContain(`${base}/notifications`);
      expect(m.text).not.toContain('ajanda'); // e-postası açılmayan tür girmez
      const blob = `${m.subject}\n${m.text}\n${m.html}`;
      for (const secret of ['Gizli Müşteri', 'GIZLI-NO-5', '77777', 'Ali Bey', 'Test Bankası']) expect(blob).not.toContain(secret);
      // Aynı gün ikinci tarama: yeni özet yok
      const r2 = await w.scan(mailOpts(sent));
      expect(r2.digests).toBe(0);
      expect(sent).toHaveLength(1);
      // Aynı gün ikinci özet için DB kaydı tek satır
      expect((await execAsOwner(`select count(*)::int as n from notification_digests where company_id = $1`, [w.company.id])).rows[0].n).toBe(1);
      // Ertesi gün: hâlâ okunmamış → yeni özet
      const r3 = await w.scan(mailOpts(sent, { now: at(1) }));
      expect(r3.digests).toBe(1);
      expect(sent).toHaveLength(2);
    });

    it('e-posta yapılandırılmamışsa (enqueueMail yok) özet üretilmez ve kayıt yazılmaz; kapalı kullanıcıya gitmez; okunmuş bildirim özete girmez; saat öncesi gitmez', async () => {
      const w = await world('NtfEpostaYok');
      const acct = await addMember(app, w.c, w.company.id, 'accountant');
      await w.agenda({ ownerId: null }); // şirket ajandası: ikisine de gider
      await w.prefs([{ kind: 'agenda_due', email: true }]);
      await w.prefs([{ kind: 'agenda_due', email: true }], acct.client);
      // SMTP kapalı: hiçbir şey
      const r0 = await w.scan({});
      expect(r0.digests).toBe(0);
      expect((await execAsOwner(`select count(*)::int as n from notification_digests where company_id = $1`, [w.company.id])).rows[0].n).toBe(0);
      // Saat gelmeden (yerel 08:00'den önce) gitmez: UTC 03:00 = yerel 05:00/06:00
      const sent: MailMessage[] = [];
      expect((await w.scan({ ...mailOpts(sent), digestHour: 8, now: hour(3) })).digests).toBe(0);
      expect(sent).toHaveLength(0);
      // Sahibi okudu → özette yok; muhasebeci okumadı → gider
      const mineN = (await w.active())[0]!;
      await ok(w.c.post(`/api/notifications/${mineN.id}/read`));
      const r = await w.scan({ ...mailOpts(sent), digestHour: 8, now: hour(12) });
      expect(r.digests).toBe(1);
      expect(sent.map((m) => m.to)).toEqual([acct.email]);
      // Kapalı tercihli kullanıcı hiç almaz
      const w2 = await world('NtfEpostaKapali');
      await w2.agenda({});
      const sent2: MailMessage[] = [];
      expect((await w2.scan(mailOpts(sent2))).digests).toBe(0);
      expect(sent2).toEqual([]);
    });

    it('gönderim işlem tamamlandıktan sonra; posta hatası taramayı bozmaz; özet kaydı gönderimi kısmaz (en çok bir kez)', async () => {
      const w = await world('NtfEpostaHata');
      await w.agenda({});
      await w.prefs([{ kind: 'agenda_due', email: true }]);
      const calls: string[] = [];
      const r = await w.scan({ ...mailOpts([]), enqueueMail: (m) => { calls.push(m.subject); throw new Error('SMTP bağlantı hatası'); } });
      // Gönderime verme hatası taramayı bozmaz; özet kaydı işlemle birlikte yazılmıştır
      expect(r).toMatchObject({ digests: 1, skipped: false });
      expect(calls).toHaveLength(1);
      expect((await execAsOwner(`select count(*)::int as n from notification_digests where company_id = $1`, [w.company.id])).rows[0].n).toBe(1);
      const sent: MailMessage[] = [];
      expect((await w.scan(mailOpts(sent))).digests).toBe(0); // aynı gün yeniden denenmez
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('çoklu örnek güvenliği (advisory kilidi) ve gün sınırı', () => {
    it('kilit başka bir işlemdeyse zamanlayıcı kipi o şirketi atlar (hiçbir şey yazılmaz); serbest kalınca tarar', async () => {
      const w = await world('NtfKilit');
      await w.agenda({});
      const holder = await handle.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`select pg_advisory_xact_lock(${0x4e4f5449}::int, hashtext($1::text))`, [w.company.id]);
        const r = await scanCompany(handle.db, { companyId: w.company.id, orgId: w.orgId }, { wait: false });
        expect(r).toMatchObject({ skipped: true, created: 0 });
        expect(await w.rows()).toEqual([]);
        // Başka bir şirket etkilenmez
        const other = await world('NtfKilitDiger');
        await other.agenda({});
        expect(await other.scan({ wait: false })).toMatchObject({ skipped: false, created: 1 });
        // Bekleyen (elle) tarama kilit bırakılınca devam eder
        const waiting = w.scan({ wait: true });
        let done = false;
        void waiting.then(() => (done = true));
        await new Promise((r2) => setTimeout(r2, 300));
        expect(done).toBe(false);
        await holder.query('COMMIT');
        const res = await waiting;
        expect(res).toMatchObject({ skipped: false, created: 1 });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      expect(await w.rows()).toHaveLength(1);
    });

    it('iki örnek aynı anda tararsa tek kopya üretilir (paralel tarama)', async () => {
      const w = await world('NtfParalel');
      const p = await w.party();
      await w.cheque(p.id, dayOf(1));
      await w.agenda({});
      for (let round = 0; round < 3; round++) {
        const results = await Promise.all([w.scan({ wait: false }), w.scan({ wait: false }), w.scan({ wait: true })]);
        expect(results.reduce((s, r) => s + r.created, 0)).toBe(round === 0 ? 2 : 0);
      }
      const all = await w.rows();
      expect(all).toHaveLength(2);
      expect(all.filter((n) => !n.resolvedAt)).toHaveLength(2);
      // Veritabanı kısıtı ikinci savunmadır: aynı anahtar çift yazılamaz
      const dup = (await execAsOwner(`select company_id, user_id, kind, dedupe_key, bucket_date from notifications where company_id = $1 limit 1`, [w.company.id])).rows[0];
      await asOwner(async (q) => {
        const e = await expectDbError(
          q,
          `insert into notifications (id, company_id, user_id, kind, severity, title, link, dedupe_key, bucket_date) values (gen_random_uuid(), $1, $2, $3, 'info', 't', '/x', $4, $5)`,
          [dup.company_id, dup.user_id, dup.kind, dup.dedupe_key, dup.bucket_date],
        );
        expect(e.code).toBe('23505');
      });
    });

    it('gün sınırı Europe/Nicosia: yerel gece yarısından önce/sonra aynı kalem bugün olur ya da olmaz; bucket_date yerel gündür', async () => {
      const w = await world('NtfGun');
      await w.agenda({ title: 'Yılbaşı', dueDate: '2031-01-11' });
      // Kış (UTC+2): 2031-01-10 21:59Z = yerel 23:59 (10 Ocak) → kalem yarın
      await w.scan({ now: new Date('2031-01-10T21:59:00Z') });
      expect(await w.of('agenda_due')).toBeUndefined();
      // 22:00Z = yerel 00:00 (11 Ocak) → bugün
      await w.scan({ now: new Date('2031-01-10T22:00:00Z') });
      expect(await w.of('agenda_due')).toMatchObject({ count: 1 });
      const bucket = (await execAsOwner(`select bucket_date::text as d from notifications where company_id = $1`, [w.company.id])).rows[0].d;
      expect(bucket).toBe('2031-01-11');
      // Yaz (UTC+3): 2031-07-10 21:00Z = yerel 00:00 (11 Temmuz)
      const s = await world('NtfGunYaz');
      await s.agenda({ title: 'Yaz', dueDate: '2031-07-11' });
      await s.scan({ now: new Date('2031-07-10T20:59:00Z') });
      expect(await s.of('agenda_due')).toBeUndefined();
      await s.scan({ now: new Date('2031-07-10T21:00:00Z') });
      expect(await s.of('agenda_due')).toMatchObject({ count: 1 });
    });

    it('bir kaynağın hatası diğerlerini ve işlemi bozmaz; hata veren türün açık bildirimi çözülmeden kalır', async () => {
      const w = await world('NtfHataliKaynak');
      await w.agenda({});
      await w.scan();
      expect(await w.kinds()).toEqual(['agenda_due']);
      // Gerçek bir kaynak sorgusu hata versin: ajanda tablosunu geçici olarak yeniden adlandır (yalnızca bu test şirketini değil tüm şemayı etkiler, hemen geri alınır)
      const sources = await import('../src/modules/notifications/sources');
      const orig = sources.NOTIFICATION_SOURCES.agenda_due.scan;
      (sources.NOTIFICATION_SOURCES.agenda_due as { scan: typeof orig }).scan = async () => {
        throw new Error('kaynak hatası');
      };
      try {
        const p = await w.party();
        await w.cheque(p.id, dayOf(1));
        const r = await w.scan();
        expect(r.failedKinds).toEqual(['agenda_due']);
        expect(r.created).toBe(1); // çek bildirimi yine üretildi
        expect(await w.kinds()).toEqual(['agenda_due', 'cheque_due']); // ajanda bildirimi çözülmeden kaldı
      } finally {
        (sources.NOTIFICATION_SOURCES.agenda_due as { scan: typeof orig }).scan = orig;
      }
      expect((await w.scan()).failedKinds).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('uç noktalar', () => {
    it('elle tarama yalnızca yönetim iznine (sahip/yönetici) açıktır; sonuç özeti döner; diğer roller kendi bildirimini okur', async () => {
      const w = await world('NtfUc');
      const acct = await addMember(app, w.c, w.company.id, 'accountant');
      const viewer = await addMember(app, w.c, w.company.id, 'viewer');
      const admin = await addMember(app, w.c, w.company.id, 'admin');
      await w.agenda({});
      expect((await acct.client.post('/api/notifications/scan')).statusCode).toBe(403);
      expect((await viewer.client.post('/api/notifications/scan')).statusCode).toBe(403);
      const res = await ok(admin.client.post('/api/notifications/scan'));
      expect(res.result).toMatchObject({ companyId: w.company.id, skipped: false, created: 1, failedKinds: [] });
      expect((await w.of('agenda_due'))).toBeDefined();
      // Her üye kendi bildirimlerini okuyabilir (izleyici dahil)
      expect((await viewer.client.get('/api/notifications')).statusCode).toBe(200);
      expect((await viewer.client.get('/api/notifications/unread-count')).statusCode).toBe(200);
      // Başka şirkete başlıkla erişim: üye değil
      const other = await world('NtfUcDiger');
      expect((await client(app, w.s.token, other.company.id).get('/api/notifications')).statusCode).toBe(403);
      // Oturumdaki kullanıcı yoksa tarama yok
      expect((await app.inject({ method: 'POST', url: '/api/notifications/scan', headers: { 'x-company-id': w.company.id } })).statusCode).toBe(401);
    });

    it('perakende şirkette inşaata özgü kaynaklar (onay, yabancı işçi vb. modül yoksa) hiç sayılmaz', async () => {
      const w = await world('NtfPerakende', 'RETAIL_MARKET');
      const prefs = (await ok(w.c.get('/api/notification-preferences'))).kinds.map((k: any) => k.kind) as string[];
      expect(prefs).not.toContain('approval_pending'); // inşaat modülleri yok
      expect(prefs).toContain('cheque_due');
      expect(prefs).toContain('stock_below_min');
      const r = await w.scan();
      expect(r.failedKinds).toEqual([]);
    });
  });
});
