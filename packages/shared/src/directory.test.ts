import { describe, expect, it } from 'vitest';
import { AGENDA_UPCOMING_DAYS, agendaBucket, buildVCard, buildVCards, emailKey, normalizeTags, phoneKey, planContactMerge, type ContactFields } from './directory';
import { createAgendaSchema, createContactSchema, createNoteSchema, updateAgendaSchema, updateOrganizationSchema } from './schemas/directory';
import { createDsrSchema } from './schemas/hr';

const blank: ContactFields = { fullName: 'A', title: null, organizationId: null, phone: null, phone2: null, email: null, email2: null, address: null, partyId: null, employeeId: null, projectId: null, tags: [], note: null };

describe('rehber: eşleme anahtarları', () => {
  it('telefon: yalnız rakamlar, son 10 hane; kısa numara eşlenmez', () => {
    expect(phoneKey('+90 392 222 00 00')).toBe('3922220000');
    expect(phoneKey('0392-222-00-00')).toBe('3922220000');
    expect(phoneKey('(0392) 222 0000')).toBe('3922220000');
    expect(phoneKey('12345')).toBeNull();
    expect(phoneKey('')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
  it('e-posta: küçük harf, kırpılmış', () => {
    expect(emailKey('  Ali@Ornek.COM ')).toBe('ali@ornek.com');
    expect(emailKey('')).toBeNull();
  });
  it('etiket: kırpar, tekilleştirir (Türkçe büyük/küçük), sınırlar', () => {
    expect(normalizeTags(' Banka, banka ;  İnşaat\n usta  usta ,,')).toEqual(['Banka', 'İnşaat', 'usta usta']);
    expect(normalizeTags(['İş', 'iş'])).toEqual(['İş']);
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
    expect(normalizeTags('x'.repeat(100))[0]).toHaveLength(40);
    expect(normalizeTags(null)).toEqual([]);
  });
});

describe('rehber: birleştirme planı', () => {
  it('asıl kişinin dolu alanları korunur, boşlar doldurulur, farklı telefon/e-posta ikinci alana taşınır', () => {
    const keep = { ...blank, fullName: 'Asıl', phone: '0392 111 11 11', title: 'Müdür', tags: ['a'], note: 'bir' };
    const drop = { ...blank, fullName: 'Kopya', phone: '+90 392 111 11 11', phone2: '0533 000 00 00', email: 'x@y.com', title: 'Başka', address: 'Girne', tags: ['A', 'b'], note: 'iki' };
    const { merged, conflicts } = planContactMerge(keep, drop);
    expect(merged).toMatchObject({ fullName: 'Asıl', title: 'Müdür', phone: '0392 111 11 11', phone2: '0533 000 00 00', email: 'x@y.com', address: 'Girne', tags: ['a', 'b'], note: 'bir\niki' });
    expect(conflicts).toEqual(['title']);
  });
  it('sığmayan üçüncü telefon atılır', () => {
    const { merged } = planContactMerge({ ...blank, phone: '0392 111 11 11', phone2: '0392 222 22 22' }, { ...blank, phone: '0392 333 33 33' });
    expect([merged.phone, merged.phone2]).toEqual(['0392 111 11 11', '0392 222 22 22']);
  });
});

describe('ajanda kovaları', () => {
  const today = '2026-10-02';
  it('açık kalem: gecikmiş / bugün / yaklaşan / ileri; kapalı kalem closed', () => {
    expect(agendaBucket({ status: 'open', dueDate: '2026-10-01' }, today)).toBe('overdue');
    expect(agendaBucket({ status: 'open', dueDate: today }, today)).toBe('today');
    expect(agendaBucket({ status: 'open', dueDate: '2026-10-03' }, today)).toBe('upcoming');
    expect(agendaBucket({ status: 'open', dueDate: '2026-10-09' }, today)).toBe('upcoming');
    expect(AGENDA_UPCOMING_DAYS).toBe(7);
    expect(agendaBucket({ status: 'open', dueDate: '2026-10-10' }, today)).toBe('later');
    expect(agendaBucket({ status: 'done', dueDate: '2026-10-01' }, today)).toBe('closed');
    expect(agendaBucket({ status: 'cancelled', dueDate: today }, today)).toBe('closed');
  });
  it('ay/yıl sınırı', () => {
    expect(agendaBucket({ status: 'open', dueDate: '2027-01-02' }, '2026-12-31')).toBe('upcoming');
  });
});

describe('vCard 3.0', () => {
  it('alanlar, kaçışlar ve CRLF', () => {
    const v = buildVCard({ fullName: 'Ayşe Nur Kaya', title: 'Müdür', organizationName: 'A; B, C', phone: '0392 1', phone2: '0533 2', email: 'a@b.com', address: 'Girne,\nKKTC', tags: ['x', 'y,z'] });
    expect(v).toBe(
      ['BEGIN:VCARD', 'VERSION:3.0', 'N:Kaya;Ayşe Nur;;;', 'FN:Ayşe Nur Kaya', 'ORG:A\\; B\\, C', 'TITLE:Müdür', 'TEL;TYPE=WORK,VOICE:0392 1', 'TEL;TYPE=CELL,VOICE:0533 2', 'EMAIL;TYPE=INTERNET:a@b.com', 'ADR;TYPE=WORK:;;Girne\\,\\nKKTC;;;;', 'CATEGORIES:x,y\\,z', 'END:VCARD', ''].join('\r\n'),
    );
  });
  it('tek başına CR de kaçışlanır (satır enjeksiyonu yok)', () => {
    const v = buildVCard({ fullName: 'X', title: 'A\rEMAIL:x@evil.test', address: 'B\r\nC' });
    expect(v).not.toMatch(/\r(?!\n)/);
    expect(v).toContain('TITLE:A\\nEMAIL:x@evil.test');
    expect(v).toContain('B\\nC');
    expect(v.split('\r\n').filter((l) => l.startsWith('EMAIL'))).toHaveLength(0);
  });
  it('tek isim, boş alanlar atlanır; uzun satır katlanır; çoklu', () => {
    const one = buildVCard({ fullName: 'Madonna' });
    expect(one).toContain('N:;Madonna;;;');
    expect(one).not.toContain('TEL');
    const long = buildVCard({ fullName: 'X', address: 'a'.repeat(200) });
    for (const line of long.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75);
    expect(buildVCards([{ fullName: 'Bir İki' }, { fullName: 'Üç Dört' }]).match(/BEGIN:VCARD/g)).toHaveLength(2);
  });
});

describe('rehber şemaları', () => {
  it('kişi: ad zorunlu, e-posta geçerli, etiket sınırı; kimlik/doğum alanları kabul edilmez (atılır)', () => {
    expect(createContactSchema.safeParse({ fullName: 'A' }).success).toBe(false);
    expect(createContactSchema.safeParse({ fullName: 'Ali', email: 'x' }).success).toBe(false);
    const r = createContactSchema.parse({ fullName: 'Ali', idNumber: '123', birthDate: '1990-01-01' });
    expect(r).not.toHaveProperty('idNumber');
    expect(r).not.toHaveProperty('birthDate');
  });
  it('kısmi güncelleme varsayılanları sıfırlamaz', () => {
    expect(updateOrganizationSchema.parse({ name: 'Kurum' })).toEqual({ name: 'Kurum' });
    expect(updateAgendaSchema.parse({ title: 'x' })).toEqual({ title: 'x' });
  });
  it('ajanda: saatli kalemde başlangıç şart, bitiş sonra; varsayılan tüm gün görev', () => {
    expect(createAgendaSchema.parse({ title: 'x', dueDate: '2026-10-02' })).toMatchObject({ kind: 'task', allDay: true });
    expect(createAgendaSchema.safeParse({ title: 'x', dueDate: '2026-10-02', allDay: false }).success).toBe(false);
    expect(createAgendaSchema.safeParse({ title: 'x', dueDate: '2026-10-02', allDay: false, startTime: '10:00', endTime: '09:00' }).success).toBe(false);
    expect(createAgendaSchema.safeParse({ title: 'x', dueDate: '2026-10-02', allDay: false, startTime: '10:00', endTime: '11:00' }).success).toBe(true);
    expect(createAgendaSchema.safeParse({ title: 'x', dueDate: '2026-10-02', remindBeforeMinutes: -1 }).success).toBe(false);
  });
  it('not: kişi ya da kurum şart, varsayılan özel; talep: personel ya da kişi', () => {
    expect(createNoteSchema.safeParse({ kind: 'call', noteDate: '2026-10-02', summary: 'x' }).success).toBe(false);
    const u = '019a0000-0000-7000-8000-000000000001';
    expect(createNoteSchema.parse({ contactId: u, kind: 'call', noteDate: '2026-10-02', summary: 'x' }).visibility).toBe('private');
    expect(createDsrSchema.safeParse({ employeeId: u, contactId: u, requesterName: 'Ali', kind: 'access' }).success).toBe(false);
    expect(createDsrSchema.safeParse({ contactId: u, requesterName: 'Ali', kind: 'access' }).success).toBe(true);
  });
});
