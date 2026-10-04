/**
 * Demo verisi: çek/senet portföyü, banka teminat mektupları, gider fişleri ve kartları, kişi/kurum rehberi ve ajanda.
 * `seedDemo` sonunda çağrılır. Her şey gerçek servis akışlarıyla girilir (yevmiye otomatik oluşur); tarihler "bugün"e göre
 * ve açık (kapatılmamış) dönemlere düşecek biçimde seçilir.
 */
import { eq, sql } from 'drizzle-orm';
import { todayIso } from '@erp/shared';
import type { Tx } from './client';
import { projects, users } from './schema';
import { createAgendaItem, createFollowUp, setAgendaStatus } from '../modules/directory/agenda';
import { createContact, createNote, createOrganization } from '../modules/directory/service';
import { createExpenseCard, createExpenseEntry } from '../modules/expenses/service';
import { createCheque, runChequeAction } from '../modules/cheques/service';
import { createGuarantee, resolveGuarantee, updateSettings } from '../modules/cheques/guarantees';
import { openItemsFor } from '../modules/parties/service';
import type { LedgerCtx } from '../modules/ledger/journal';

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

interface MiscOpts {
  partyId: Map<string, string>;
  acc: (code: string) => string;
  bankTlId: string;
  cashId: string;
}

export async function seedPortfolio(tx: Tx, ctx: LedgerCtx, o: MiscOpts): Promise<string> {
  const today = todayIso();
  // Kapalı dönemlere (Ocak–Haziran) düşmesin: en erken tarih Temmuz başı; yılın ilk yarısındaki bir "bugün"de ise yılın ilk günü
  // (önceki yılın dönemi yoktur, gelecekteki Temmuz da bugünden sonradır)
  const year = today.slice(0, 4);
  const floor = today >= `${year}-07-01` ? `${year}-07-01` : `${year}-01-01`;
  const at = (n: number) => {
    const d = addDays(today, n);
    return d < floor ? floor : d;
  };
  const p = (k: string) => o.partyId.get(k)!;
  const cheque = (input: Parameters<typeof createCheque>[2]) => createCheque(tx, ctx, { registerDate: input.issueDate, ...input });
  const act = (input: Parameters<typeof runChequeAction>[2]) => runChequeAction(tx, ctx, input);
  const idOf = (r: unknown) => ((r as { id?: string; cheque?: { id: string } }).id ?? (r as { cheque: { id: string } }).cheque.id);

  // Alınan: portföyde bekleyen çek (vadesi ileride); carinin en eski açık kalemine kısmen eşleştirilir
  // Çek yalnızca defter para biriminde işlenir: eşleştirme kalemi de TL olmalı ve kısmi kapatmada kapatılan tutar karşılığa eşittir.
  // (Kur farkından kalan kuruşluk/dövizli artık kalemler eşleştirilmez: kalem para biriminde 0 tutar oransız kur üretir.)
  const aliOpen = (await openItemsFor(tx, p('ali'), 'receivable', at(-40))).items.find((i) => i.currencyCode === ctx.baseCurrency && Number(i.remaining) > 0);
  const aliSettle = aliOpen ? Math.min(100000, Number(aliOpen.remaining)).toFixed(2) : '0';
  await cheque({
    direction: 'received', docType: 'cheque', docNo: 'ÇK-100231', bankName: 'Örnek Banka', branch: 'Lefkoşa', partyId: p('ali'), amount: '150000', issueDate: at(-40), dueDate: addDays(today, 20), description: 'A Blok daire bedeli — 2. taksit',
    items: aliOpen ? [{ lineId: aliOpen.lineId, amount: aliSettle, settleAmount: aliSettle }] : [],
  });
  // Alınan: tahsile verilip tahsil edilen çek
  const collected = await cheque({ direction: 'received', docType: 'cheque', docNo: 'ÇK-100198', bankName: 'Örnek Banka', branch: 'Girne', partyId: p('ali'), amount: '80000', issueDate: at(-50), dueDate: at(-10), items: [] });
  await act({ action: 'deposit', chequeIds: [idOf(collected)], date: at(-9), bankAccountId: o.bankTlId, items: [] });
  await act({ action: 'collect', chequeIds: [idOf(collected)], date: at(-4), items: [] });
  // Alınan: karşılıksız çıkan çek
  const bounced = await cheque({ direction: 'received', docType: 'cheque', docNo: 'ÇK-100244', bankName: 'Doğu Bankası', partyId: p('ali'), amount: '25000', issueDate: at(-45), dueDate: at(-15), items: [] });
  await act({ action: 'deposit', chequeIds: [idOf(bounced)], date: at(-14), bankAccountId: o.bankTlId, items: [] });
  await act({ action: 'bounce', chequeIds: [idOf(bounced)], date: at(-9), note: 'Karşılıksız', items: [] });
  // Alınan: senet, tedarikçiye ciro edilir
  const endorsed = await cheque({ direction: 'received', docType: 'note', docNo: 'SN-2026-017', bankName: '', partyId: p('sarah'), amount: '40000', issueDate: at(-30), dueDate: addDays(today, 45), description: 'Seramik bedeli senedi', items: [] });
  await act({ action: 'endorse', chequeIds: [idOf(endorsed)], date: at(-2), partyId: p('beton'), items: [] });
  // Alınan: vadesi bu hafta içinde olan senet (hatırlatma)
  await cheque({ direction: 'received', docType: 'note', docNo: 'SN-2026-021', bankName: '', partyId: p('sarah'), amount: '18000', issueDate: at(-60), dueDate: addDays(today, 5), items: [] });
  // Verilen: tedarikçiye çek (vade ileride) ve ödenen senet
  await cheque({ direction: 'issued', docType: 'cheque', docNo: 'KÇ-7001', bankName: 'Örnek Banka', branch: 'Lefkoşa', partyId: p('demir'), amount: '120000', issueDate: at(-12), dueDate: addDays(today, 30), description: 'Demir faturası ödemesi', items: [] });
  const paid = await cheque({ direction: 'issued', docType: 'note', docNo: 'BS-2026-004', bankName: '', partyId: p('oto'), amount: '60000', issueDate: at(-40), dueDate: at(-4), items: [] });
  await act({ action: 'pay', chequeIds: [idOf(paid)], date: at(-3), bankAccountId: o.bankTlId, items: [] });

  // ---- Banka teminat mektupları (nazım takip) ----
  const gctx = { companyId: ctx.companyId, userId: ctx.userId };
  await updateSettings(tx, gctx, { guaranteeWarningDays: 30 });
  const kuzey = (await tx.select({ id: projects.id }).from(projects).where(eq(projects.code, 'PRJ-0002')))[0]?.id ?? null;
  const gunes = (await tx.select({ id: projects.id }).from(projects).where(eq(projects.code, 'PRJ-0001')))[0]?.id ?? null;
  await createGuarantee(tx, gctx, { direction: 'given', letterNo: 'TM-2026-014', bankName: 'Örnek Banka', branch: 'Lefkoşa', counterpartyName: 'Kuzey Villa işvereni', projectId: kuzey, purpose: 'Kesin teminat', amount: '250000', currencyCode: 'TRY', issueDate: at(-120), expiryDate: addDays(today, 70), commissionRate: '1.5', commissionNote: 'Yıllık komisyon %1,5 (demo)' });
  await createGuarantee(tx, gctx, { direction: 'received', letterNo: 'TM-2026-DS-3', bankName: 'Doğu Bankası', partyId: p('usta'), projectId: gunes, purpose: 'Taşeron avans teminatı', amount: '50000', currencyCode: 'TRY', issueDate: at(-90), expiryDate: addDays(today, 18) });
  const old = await createGuarantee(tx, gctx, { direction: 'given', letterNo: 'TM-2025-088', bankName: 'Örnek Banka', counterpartyName: 'Lefkoşa Belediyesi', purpose: 'Geçici teminat', amount: '75000', currencyCode: 'TRY', issueDate: at(-150), expiryDate: at(-20) });
  await resolveGuarantee(tx, (old as { id: string }).id, { status: 'returned', resolvedDate: at(-18), note: 'İhale sonrası iade alındı' });

  return 'çek/senet: 8 belge (portföy, tahsil, karşılıksız, ciro, verilen/ödenen), teminat mektubu: 3';
}

export async function seedExpenses(tx: Tx, ctx: LedgerCtx, o: MiscOpts): Promise<string> {
  const today = todayIso();
  const year = today.slice(0, 4);
  const floor = today >= `${year}-07-01` ? `${year}-07-01` : `${year}-01-01`;
  const at = (n: number) => {
    const d = addDays(today, n);
    return d < floor ? floor : d;
  };
  const gunes = (await tx.select({ id: projects.id }).from(projects).where(eq(projects.code, 'PRJ-0001')))[0]?.id ?? null;
  const card = async (code: string, name: string, accountCode: string, extra: Record<string, unknown> = {}) =>
    (await createExpenseCard(tx, ctx.companyId, { code, name, accountId: o.acc(accountCode), taxCode: 'KDV-16', ...extra } as never)) as { id: string };
  const fuel = await card('YKT', 'Akaryakıt', '770', { projectId: gunes, notes: 'Şantiye araçları' });
  const meal = await card('YMK', 'Yemek ve ikram', '770', { taxCode: 'KDV-10' });
  const rent = await card('KRA', 'Ofis / depo kirası', '770', { withholdingRate: '20', notes: 'Stopaj oranı kullanıcı verisidir (demo)' });
  const phone = await card('HBR', 'Haberleşme', '770');

  const entry = (input: Record<string, unknown>) => createExpenseEntry(tx, ctx, input as never);
  await entry({ entryDate: at(-20), cardId: fuel.id, description: 'Şantiye araçları akaryakıt', paymentKind: 'treasury', treasuryAccountId: o.cashId, net: '2850', documentRef: 'Fiş 004211' });
  await entry({ entryDate: at(-12), cardId: meal.id, description: 'Beton dökümü günü ekip yemeği', paymentKind: 'treasury', treasuryAccountId: o.cashId, net: '1400', documentRef: 'Fiş 0097' });
  await entry({ entryDate: at(-9), cardId: rent.id, description: 'Şantiye ofisi kirası (bu ay)', paymentKind: 'party', partyId: o.partyId.get('oto')!, dueDate: addDays(today, 10), net: '45000', documentRef: 'Kira sözleşmesi KS-12' });
  await entry({ entryDate: at(-6), cardId: phone.id, description: 'Şantiye internet ve telefon', paymentKind: 'treasury', treasuryAccountId: o.bankTlId, net: '980', taxCode: 'KDV-16' });
  const wrong = await entry({ entryDate: at(-5), cardId: fuel.id, description: 'Yanlış girilen akaryakıt fişi', paymentKind: 'treasury', treasuryAccountId: o.cashId, net: '9999' });
  const { cancelExpenseEntry } = await import('../modules/expenses/service');
  await cancelExpenseEntry(tx, ctx, ((wrong as { entry?: { id: string } }).entry ?? (wrong as { id: string })).id, { reason: 'Tutar hatalı girildi', date: at(-4) });
  await entry({ entryDate: at(-2), cardId: fuel.id, description: 'Jeneratör yakıtı', paymentKind: 'treasury', treasuryAccountId: o.cashId, net: '1750' });
  return 'gider: 4 kart, 6 fiş (1 iptal)';
}

export async function seedDirectory(tx: Tx, ctx: LedgerCtx, o: { partyId: Map<string, string> }): Promise<string> {
  const today = todayIso();
  const dctx = { companyId: ctx.companyId, userId: ctx.userId };
  const [acct] = await tx.select({ id: users.id }).from(users).where(eq(users.email, 'muhasebe@ornek.local'));
  const gunes = (await tx.select({ id: projects.id }).from(projects).where(eq(projects.code, 'PRJ-0001')))[0]?.id ?? null;
  const org = async (name: string, category: string, extra: Record<string, unknown> = {}) => (await createOrganization(tx, dctx, { name, category, ...extra } as never)).organization as { id: string };
  const person = async (fullName: string, extra: Record<string, unknown> = {}) => (await createContact(tx, dctx, { fullName, ...extra } as never)).contact as { id: string };

  const bank = await org('Örnek Banka — Lefkoşa Şubesi', 'Banka', { address: 'Girne Cad. 12, Lefkoşa', phone: '0392 600 10 20', web: 'ornekbanka.example' });
  const belediye = await org('Lefkoşa Belediyesi İmar Müdürlüğü', 'Kamu kurumu', { phone: '0392 600 30 40', note: 'Yapı ruhsatı ve iskân işlemleri' });
  const demirOrg = await org('Demir Çelik A.Ş.', 'Tedarikçi', { partyId: o.partyId.get('demir')!, phone: '0392 222 33 44', email: 'satis@demircelik.example' });
  const mimar = await org('Aksu Mimarlık Ofisi', 'Danışman', { phone: '0533 410 20 30', email: 'info@aksumimarlik.example' });

  const bankaci = await person('Selin Aydın', { title: 'Kurumsal müşteri temsilcisi', organizationId: bank.id, phone: '0533 555 10 10', email: 'selin.aydin@ornekbanka.example', tags: ['banka', 'kredi'] });
  const memur = await person('Kemal Erdem', { title: 'İmar kontrol mühendisi', organizationId: belediye.id, phone: '0542 777 20 20', tags: ['kamu', 'ruhsat'] });
  const satis = await person('Ahmet Çelik', { title: 'Satış müdürü', organizationId: demirOrg.id, phone: '0533 222 44 66', email: 'ahmet.celik@demircelik.example', partyId: o.partyId.get('demir')!, tags: ['tedarikçi', 'demir'] });
  await person('Deniz Aksu', { title: 'Mimar', organizationId: mimar.id, phone: '0533 410 20 31', projectId: gunes, tags: ['proje', 'danışman'] });
  await person('Ali Yılmaz', { phone: '0533 111 22 33', partyId: o.partyId.get('ali')!, tags: ['müşteri'], note: 'A Blok daire alıcısı' });

  const n1 = await createNote(tx, dctx, { contactId: bankaci.id, organizationId: bank.id, kind: 'meeting', noteDate: addDays(today, -14), summary: 'İşletme kredisi limit artışı görüşüldü; teminat olarak teminat mektubu ve çek portföyü istendi.', visibility: 'shared' } as never);
  await createNote(tx, dctx, { contactId: memur.id, kind: 'call', noteDate: addDays(today, -6), summary: 'B Blok iskân başvurusu için eksik evrak listesi telefonla alındı.', visibility: 'shared', projectId: gunes } as never);
  await createNote(tx, dctx, { contactId: satis.id, kind: 'email', noteDate: addDays(today, -3), summary: 'Ekim ayı demir fiyat teklifi istendi; yanıt bekleniyor.', visibility: 'private' } as never);

  const actx = { companyId: ctx.companyId, userId: ctx.userId, canManage: true };
  const noteId = (n1.note as { id: string }).id;
  await createFollowUp(tx, actx, noteId, { dueDate: addDays(today, 3), remindBeforeMinutes: 1440 });
  await createAgendaItem(tx, actx, { kind: 'appointment', title: 'Belediye ile iskân randevusu', description: 'Evrak teslimi', dueDate: addDays(today, 5), allDay: false, startTime: '10:30', endTime: '11:30', remindBeforeMinutes: 60, ownerId: ctx.userId, contactId: memur.id, organizationId: belediye.id, projectId: gunes });
  await createAgendaItem(tx, actx, { kind: 'task', title: 'Ekim demir teklifini karşılaştır', dueDate: addDays(today, 2), allDay: true, ownerId: acct?.id ?? ctx.userId, contactId: satis.id, partyId: o.partyId.get('demir')! });
  await createAgendaItem(tx, actx, { kind: 'task', title: 'Vadesi gelen çekleri bankaya ver', dueDate: addDays(today, 4), allDay: true, ownerId: null });
  const done = await createAgendaItem(tx, actx, { kind: 'task', title: 'Teminat mektubu yenileme talebi', dueDate: addDays(today, -5), allDay: true, ownerId: ctx.userId });
  await setAgendaStatus(tx, actx, (done.item as { id: string }).id, 'done');
  await createAgendaItem(tx, actx, { kind: 'task', title: 'Eylül puantaj kontrolü (gecikmiş)', dueDate: addDays(today, -2), allDay: true, ownerId: ctx.userId });
  void sql;
  return 'rehber: 4 kurum, 5 kişi, 3 not; ajanda: 6 kalem';
}
