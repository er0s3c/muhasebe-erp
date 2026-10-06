import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateKeyPair, loadPrivateKey, releaseFileName, signToken, type PublicKeyring } from '@erp/license-core';
import { Updater, defaultIO, type UpdaterConfig, type UpdaterIO } from '../src/updater/updater';

const pair = generateKeyPair();
const ring: PublicKeyring = { keys: { v1: pair.publicKey } };
const signer = { kid: 'v1', privateKey: loadPrivateKey(pair.privateKeyPem) };
const TOKEN = 't'.repeat(40);

/** Gerçek tar.gz kit arşivi (kit.json + sahte sihirbaz). */
function makeKit(dir: string, version: string): Buffer {
  const name = `muhasebe-erp-${version}-linux-x64`;
  const src = join(dir, `src-${version}`);
  mkdirSync(join(src, name, 'installer'), { recursive: true });
  writeFileSync(join(src, name, 'kit.json'), JSON.stringify({ product: 'muhasebe-erp', version, target: 'linux-x64' }));
  writeFileSync(join(src, name, 'installer', 'install.sh'), '#!/usr/bin/env bash\necho sahte\n');
  mkdirSync(join(src, name, 'deploy'), { recursive: true });
  writeFileSync(join(src, name, 'deploy', 'docker-compose.prod.yml'), `# ${version}\n`);
  const out = join(dir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', src, name]);
  return readFileSync(out);
}

interface World {
  cfg: UpdaterConfig;
  io: UpdaterIO;
  reports: { status: string; message?: string }[];
  installs: string[][];
  state: { version: string | null; pending: boolean };
  clock: { t: number };
  dir: string;
  reportFails: boolean;
}

interface WorldOpts {
  version?: string;
  badSha?: boolean;
  rogue?: boolean;
  docker?: boolean;
  https?: number;
  installer?: (args: string[], s: World['state']) => number;
}

function world(o: WorldOpts = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'erp-updater-'));
  const to = o.version ?? '1.1.0';
  const kit = makeKit(dir, to);
  const sha = createHash('sha256').update(kit).digest('hex');
  const manifest = signToken(
    'release',
    { v: 1, typ: 'release', version: to, notes: '', publishedAt: 1, files: [{ target: 'linux-x64', name: releaseFileName(to, 'linux-x64'), sha256: o.badSha ? 'c'.repeat(64) : sha, size: kit.length }] },
    o.rogue ? { kid: 'v1', privateKey: loadPrivateKey(generateKeyPair().privateKeyPem) } : signer,
  );
  writeFileSync(join(dir, 'erp.env'), `PORT=3000\nERP_UPDATER_TOKEN=${TOKEN}\n`);
  // Önceki sürümün yerel kurulum klasörü (geri dönüş sihirbazı burada aranır)
  mkdirSync(join(dir, 'prefix', 'versions', '1.0.0', 'installer'), { recursive: true });
  const cfg: UpdaterConfig = {
    mode: 'native',
    platform: 'linux-x64',
    appUrl: 'http://app.local',
    envFile: join(dir, 'erp.env'),
    workDir: join(dir, 'work'),
    installArgs: ['--port=3000'],
    nativePrefix: join(dir, 'prefix'),
    backupCommand: ['erp-backup'],
  };
  if (o.docker) {
    // Docker kurulum klasörü (sabit): eski kit + kurulumun durumu
    const live = join(dir, 'kurulum');
    for (const d of ['installer', 'deploy/certs', 'backups', 'app']) mkdirSync(join(live, d), { recursive: true });
    writeFileSync(join(live, 'kit.json'), JSON.stringify({ version: '1.0.0', target: 'linux-x64' }));
    writeFileSync(join(live, 'installer', 'install.sh'), 'eski');
    writeFileSync(join(live, 'app', 'eski.js'), 'eski');
    writeFileSync(join(live, 'deploy', 'docker-compose.prod.yml'), '# 1.0.0\n');
    writeFileSync(join(live, 'deploy', '.env'), `ERP_IMAGE=muhasebe-erp:1.0.0\nERP_UPDATER_TOKEN=${TOKEN}\n`);
    writeFileSync(join(live, 'deploy', 'Caddyfile.local'), 'caddy');
    writeFileSync(join(live, 'deploy', 'wizard.conf'), 'TLS_MODE=byo');
    writeFileSync(join(live, 'deploy', 'certs', 'privkey.pem'), 'anahtar');
    writeFileSync(join(live, 'backups', 'erp-erp-1.dump'), 'yedek');
    Object.assign(cfg, { mode: 'docker', envFile: join(live, 'deploy', '.env'), dockerDir: live, dbName: 'erp', nativePrefix: undefined, backupCommand: undefined });
    if (o.https !== undefined) cfg.httpsCheck = { port: 8443, host: 'erp.test' };
  }
  const w: World = { cfg, reports: [], installs: [], state: { version: '1.0.0', pending: true }, io: defaultIO, clock: { t: Date.now() }, dir, reportFails: false };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  w.io = {
    now: () => w.clock.t,
    sleep: async () => {},
    pidAlive: defaultIO.pidAlive,
    httpsStatus: async () => o.https ?? 0,
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://lisans')) return new Response(kit, { status: 200 });
      if (!u.startsWith('http://app.local')) throw new Error(`beklenmeyen adres ${u}`);
      if (w.state.version === null) throw new Error('bağlantı reddedildi');
      if (u.endsWith('/api/public-config')) return json({ version: w.state.version });
      if ((init?.headers as Record<string, string>)['x-updater-token'] !== TOKEN) return json({ error: { message: 'yetkisiz' } }, 401);
      if (u.endsWith('/api/system/updater/pending')) {
        return json({
          update: w.state.pending ? { id: 'u1', version: to, status: 'requested', manifest, file: releaseFileName(to, 'linux-x64'), downloadUrl: `https://lisans.local/v1/releases/${to}/x?t=abc` } : null,
          currentVersion: w.state.version,
        });
      }
      if (u.endsWith('/api/system/updater/report')) {
        if (w.reportFails) return json({ error: { message: 'kısıtlı' } }, 402);
        const b = JSON.parse(String(init?.body)) as { status: string; message?: string };
        w.reports.push({ status: b.status, message: b.message });
        if (['done', 'failed', 'rolled_back'].includes(b.status)) w.state.pending = false;
        return json({ ok: true });
      }
      return json({}, 404);
    }) as typeof fetch,
    run: async (cmd, args, opts) => {
      if (cmd === 'tar') return defaultIO.run(cmd, args, opts);
      if (cmd === 'erp-backup') return { code: 0, output: 'Yedek: /var/lib/muhasebe-erp/backups/erp-1.dump\n' };
      if (cmd === 'docker' && args.includes('pg_dump')) {
        writeFileSync(opts!.stdoutFile!, 'PGDMP');
        return { code: 0, output: '' };
      }
      if (cmd === 'bash') {
        w.installs.push(args);
        const code = (o.installer ?? ((_a, s) => ((s.version = to), 0)))(args, w.state);
        return { code, output: `sihirbaz ${code}` };
      }
      return { code: 127, output: `bilinmeyen komut ${cmd}` };
    },
  };
  return w;
}

describe('ana makine güncelleyicisi', () => {
  it('başarılı: indirir, doğrular, yedekler, yeni kitin sihirbazını çalıştırır, sürümü doğrular', async () => {
    const w = world();
    const r = await new Updater(w.cfg, ring, w.io).runOnce();
    expect(r.outcome).toBe('done');
    expect(w.reports.map((x) => x.status)).toEqual(['downloading', 'applying', 'done']);
    expect(w.installs).toHaveLength(1);
    expect(w.installs[0]![0]).toMatch(/kits[/\\]1\.1\.0[/\\]muhasebe-erp-1\.1\.0-linux-x64[/\\]installer[/\\]install\.sh$/);
    expect(w.installs[0]).toEqual(expect.arrayContaining(['--yes', '--mode=prod', '--path=native', '--port=3000']));
    // İş kalmadı
    expect((await new Updater(w.cfg, ring, w.io).runOnce()).outcome).toBe('idle');
  });

  it('SHA-256 tutmazsa ya da manifesto satıcı imzalı değilse kurulum yapılmaz', async () => {
    for (const w of [world({ badSha: true }), world({ rogue: true })]) {
      const r = await new Updater(w.cfg, ring, w.io).runOnce();
      expect(r.outcome).toBe('failed');
      expect(w.installs).toHaveLength(0);
      expect(w.reports.at(-1)!.status).toBe('failed');
    }
  });

  it('sihirbaz başarısız ama eski sürüm çalışıyor (migration geri alındı) → başarısız, geri dönüş yok', async () => {
    const w = world({ installer: () => 1 });
    const r = await new Updater(w.cfg, ring, w.io).runOnce();
    expect(r.outcome).toBe('failed');
    expect(w.installs).toHaveLength(1);
    expect(w.reports.at(-1)!.message).toContain('önceki sürüm çalışmaya devam ediyor');
  });

  it('yeni sürüm ayağa kalkmazsa eski kit yedekten geri yüklenerek yeniden kurulur', async () => {
    const w = world({
      installer: (args, s) => {
        if (args.some((a) => a.startsWith('--restore-db='))) {
          s.version = '1.0.0';
          return 0;
        }
        s.version = null; // uygulama kapalı kaldı
        return 1;
      },
    });
    const r = await new Updater(w.cfg, ring, w.io).runOnce();
    expect(r.outcome).toBe('rolled_back');
    expect(w.installs).toHaveLength(2);
    expect(w.installs[1]![0]).toMatch(/versions[/\\]1\.0\.0[/\\]installer[/\\]install\.sh$/);
    expect(w.installs[1]).toContain('--restore-db=/var/lib/muhasebe-erp/backups/erp-1.dump');
    // Uygulama kapalıyken bildirimler gidemez; geri dönünce son durum bildirilir
    expect(w.reports.at(-1)!.status).toBe('rolled_back');
  });

  it('aynı anda ikinci çalıştırma beklemez; belirteç yoksa iş yapmaz', async () => {
    const w = world();
    mkdirSync(w.cfg.workDir, { recursive: true });
    writeFileSync(join(w.cfg.workDir, 'updater.lock'), String(process.pid));
    expect((await new Updater(w.cfg, ring, w.io).runOnce()).outcome).toBe('busy');
    const w2 = world();
    writeFileSync(w2.cfg.envFile, 'PORT=3000\n');
    expect((await new Updater(w2.cfg, ring, w2.io).runOnce()).outcome).toBe('idle');
  });

  it('sürüm düşürme reddedilir: kurulum yapılmaz', async () => {
    const w = world({ version: '0.9.0' });
    const r = await new Updater(w.cfg, ring, w.io).runOnce();
    expect(r.outcome).toBe('failed');
    expect(r.message).toMatch(/Sürüm düşürme reddedildi/);
    expect(w.installs).toHaveLength(0);
  });

  it('bakım kilidi bildirilemezse kurulum başlamaz; artan beklemeyle en çok 3 kez denenir', async () => {
    const w = world({ installer: () => 1 });
    w.reportFails = true;
    const u = () => new Updater(w.cfg, ring, w.io).runOnce();
    expect((await u()).outcome).toBe('failed');
    expect(w.installs).toHaveLength(0);
    expect((await u()).outcome).toBe('idle'); // bekleme süresi dolmadı
    expect(w.installs).toHaveLength(0);
    w.clock.t += 16 * 60_000;
    await u();
    expect(w.installs).toHaveLength(0);
    w.clock.t += 61 * 60_000;
    await u();
    expect(w.installs).toHaveLength(0);
    w.clock.t += 5 * 60 * 60_000;
    const last = await u();
    expect(last.outcome).toBe('failed');
    expect(last.message).toMatch(/3 kez denendi/);
    expect(w.installs).toHaveLength(0);
  });

  it('kilit: sahibi ölmüş süreçse bayat sayılır; yaşayan süreçse beklenir', async () => {
    const w = world();
    mkdirSync(w.cfg.workDir, { recursive: true });
    writeFileSync(join(w.cfg.workDir, 'updater.lock'), String(process.pid));
    expect((await new Updater(w.cfg, ring, w.io).runOnce()).outcome).toBe('busy');
    writeFileSync(join(w.cfg.workDir, 'updater.lock'), '2147483646');
    expect((await new Updater(w.cfg, ring, w.io).runOnce()).outcome).toBe('done');
  });

  it('Docker: kurulum klasörü sabit kalır; program dosyaları yerinde değişir, ayarlar/sertifikalar/yedekler korunur; HTTPS doğrulanır', async () => {
    const w = world({ docker: true, https: 200 });
    const live = w.cfg.dockerDir!;
    const bk = join(w.cfg.workDir, 'backups');
    mkdirSync(bk, { recursive: true });
    for (let i = 1; i <= 5; i++) writeFileSync(join(bk, `erp-oncesi-2026-01-0${i}T00-00-00-000Z.dump`), 'x');
    const r = await new Updater(w.cfg, ring, w.io).runOnce();
    expect(r.outcome, r.message).toBe('done');
    expect(w.installs[0]![0]).toBe(join(live, 'installer', 'install.sh'));
    expect(JSON.parse(readFileSync(join(live, 'kit.json'), 'utf8')).version).toBe('1.1.0');
    expect(readFileSync(join(live, 'deploy', 'docker-compose.prod.yml'), 'utf8')).toBe('# 1.1.0\n');
    expect(existsSync(join(live, 'app', 'eski.js'))).toBe(false);
    for (const [f, v] of [['deploy/Caddyfile.local', 'caddy'], ['deploy/wizard.conf', 'TLS_MODE=byo'], ['deploy/certs/privkey.pem', 'anahtar'], ['backups/erp-erp-1.dump', 'yedek']]) {
      expect(readFileSync(join(live, f!), 'utf8'), f).toBe(v);
    }
    expect(readFileSync(join(live, 'deploy', '.env'), 'utf8')).toContain('ERP_UPDATER_TOKEN=');
    // Güncelleme öncesi dökümlerden yalnızca son 3'ü kalır
    expect(readdirSync(bk).filter((n) => n.startsWith('erp-oncesi-'))).toHaveLength(3);
  });

  it('Docker: HTTPS yanıt vermezse "bitti" bildirilmez', async () => {
    const w = world({ docker: true, https: 0 });
    const r = await new Updater(w.cfg, ring, w.io).runOnce();
    expect(r.outcome).toBe('failed');
    expect(w.reports.at(-1)).toMatchObject({ status: 'failed' });
    expect(w.reports.at(-1)!.message).toMatch(/HTTPS/);
  });

  it('Docker: yeni sürüm ayağa kalkmazsa eski dosyalar yerine konur ve aynı klasörden yedekle geri dönülür', async () => {
    const w = world({
      docker: true,
      installer: (args, s) => {
        if (args.some((a) => a.startsWith('--restore-db='))) {
          s.version = '1.0.0';
          return 0;
        }
        s.version = null;
        return 1;
      },
    });
    const live = w.cfg.dockerDir!;
    const r = await new Updater(w.cfg, ring, w.io).runOnce();
    expect(r.outcome).toBe('rolled_back');
    expect(w.installs[1]![0]).toBe(join(live, 'installer', 'install.sh'));
    expect(readFileSync(join(live, 'installer', 'install.sh'), 'utf8')).toBe('eski');
    expect(JSON.parse(readFileSync(join(live, 'kit.json'), 'utf8')).version).toBe('1.0.0');
    expect(readFileSync(join(live, 'deploy', 'docker-compose.prod.yml'), 'utf8')).toBe('# 1.0.0\n');
    expect(readFileSync(join(live, 'deploy', 'Caddyfile.local'), 'utf8')).toBe('caddy');
  });
});
