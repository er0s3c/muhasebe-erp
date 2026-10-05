import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openSigningKey, signToken, type SealedKeyFile } from '@erp/license-core';
import { setupToken } from '../src/crypto';
import { DATA_KEY, activate, createAdmin, loginAdmin, makeInstallation, makeServer, totpNow } from './helpers';

const s = await makeServer();
const cwd = fileURLToPath(new URL('..', import.meta.url));
const tsx = new URL(import.meta.resolve('tsx')).href;

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', tsx, 'src/cli.ts', ...args], {
    cwd,
    env: { ...process.env, LICENSE_DATA_KEY: DATA_KEY, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('komut satırı', () => {
  it('keygen: parola ile mühürlü, yalnızca sahibin okuyabildiği dosya üretir; üzerine yazmaz; açık anahtarı yazdırır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lic-'));
    try {
      const out = join(dir, 'signing.key.json');
      const env = { LICENSE_SIGNING_KEY_PASSPHRASE: 'cok-uzun-bir-parola-42' };
      const r = cli(['keygen', '--kid=k-2026a', `--out=${out}`], env);
      expect(r.code, r.out).toBe(0);
      if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);
      const file = JSON.parse(readFileSync(out, 'utf8')) as SealedKeyFile;
      expect(r.out).toContain(file.publicKey);
      expect(readFileSync(out, 'utf8')).not.toContain('PRIVATE KEY');
      const signer = openSigningKey(file, env.LICENSE_SIGNING_KEY_PASSPHRASE);
      expect(signer.kid).toBe('k-2026a');
      expect(signToken('lease', { a: 1 }, signer)).toMatch(/^erp1\.k-2026a\./);
      // Yanlış parola açamaz
      expect(() => openSigningKey(file, 'yanlis-parola-yanlis')).toThrow();
      // Üzerine yazmaz
      const again = cli(['keygen', '--kid=k-2026b', `--out=${out}`], env);
      expect(again.code).toBe(1);
      expect(again.out).toMatch(/zaten var/);
      // Kısa parola reddedilir
      const short = cli(['keygen', '--kid=k1', `--out=${join(dir, 'x.json')}`], { LICENSE_SIGNING_KEY_PASSPHRASE: 'kisa' });
      expect(short.code).toBe(1);
      expect(existsSync(join(dir, 'x.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('license:issue: müşteri+lisans oluşturur, kodu bir kez yazdırır; kod uygulamadan etkinleştirilebilir; geçersiz sektör reddedilir', async () => {
    const r = cli(['license:issue', '--customer=CLI Test Marketi', '--sectors=retail_market,commerce', '--devices=4', '--companies=2', '--valid-until=2031-06-30', '--offline']);
    expect(r.code, r.out).toBe(0);
    const code = r.out.match(/[0-9A-Z]{5}(?:-[0-9A-Z]{5}){4}/)?.[0];
    expect(code).toBeTruthy();
    const { lease } = await activate(s, makeInstallation(), code!);
    expect(lease).toMatchObject({ customer: 'CLI Test Marketi', sectors: ['RETAIL_MARKET', 'COMMERCE'], deviceLimit: 4, companyLimit: 2 });
    expect(new Date(lease!.validUntil).toISOString()).toBe('2031-06-30T23:59:59.999Z');
    const list = cli(['license:list']);
    expect(list.out).toContain('CLI Test Marketi');
    expect(list.out).not.toContain(code!);
    const bad = cli(['license:issue', '--customer=X Ltd', '--sectors=UZAY', '--devices=1']);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/Geçersiz sektör/);
  });

  it('license:suspend / revoke / code komutları çalışır', async () => {
    const issued = cli(['license:issue', '--customer=CLI Askı Ltd.', '--sectors=COMMERCE', '--devices=1']);
    const id = issued.out.match(/Lisans verildi: ([0-9a-f-]{36})/)![1]!;
    const code = issued.out.match(/[0-9A-Z]{5}(?:-[0-9A-Z]{5}){4}/)![0];
    const inst = makeInstallation();
    await activate(s, inst, code);
    expect(cli(['license:suspend', `--id=${id}`]).code).toBe(0);
    s.clock.t += 1000;
    const { heartbeat } = await import('./helpers');
    expect((await heartbeat(s, inst)).lease).toMatchObject({ status: 'suspended' });
    const fresh = cli(['license:code', `--id=${id}`]);
    expect(fresh.out).toMatch(/YENİ ETKİNLEŞTİRME KODU/);
    expect(cli(['license:revoke', `--id=${id}`]).code).toBe(0);
    expect(cli(['license:resume', `--id=${id}`]).code).toBe(1);
  });

  it('admin:create: rastgele parola ve TOTP sırrı bir kez yazdırılır; bu bilgilerle giriş yapılır; admin:reset eskisini geçersiz kılar', async () => {
    const email = `cli-${Date.now()}@ornek.com`;
    const r = cli(['admin:create', `--email=${email}`, '--name=CLI Yönetici']);
    expect(r.code, r.out).toBe(0);
    const password = r.out.match(/Parola \(yalnızca bir kez gösterilir\): (\S+)/)![1]!;
    const secret = r.out.match(/elle girin\): ([A-Z2-7]+)/)![1]!;
    expect(password.length).toBeGreaterThanOrEqual(20);
    const login = await loginAdmin(s, { email, password, secret });
    expect(login.statusCode).toBe(200);
    expect(cli(['admin:create', `--email=${email}`]).code).toBe(1); // yinelenen

    const reset = cli(['admin:reset', `--email=${email}`]);
    const newPassword = reset.out.match(/Yeni parola \(bir kez\): (\S+)/)![1]!;
    const newSecret = reset.out.match(/Yeni TOTP sırrı: ([A-Z2-7]+)/)![1]!;
    s.clock.t += 61_000;
    expect((await loginAdmin(s, { email, password, secret })).statusCode).toBe(401);
    s.clock.t += 61_000;
    expect((await s.app.inject({ method: 'POST', url: '/admin/api/login', payload: { email, password: newPassword, totp: totpNow(newSecret, s.clock.t) } })).statusCode).toBe(200);
  });

  it('setup:token: yönetici varken kurulum kodunu yazdırmaz (kurulum kapalı)', async () => {
    await createAdmin(s);
    const r = cli(['setup:token']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Kurulum tamamlanmış');
    expect(r.out).not.toContain(setupToken(DATA_KEY));
  });
});
