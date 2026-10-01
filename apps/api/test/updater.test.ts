import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
}

function world(o: { version?: string; badSha?: boolean; rogue?: boolean; installer?: (args: string[], s: World['state']) => number } = {}): World {
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
  const w: World = { cfg, reports: [], installs: [], state: { version: '1.0.0', pending: true }, io: defaultIO };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  w.io = {
    now: () => Date.now(),
    sleep: async () => {},
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
    expect(w.installs[0]![0]).toMatch(/kits\/1\.1\.0\/muhasebe-erp-1\.1\.0-linux-x64\/installer\/install\.sh$/);
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
    expect(w.installs[1]![0]).toMatch(/versions\/1\.0\.0\/installer\/install\.sh$/);
    expect(w.installs[1]).toContain('--restore-db=/var/lib/muhasebe-erp/backups/erp-1.dump');
    // Uygulama kapalıyken bildirimler gidemez; geri dönünce son durum bildirilir
    expect(w.reports.at(-1)!.status).toBe('rolled_back');
  });

  it('aynı anda ikinci çalıştırma beklemez; belirteç yoksa iş yapmaz', async () => {
    const w = world();
    mkdirSync(w.cfg.workDir, { recursive: true });
    writeFileSync(join(w.cfg.workDir, 'updater.lock'), '1');
    expect((await new Updater(w.cfg, ring, w.io).runOnce()).outcome).toBe('busy');
    const w2 = world();
    writeFileSync(w2.cfg.envFile, 'PORT=3000\n');
    expect((await new Updater(w2.cfg, ring, w2.io).runOnce()).outcome).toBe('idle');
  });
});
