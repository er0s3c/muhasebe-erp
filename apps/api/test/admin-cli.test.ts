import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { asOwner, client, createCompany, makeApp, registerUser, PASSWORD } from './helpers';

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
