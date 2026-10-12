import { describe, expect, it } from 'vitest';
import { addMember, client, createCompany, execAsOwner, makeApp, registerUser } from './helpers';

/**
 * Öneri 53: tedarikçi banka bilgisi değişiklik kontrolü. Yeni hesap doğrulama bekler; giren kişi doğrulayamaz; doğrulama
 * bağımsız teyit yöntemiyle kaydedilir; aynı IBAN başka caride uyarı verir; tam IBAN yalnız doğrulanmış hesapta açılır.
 */
describe('cari banka hesabı değişiklik kontrolü', async () => {
  const { app } = await makeApp();
  const IBAN = 'TR33 0006 1005 1978 6457 8413 26';

  it('giren doğrulayamaz; başka yetkili teyitle doğrular; tam IBAN yalnız doğrulanmışta; aynı IBAN başka caride uyarı', async () => {
    const s = await registerUser(app, 'BankaHesap');
    const company = await createCompany(app, s.token);
    const owner = client(app, s.token, company.id);
    const accountant = await addMember(app, owner, company.id, 'accountant');
    const sales = await addMember(app, owner, company.id, 'sales');
    const supplier = (await owner.post('/api/parties', { name: 'Tedarikçi A', kind: 'supplier' })).json().party;
    const other = (await owner.post('/api/parties', { name: 'Tedarikçi B', kind: 'supplier' })).json().party;
    const base = `/api/parties/${supplier.id}/bank-accounts`;

    expect((await owner.post(base, { iban: 'TR33 0006 1005 1978 6457 8413 27', holderName: 'Tedarikçi A Ltd.' })).statusCode).toBe(400);
    // Satış temsilcisi hesabı girebilir (cari yönetimi) ama doğrulayamaz (kasa/banka yönetimi yok)
    const created = await sales.client.post(base, { iban: IBAN, holderName: 'Tedarikçi A Ltd.', bankName: 'Örnek Bank', note: 'Tedarikçi e-postasıyla bildirdi' });
    expect(created.statusCode, created.body).toBe(201);
    const account = created.json().accounts[0];
    expect(account).toMatchObject({ status: 'pending', ibanMasked: 'TR•• •••• •••• 1326', ibanLast4: '1326', ownRequest: true });
    expect(JSON.stringify(created.json())).not.toContain('0006');
    expect((await sales.client.post(base, { iban: IBAN, holderName: 'Tekrar' })).json().error.code).toBe('BANK_ACCOUNT_EXISTS');
    expect((await sales.client.post(`${base}/${account.id}/verify`, { method: 'phone_callback', note: 'Arandı' })).statusCode).toBe(403);
    expect((await owner.get(`${base}/${account.id}/iban`)).json().error.code).toBe('BANK_ACCOUNT_NOT_VERIFIED');

    // Giren kişi (yetkisi olsa bile) kendi girdiğini doğrulayamaz
    const ownEntry = (await owner.post(`/api/parties/${other.id}/bank-accounts`, { iban: IBAN, holderName: 'Tedarikçi B' })).json().accounts[0];
    expect((await owner.post(`/api/parties/${other.id}/bank-accounts/${ownEntry.id}/verify`, { method: 'phone_callback', note: 'Kendim' })).json().error.code).toBe('BANK_ACCOUNT_FOUR_EYES');
    // Aynı IBAN iki caride: her ikisinde uyarı
    const listed = (await owner.get(base)).json().accounts[0];
    expect(listed.alsoUsedBy).toEqual([{ partyId: other.id, partyName: 'Tedarikçi B' }]);

    // Doğrulama yöntemi ve notu zorunlu
    expect((await accountant.client.post(`${base}/${account.id}/verify`, { method: 'phone_callback' })).statusCode).toBe(400);
    const verified = await accountant.client.post(`${base}/${account.id}/verify`, { method: 'phone_callback', note: 'Bilinen numaradan arandı, teyit edildi' });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().accounts[0]).toMatchObject({ status: 'verified', verificationMethod: 'phone_callback', decidedByName: expect.any(String) });
    expect((await owner.get(`${base}/${account.id}/iban`)).json().iban).toBe(IBAN.replace(/\s/g, ''));
    expect((await sales.client.get(`${base}/${account.id}/iban`)).statusCode).toBe(403);

    // Hesap bilgisi sonradan değişmez; doğrulanmış hesap yalnız kaldırılır
    await expect(execAsOwner(`update party_bank_accounts set iban_last4 = '9999' where id = $1`, [account.id])).rejects.toThrow(/değiştirilemez/);
    await expect(execAsOwner(`update party_bank_accounts set status = 'pending', decided_at = null where id = $1`, [account.id])).rejects.toThrow();
    expect((await owner.post(`${base}/${account.id}/revoke`, {})).json().accounts[0].status).toBe('revoked');
    expect((await owner.get(`${base}/${account.id}/iban`)).json().error.code).toBe('BANK_ACCOUNT_NOT_VERIFIED');

    // Başka şirket göremez
    const s2 = await registerUser(app, 'BankaYabanci');
    const c2 = await createCompany(app, s2.token);
    expect((await client(app, s2.token, c2.id).get(base)).json().accounts).toEqual([]);
    expect((await client(app, s2.token, c2.id).post(`${base}/${account.id}/verify`, { method: 'other', note: 'yabancı' })).statusCode).toBe(404);
  });
});
