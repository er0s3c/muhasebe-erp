import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { base32Decode, hotp, totpCounter } from '@erp/license-core';
import { checkRequest } from '../src/licensing/gate';
import type { LicenseSnapshot } from '../src/licensing/service';
import { PASSWORD, addMember, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

/**
 * Güvenlik denetimi (SEC-1…13, DB-3, API-12) düzeltmelerinin kalıcı regresyon testleri. Her test, düzeltme öncesindeki
 * davranışta başarısız olan senaryoyu sınar. Lisans denetimi açıkken (kurulum sahibi, salt-okunur MFA) olanlar
 * test/audit-license.test.ts dosyasındadır.
 */
const codeAt = (secret: string, offset = 0) => hotp(base32Decode(secret), totpCounter(Date.now()) + offset);
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('denetim düzeltmeleri: güvenlik', async () => {
  const { app, handle } = await makeApp();
  const login = (email: string, password = PASSWORD) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  async function enableMfa(token: string) {
    const c = client(app, token);
    const secret = (await c.post('/api/auth/mfa/setup')).json().secret as string;
    const en = await c.post('/api/auth/mfa/enable', { code: codeAt(secret) });
    expect(en.statusCode, en.body).toBe(200);
    return { secret, recoveryCodes: en.json().recoveryCodes as string[] };
  }

  it('SEC-1: yalnızca sahip/yönetici yeni şirket açar; şirketsiz yeni kuruluşta ilk şirket açılabilir', async () => {
    const owner = await registerUser(app, 'S1Sahip');
    const co = await createCompany(app, owner.token);
    const oc = client(app, owner.token, co.id);
    const viewer = await addMember(app, oc, co.id, 'viewer');
    const accountant = await addMember(app, oc, co.id, 'accountant');
    for (const t of [viewer.token, accountant.token]) {
      const r = await client(app, t).post('/api/companies', { name: 'Kendi Şirketim', sector: 'COMMERCE', jurisdiction: 'KKTC' });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error.code).toBe('COMPANY_CREATE_FORBIDDEN');
    }
    const admin = await addMember(app, oc, co.id, 'admin');
    expect((await client(app, admin.token).post('/api/companies', { name: 'Yönetici Şirketi', sector: 'COMMERCE', jurisdiction: 'KKTC' })).statusCode).toBe(201);
    expect((await client(app, owner.token).post('/api/companies', { name: 'İkinci Şirket', sector: 'COMMERCE', jurisdiction: 'KKTC' })).statusCode).toBe(201);
    // Görüntüleyici yine de "kurulum sahibi" ayrıntılarını göremez
    expect((await client(app, viewer.token).get('/api/license')).json().isOwner).toBe(false);
    expect((await client(app, viewer.token).get('/api/system/update')).statusCode).toBe(403);
    expect((await client(app, viewer.token).get('/api/devices')).statusCode).toBe(403);
  });

  it('SEC-2: kullanıcının üye olduğu başka şirkette daha yüksek rütbesi varsa MFA sıfırlanamaz ve kullanıcı izinsiz bağlanamaz', async () => {
    const boss = await registerUser(app, 'S2Patron');
    const main = await createCompany(app, boss.token, { name: 'Ana Şirket' });
    const side = await createCompany(app, boss.token, { name: 'Yan Şirket' });
    const sc = client(app, boss.token, side.id);
    const mc = client(app, boss.token, main.id);
    const adm = await addMember(app, sc, side.id, 'admin', 's2adm');
    // U: yan şirkette görüntüleyici, ana şirkette sahip
    const u = await addMember(app, sc, side.id, 'viewer', 's2u');
    expect((await mc.post('/api/company/members', { email: u.email, fullName: 'U Kişi', role: 'owner' })).statusCode).toBe(201);
    await enableMfa(u.token);
    const reset = await adm.client.delete(`/api/company/members/${u.userId}/mfa`);
    expect(reset.statusCode, reset.body).toBe(403);
    expect(reset.json().error.code).toBe('MEMBER_OUTRANKS_YOU');
    expect((await client(app, u.token).get('/api/auth/mfa')).json().enabled).toBe(true);
    // Patron (her iki şirkette sahip) sıfırlayabilir
    expect((await client(app, boss.token, side.id).delete(`/api/company/members/${u.userId}/mfa`)).statusCode).toBe(200);

    // Mevcut (başka şirkette yönetici) kullanıcıyı kendi şirketine bağlama: yönetici bunu yapamaz
    const other = await addMember(app, mc, main.id, 'admin', 's2other');
    const attach = await adm.client.post('/api/company/members', { email: other.email, fullName: 'Diğer', role: 'viewer' });
    expect(attach.statusCode, attach.body).toBe(403);
    expect(attach.json().error.code).toBe('MEMBER_OUTRANKS_YOU');
    // Yöneticinin yönetmediği şirkette üyeliği olmayan (ör. çıkarılmış) kullanıcı yeniden bağlanabilir
    const plain = await addMember(app, sc, side.id, 'viewer', 's2plain');
    expect((await adm.client.delete(`/api/company/members/${plain.userId}`)).statusCode).toBe(200);
    expect((await adm.client.post('/api/company/members', { email: plain.email, fullName: 'Düz Kişi', role: 'viewer' })).statusCode).toBe(201);
    // ...ama yönetmediği başka şirkette üyeliği olan kullanıcı bağlanamaz
    const elsewhere = await addMember(app, mc, main.id, 'viewer', 's2else');
    expect((await adm.client.post('/api/company/members', { email: elsewhere.email, fullName: 'Başka Kişi', role: 'viewer' })).statusCode).toBe(403);
  });

  it('SEC-3: şirketler tablosu her sorguda etkin şirkete göre süzülür (kaynakta süzgeçsiz from(companies) yok)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const src = readFileSync(p, 'utf8');
          const re = /\.from\(companies\)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(src))) {
            const tail = src.slice(m.index, m.index + 160);
            if (!/^\.from\(companies\)\s*\.where\([^]*?(companies\.id|app_company_id\(\)|organizationId)/.test(tail)) {
              offenders.push(`${p.slice(srcRoot.length + 1)}:${src.slice(0, m.index).split('\n').length}`);
            }
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it('SEC-3: çok şirketli kullanıcıda talep karşılaştırması etkin şirketin para birimini kullanır', async () => {
    const s = await registerUser(app, 'S3Para');
    await createCompany(app, s.token, { name: 'A TRY Ltd', baseCurrency: 'TRY' });
    const b = await createCompany(app, s.token, { name: 'B USD Ltd', baseCurrency: 'USD', reportingCurrency: null });
    const org = await orgOf(app, s.token);
    await asDb(handle, { userId: s.userId, orgId: org, companyId: b.id }, async (q) => {
      // RLS kuruluş genelini gösterir; uygulama kodu artık etkin şirkete süzer
      expect((await q('select count(*)::int as n from companies')).rows[0].n).toBe(2);
      expect((await q('select base_currency from companies where id = app_company_id()')).rows).toEqual([{ base_currency: 'USD' }]);
    });
  });

  it('SEC-4: denetim izi işlevinin arama yolu pg_temp ile sabit; uygulama rolü geçici tablo açamaz', async () => {
    const fn = await execAsOwner(`select array_to_string(proconfig, ',') as cfg from pg_proc where proname = 'audit_row_change'`);
    expect(fn.rows[0].cfg).toContain('pg_temp');
    const s = await registerUser(app, 'S4Gecici');
    const co = await createCompany(app, s.token);
    const org = await orgOf(app, s.token);
    await asDb(handle, { userId: s.userId, orgId: org, companyId: co.id }, async (q) => {
      const err = await expectDbError(q, 'create temp table audit_log (id int)');
      expect(err.code).toBe('42501');
    });
  });

  it('SEC-5: ham SQL ile başka şirkette kendine üyelik açılamaz, başka şirket değiştirilemez/silinemez', async () => {
    const boss = await registerUser(app, 'S5Patron');
    const target = await createCompany(app, boss.token, { name: 'Hedef' });
    const mine = await createCompany(app, boss.token, { name: 'Benim' });
    const low = await addMember(app, client(app, boss.token, mine.id), mine.id, 'viewer', 's5low');
    const org = await orgOf(app, boss.token);
    await asDb(handle, { userId: low.userId, orgId: org, companyId: mine.id }, async (q) => {
      const ins = await expectDbError(q, `insert into memberships (id, company_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`, [target.id, low.userId]);
      expect(ins.code).toBe('42501');
      expect((await q(`update companies set name = 'ele geçirildi' where id = $1 returning id`, [target.id])).rows).toEqual([]);
      expect((await expectDbError(q, 'delete from companies where id = $1', [target.id])).code).toBe('42501');
    });
    await asDb(handle, { userId: low.userId, orgId: org }, async (q) => {
      // Şirket bağlamı olmadan kendi üyeliğini yükseltemez
      expect((await q(`update memberships set role = 'owner' where user_id = $1 returning id`, [low.userId])).rows).toEqual([]);
    });
  });

  it('SEC-6 / OPS-12: salt-okunur lisansta MFA doğrulaması ve güncelleyici bildirimi açık', () => {
    const snap = { enforced: true, state: 'restricted', reason: 'expired' } as unknown as LicenseSnapshot;
    expect(checkRequest(snap, 'POST', '/api/auth/mfa/verify')).toBeNull();
    expect(checkRequest(snap, 'POST', '/api/system/updater/report')).toBeNull();
    expect(checkRequest(snap, 'POST', '/api/invoices')?.code).toBe('LICENSE_RESTRICTED');
  });

  it('SEC-7: aynı kurtarma kodu eşzamanlı isteklerde yalnızca bir kez geçer', async () => {
    const u = await registerUser(app, 'S7Kurtarma');
    const { recoveryCodes } = await enableMfa(u.token);
    for (const code of recoveryCodes.slice(0, 3)) {
      const mfaToken = (await login(u.email)).json().mfaToken as string;
      const rs = await Promise.all([1, 2, 3, 4].map(() => app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken, code } })));
      expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    }
    expect((await client(app, u.token).get('/api/auth/mfa')).json().recoveryCodesLeft).toBe(recoveryCodes.length - 3);
  });

  it('SEC-8: başkasının özel ajanda kalemi kimliğiyle de okunamaz', async () => {
    const s = await registerUser(app, 'S8Ajanda');
    const co = await createCompany(app, s.token, { sector: 'CONSTRUCTION' });
    const oc = client(app, s.token, co.id);
    const acc = await addMember(app, oc, co.id, 'accountant');
    const mk = await oc.post('/api/agenda', { kind: 'task', title: 'Özel: avukatla görüşme', dueDate: day(11, 1), allDay: true });
    expect(mk.statusCode, mk.body).toBe(201);
    const id = mk.json().item.id as string;
    const g = await acc.client.get(`/api/agenda/${id}`);
    expect(g.statusCode).toBe(404);
    expect((await oc.get(`/api/agenda/${id}`)).json().item.title).toBe('Özel: avukatla görüşme');
    // Şirket kalemi (sahipsiz) herkes için görünür kalır
    const shared = (await oc.post('/api/agenda', { kind: 'task', title: 'Şirket toplantısı', dueDate: day(11, 2), allDay: true, ownerId: null })).json().item;
    expect((await acc.client.get(`/api/agenda/${shared.id}`)).statusCode).toBe(200);
  });

  it('SEC-9: üye listesi yalnızca etkin şirketin üyelerini gösterir', async () => {
    const owner = await registerUser(app, 'S9Liste');
    const a = await createCompany(app, owner.token, { name: 'A Ltd' });
    const b = await createCompany(app, owner.token, { name: 'B Ltd' });
    const onlyB = await addMember(app, client(app, owner.token, b.id), b.id, 'viewer', 's9b');
    const rows = (await client(app, owner.token, a.id).get('/api/company/members')).json().members as { userId: string }[];
    expect(rows.map((r) => r.userId)).toEqual([owner.userId]);
    expect(rows.map((r) => r.userId)).not.toContain(onlyB.userId);
  });

  it('SEC-10: çıkış ve parola değişikliği erişim belirteçlerini hemen geçersiz kılar (değiştiren oturum açık kalır)', async () => {
    const u = await registerUser(app, 'S10Oturum');
    const second = await login(u.email);
    const t2 = second.json().accessToken as string;
    const cookie2 = second.cookies.find((c) => c.name === 'refresh_token')!.value;
    expect((await client(app, u.token).get('/api/me')).statusCode).toBe(200);
    // İkinci oturum parolayı değiştirir: ilk oturumun erişim belirteci düşer, ikincisi açık kalır
    const cp = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${t2}` },
      cookies: { refresh_token: cookie2 },
      payload: { currentPassword: PASSWORD, newPassword: 'Yeni-Sifre-98765-q' },
    });
    expect(cp.statusCode, cp.body).toBe(200);
    expect((await client(app, u.token).get('/api/me')).statusCode).toBe(401);
    expect((await client(app, t2).get('/api/me')).statusCode).toBe(200);
    // Çıkış: aynı oturumun erişim belirteci de düşer
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { refresh_token: cookie2 } })).statusCode).toBe(200);
    expect((await client(app, t2).get('/api/me')).statusCode).toBe(401);
  });

  it('SEC-11: başka kuruluştaki e-posta üye eklemede genel yanıtla reddedilir', async () => {
    const other = await registerUser(app, 'S11Diger');
    const s = await registerUser(app, 'S11Sahip');
    const co = await createCompany(app, s.token);
    const r = await client(app, s.token, co.id).post('/api/company/members', { email: other.email, fullName: 'Xavier Kişi', role: 'viewer' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('EMAIL_UNAVAILABLE');
    expect(r.json().error.message).not.toMatch(/kuruluş|kayıtlı/i);
  });

  it('SEC-12: rehber işlem bayrağı uygulama rolünce taklit edilemez; oturumsuz not yazılamaz', async () => {
    const s = await registerUser(app, 'S12Rehber');
    const co = await createCompany(app, s.token, { sector: 'CONSTRUCTION' });
    const c = client(app, s.token, co.id);
    const a = (await c.post('/api/directory/contacts', { fullName: 'Ali Veli' })).json().contact;
    const b = (await c.post('/api/directory/contacts', { fullName: 'Ayşe Kaya' })).json().contact;
    const org = await orgOf(app, s.token);
    await asDb(handle, { userId: s.userId, orgId: org, companyId: co.id }, async (q) => {
      await q(`select set_config('app.directory_op', 'merge', true)`);
      const e1 = await expectDbError(q, 'update directory_contacts set merged_into_id = $1 where id = $2', [b.id, a.id]);
      expect(e1.code).toBe('ERP21');
      await q(`select set_config('app.directory_op', 'anonymize', true)`);
      const e2 = await expectDbError(q, 'update directory_contacts set anonymized_at = now() where id = $1', [a.id]);
      expect(e2.code).toBe('ERP21');
    });
    await asDb(handle, { orgId: org, companyId: co.id }, async (q) => {
      const e = await expectDbError(
        q,
        `insert into directory_notes (id, company_id, contact_id, kind, note_date, summary, author_id) values (gen_random_uuid(), $1, $2, 'call', current_date, 'sahte', $3)`,
        [co.id, a.id, s.userId],
      );
      expect(e.code).toBe('ERP21');
    });
    // Uygulamadaki birleştirme yolu çalışmaya devam eder
    const m = await c.post(`/api/directory/contacts/${b.id}/merge`, { mergeId: a.id });
    expect(m.statusCode, m.body).toBe(200);
    expect((await execAsOwner('select merged_into_id from directory_contacts where id = $1', [a.id])).rows[0].merged_into_id).toBe(b.id);
  });

  it('DB-3: kuruluş satırları kiracıya göre yalıtılır', async () => {
    const x = await registerUser(app, 'DB3X');
    const y = await registerUser(app, 'DB3Y');
    const ox = await orgOf(app, x.token);
    const oy = await orgOf(app, y.token);
    await asDb(handle, { userId: x.userId, orgId: ox }, async (q) => {
      expect((await q('select id from organizations')).rows.map((r) => r.id)).toEqual([ox]);
      expect((await q(`update organizations set name = 'ele geçirildi' where id = $1 returning id`, [oy])).rows).toEqual([]);
      expect((await expectDbError(q, `insert into organizations (id, name) values (gen_random_uuid(), 'sahte')`)).code).toBe('42501');
    });
  });

  it('API-12: onay adımının kullanıcısı bu şirkette onaylayabilen etkin üye, rolü onaylayabilen rol olmalı', async () => {
    const s = await registerUser(app, 'A12Onay');
    const co = await createCompany(app, s.token);
    const c = client(app, s.token, co.id);
    const stranger = await registerUser(app, 'A12Yabanci');
    const viewer = await addMember(app, c, co.id, 'viewer', 'a12viewer');
    const acc = await addMember(app, c, co.id, 'accountant', 'a12acc');
    const rule = (steps: unknown[]) => c.post('/api/approval-rules', { docType: 'progress_payment', minAmount: '0', steps });
    const foreign = await rule([{ userId: stranger.userId }]);
    const missing = await rule([{ userId: '00000000-0000-4000-8000-000000000000' }]);
    expect(foreign.statusCode).toBe(422);
    expect(missing.statusCode).toBe(422);
    expect(foreign.json().error).toEqual(missing.json().error);
    expect((await rule([{ userId: viewer.userId }])).json().error.code).toBe('APPROVER_INVALID');
    expect((await rule([{ role: 'viewer' }])).json().error.code).toBe('APPROVER_INVALID');
    expect((await rule([{ role: 'sales' }])).json().error.code).toBe('APPROVER_INVALID');
    expect((await rule([{ userId: acc.userId }, { role: 'site_manager' }])).statusCode).toBe(201);
  });
});
