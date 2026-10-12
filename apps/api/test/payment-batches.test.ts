import { describe, expect, it } from 'vitest';
import { TODAY_LOCAL, accountIds, addMember, client, createCompany, execAsOwner, makeApp, registerUser } from './helpers';

const iso = (offset: number) => new Date(Date.parse(`${TODAY_LOCAL}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const IBAN = 'TR33 0006 1005 1978 6457 8413 26';

/** Toplu ödeme (öneri 54): öneri, dört göz onayı, doğrulanmış IBAN, banka dosyası ve satır başına ödeme kaydı. */
describe('toplu tedarikçi ödemesi', async () => {
  const { app } = await makeApp();

  it('vadesi gelen borçlar önerilir; hazırlayan onaylayamaz; doğrulanmamış IBAN onaylanmaz; kayıt açık kalemleri kapatır', async () => {
    const s = await registerUser(app, 'TopluOdeme');
    const company = await createCompany(app, s.token);
    const owner = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const accountant = await addMember(app, owner, company.id, 'accountant');
    const bank = (await owner.post('/api/treasury/accounts', { kind: 'bank', name: 'Ana banka', currency: 'TRY' })).json().account as { id: string };
    expect((await owner.post('/api/treasury/transactions', { type: 'other_receipt', date: iso(-10), accountId: bank.id, amount: '10000', glAccountId: ids['500'] })).statusCode).toBe(201);

    const supplier = async (name: string, amount: string, due: number, no: string) => {
      const party = (await owner.post('/api/parties', { name, kind: 'supplier' })).json().party as { id: string };
      const inv = await owner.post('/api/invoices', { post: true, type: 'expense', partyId: party.id, invoiceDate: iso(-10), dueDate: iso(due), externalNo: no, currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: amount }] });
      expect(inv.statusCode, inv.body).toBe(201);
      return party;
    };
    const a = await supplier('Tedarikçi A', '400', -3, 'A-1');
    const b = await supplier('Tedarikçi B', '300', 30, 'B-1');
    const cParty = await supplier('Tedarikçi C', '250', -1, 'C-1');
    const aBank = (await owner.post(`/api/parties/${a.id}/bank-accounts`, { iban: IBAN, holderName: 'Tedarikçi A Ltd.' })).json().accounts[0];
    expect((await accountant.client.post(`/api/parties/${a.id}/bank-accounts/${aBank.id}/verify`, { method: 'phone_callback', note: 'Bilinen numaradan teyit' })).statusCode).toBe(200);
    const cBank = (await owner.post(`/api/parties/${cParty.id}/bank-accounts`, { iban: 'TR32 0010 0099 9999 9999 9999 99', holderName: 'Tedarikçi C' })).json().accounts?.[0];

    const sug = (await owner.get(`/api/payment-batches/suggestions?accountId=${bank.id}&dueUntil=${iso(7)}`)).json();
    expect(sug.currency).toBe('TRY');
    expect(sug.parties.map((p: { partyId: string }) => p.partyId).sort()).toEqual([a.id, cParty.id].sort());
    expect(sug.parties.find((p: { partyId: string }) => p.partyId === b.id)).toBeUndefined();
    const pa = sug.parties.find((p: { partyId: string }) => p.partyId === a.id);
    expect(pa).toMatchObject({ total: '400.00', bankAccount: { id: aBank.id, ibanLast4: '1326' } });
    expect(sug.parties.find((p: { partyId: string }) => p.partyId === cParty.id).bankAccount).toBeNull();

    const line = { partyId: a.id, bankAccountId: aBank.id, amount: '400', items: pa.items.map((i: { lineId: string; remaining: string }) => ({ lineId: i.lineId, amount: i.remaining, settleAmount: i.remaining })) };
    expect((await owner.post('/api/payment-batches', { accountId: bank.id, paymentDate: TODAY_LOCAL, lines: [{ ...line, bankAccountId: cBank?.id ?? aBank.id, partyId: b.id }] })).statusCode).toBe(400);
    const created = await owner.post('/api/payment-batches', { accountId: bank.id, paymentDate: TODAY_LOCAL, note: 'Haftalık ödeme', lines: [line] });
    expect(created.statusCode, created.body).toBe(201);
    const batch = created.json().batch;
    expect(batch).toMatchObject({ status: 'draft', total: '400.00', currency: 'TRY', batchNo: `TO-${TODAY_LOCAL.slice(0, 4)}-0001` });

    // Dört göz: hazırlayan onaylayamaz; taslaktan banka dosyası alınmaz
    expect((await owner.post(`/api/payment-batches/${batch.id}/approve`, {})).json().error.code).toBe('PAYMENT_BATCH_FOUR_EYES');
    expect((await owner.get(`/api/payment-batches/${batch.id}/bank-file`)).statusCode).toBe(409);
    expect((await accountant.client.post(`/api/payment-batches/${batch.id}/post`, {})).statusCode).toBe(409);
    const approved = await accountant.client.post(`/api/payment-batches/${batch.id}/approve`, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().batch.status).toBe('approved');

    const file = await owner.get(`/api/payment-batches/${batch.id}/bank-file`);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.body).toContain('TR330006100519786457841326;Tedarikçi A Ltd.;400.00;TRY');

    const posted = await owner.post(`/api/payment-batches/${batch.id}/post`, {});
    expect(posted.statusCode, posted.body).toBe(200);
    expect(posted.json().batch.status).toBe('posted');
    expect(posted.json().lines[0].treasuryTransactionId).toBeTruthy();
    const after = (await owner.get(`/api/payment-batches/suggestions?accountId=${bank.id}&dueUntil=${iso(7)}`)).json();
    expect(after.parties.map((p: { partyId: string }) => p.partyId)).toEqual([cParty.id]);
    expect((await owner.post(`/api/payment-batches/${batch.id}/cancel`, { reason: 'Geç kaldı' })).statusCode).toBe(409);
    await expect(execAsOwner(`update payment_batches set total='1' where id = $1`, [batch.id])).rejects.toThrow(/değiştirilemez/);

    // Doğrulanmamış IBAN'lı liste onaylanmaz, iptal edilir
    if (cBank) {
      const cLine = { partyId: cParty.id, bankAccountId: cBank.id, amount: '250' };
      const second = (await owner.post('/api/payment-batches', { accountId: bank.id, paymentDate: TODAY_LOCAL, lines: [cLine] })).json().batch;
      expect(second.batchNo).toBe(`TO-${TODAY_LOCAL.slice(0, 4)}-0002`);
      expect((await accountant.client.post(`/api/payment-batches/${second.id}/approve`, {})).json().error.code).toBe('PAYMENT_BANK_NOT_VERIFIED');
      const cancelled = await owner.post(`/api/payment-batches/${second.id}/cancel`, { reason: 'IBAN teyidi bekleniyor' });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json().batch.status).toBe('cancelled');
    }
  });
});
