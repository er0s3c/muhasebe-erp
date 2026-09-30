import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asOwner, client, createCompany, execAsOwner, makeApp, registerUser, PASSWORD } from './helpers';

const { app } = await makeApp();

function admin(args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/admin-cli.ts', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('operatör parola kurtarma (admin reset-password)', () => {
  it('geçici parola üretir: eski parola ve oturumlar geçersiz, yeni girişte parola değişimi zorunlu, olay kaydedilir', async () => {
    const owner = await registerUser(app, 'Kurtar');
    const company = await createCompany(app, owner.token);
    expect((await client(app, owner.token, company.id).get('/api/accounts')).statusCode).toBe(200);

    const r = admin(['reset-password', `--email=${owner.email.toUpperCase()}`]);
    expect(r.code, r.out).toBe(0);
    const temporary = r.out.match(/^\s{2}(\S{20})$/m)?.[1];
    expect(temporary, r.out).toBeTruthy();

    // Eski parola artık çalışmaz
    const old = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: PASSWORD } });
    expect(old.statusCode).toBe(401);
    // Eski oturumun yenileme çerezi kapandı
    const refresh = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: owner.cookie } });
    expect(refresh.statusCode).toBe(401);
    // Geçici parolayla giriş: parola değişimi zorunlu, şirket uçları kapalı
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: temporary } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.mustChangePassword).toBe(true);
    const blocked = await client(app, login.json().accessToken, company.id).get('/api/accounts');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // Operatör imzalı güvenlik olayı var ve parola içermez
    const ev = await asOwner(async (q) =>
      (await q(`select meta::text as meta from security_events where user_id = $1 and event = 'password_reset_completed'`, [owner.userId])).rows,
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].meta).toContain('operator-cli');
    expect(ev[0].meta).not.toContain(temporary!);
  });

  it('bilinmeyen kullanıcı ve eksik bağımsız değişkenler hata verir', () => {
    expect(admin(['reset-password', '--email=yok-boyle-biri@example.com']).code).toBe(1);
    expect(admin(['reset-password']).code).toBe(1);
    expect(admin(['baska']).code).toBe(1);
  });
});

describe('operatör cihaz kurtarma (admin devices)', () => {
  async function seedDevice(label: string, userId?: string) {
    const id = randomUUID();
    await execAsOwner(
      `insert into devices (id, secret_hash, name, last_user_id, last_seen_at) values ($1, $2, $3, $4, now())`,
      [id, `hash-${id}`, label, userId ?? null],
    );
    return id;
  }

  it('listeler, ön ekle kaldırır (oturumları kapanır, olay yazılır), toplu kaldırma onay ister', async () => {
    const owner = await registerUser(app, 'Cihaz');
    const a = await seedDevice('Chrome · Windows (CLI testi)', owner.userId);
    const b = await seedDevice('Safari · macOS (CLI testi)');
    // b cihazının oturumu var; kaldırınca kapanmalı
    await execAsOwner(`insert into refresh_tokens (id, user_id, token_hash, expires_at, device_id) values (gen_random_uuid(), $1, $2, now() + interval '1 day', $3)`, [owner.userId, `t-${b}`, b]);

    const list = admin(['devices']);
    expect(list.code, list.out).toBe(0);
    expect(list.out).toContain(a);
    expect(list.out).toContain('Chrome · Windows (CLI testi)');
    expect(list.out).toContain(owner.email);
    expect(list.out).toMatch(/Koltuk: \d+/);

    // çok kısa ön ek ve bilinmeyen ön ek reddedilir
    expect(admin(['devices:revoke', '--id=abc']).code).toBe(1);
    expect(admin(['devices:revoke', '--id=ffffffff']).code).toBe(1);
    expect(admin(['devices:revoke']).code).toBe(1);

    const rev = admin(['devices:revoke', `--id=${b.slice(0, 13)}`]);
    expect(rev.code, rev.out).toBe(0);
    const row = await execAsOwner(`select revoked_at, revoked_by from devices where id = $1`, [b]);
    expect(row.rows[0].revoked_at).toBeTruthy();
    expect(row.rows[0].revoked_by).toBe('operator-cli');
    const tok = await execAsOwner(`select revoked_at from refresh_tokens where device_id = $1`, [b]);
    expect(tok.rows[0].revoked_at).toBeTruthy();
    const ev = await execAsOwner(`select meta::text as meta from security_events where event = 'device_revoked'`);
    expect(ev.rows.some((r) => r.meta.includes(b) && r.meta.includes('operator-cli'))).toBe(true);
    // aynı cihazı yeniden kaldırmak bulunamaz
    expect(admin(['devices:revoke', `--id=${b}`]).code).toBe(1);
    // a etkilenmedi
    expect((await execAsOwner(`select revoked_at from devices where id = $1`, [a])).rows[0].revoked_at).toBeNull();

    // toplu kaldırma onay ister
    const refuse = admin(['devices:revoke-all']);
    expect(refuse.code).toBe(1);
    expect(refuse.out).toContain('--yes');
    expect((await execAsOwner(`select revoked_at from devices where id = $1`, [a])).rows[0].revoked_at).toBeNull();
    const all = admin(['devices:revoke-all', '--yes']);
    expect(all.code, all.out).toBe(0);
    expect((await execAsOwner(`select count(*)::int as n from devices where revoked_at is null`)).rows[0].n).toBe(0);
  });
});
