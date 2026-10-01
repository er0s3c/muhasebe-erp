/**
 * Ana makine güncelleyicisi (`dist/updater.js`): kurulum sihirbazı her dakika çalışacak şekilde zamanlar (systemd zamanlayıcısı /
 * Windows zamanlanmış görevi; yönetici yetkisiyle). Tek seferlik çalışır:
 *
 *   1) Uygulamadan zamanı gelmiş, sahibin onayladığı güncellemeyi ister (paylaşılan ERP_UPDATER_TOKEN; yoksa çıkar).
 *   2) Satıcı imzalı manifestoyu gömülü anahtarla doğrular, kiti lisans sunucusundan indirir, SHA-256 ve boyutu denetler.
 *   3) Yedek alır (yerel: erp-backup; Docker: pg_dump kap içinde). Yedek alınamazsa güncelleme yapılmaz.
 *   4) Kiti açar ve YENİ kitin kurulum sihirbazını etkileşimsiz çalıştırır (durdurma, kopyalama, migration, başlatma, sağlık).
 *   5) Uygulamanın yeni sürümle yanıt verdiğini doğrular → "bitti".
 *   6) Başarısızlıkta: eski sürüm hâlâ yanıt veriyorsa (migration geri alındı) → "başarısız"; yanıt yoksa ya da yeni sürüm bozuksa
 *      ESKİ kitin sihirbazı yedekten veritabanını geri yükleyerek yeniden kurar → "geri alındı".
 *
 * Dış bağımlılık yoktur (paket tek dosyadır; node_modules gerekmez). Günlük: <workDir>/updater.log.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseReleaseManifest, type PublicKeyring, type ReleaseManifest } from '@erp/license-core';

export interface UpdaterConfig {
  mode: 'native' | 'docker';
  platform: 'linux-x64' | 'win-x64';
  /** Uygulamanın yerel adresi (ör. http://127.0.0.1:3000). */
  appUrl: string;
  /** ERP_UPDATER_TOKEN'ın okunduğu ortam dosyası (erp.env / deploy/.env). */
  envFile: string;
  workDir: string;
  /** Sihirbaza aktarılacak ek argümanlar (port, erişim). */
  installArgs: string[];
  /** Yerel kurulum kökü (sürümler `<prefix>/versions/<sürüm>`). */
  nativePrefix?: string;
  /** Docker kurulumunun kit klasörü (deploy/.env burada). */
  dockerDir?: string;
  /** Yerel kurulum yedek komutu (çıktısında "Yedek: <yol>" satırı). */
  backupCommand?: string[];
  dbName?: string;
}

export interface PendingUpdate {
  id: string;
  version: string;
  status: string;
  manifest: string;
  file: string;
  downloadUrl: string;
}

export interface RunResult {
  outcome: 'idle' | 'busy' | 'done' | 'failed' | 'rolled_back' | 'app_unreachable';
  message?: string;
}

/** Komut çalıştırma ve HTTP: testlerde değiştirilebilir. */
export interface UpdaterIO {
  fetch: typeof fetch;
  run: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; stdoutFile?: string }) => Promise<{ code: number; output: string }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const LOG_MAX = 5 * 1024 * 1024;
const REPORT_LOG_MAX = 60_000;

export function readEnvValue(file: string, key: string): string | null {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return null;
}

export const defaultIO: UpdaterIO = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  run: (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env, ERP_UPDATER_RUN: '1' } });
      let output = '';
      const out = opts.stdoutFile ? createWriteStream(opts.stdoutFile) : null;
      const keep = (b: Buffer) => {
        output += b.toString('utf8');
        if (output.length > 400_000) output = output.slice(-300_000);
      };
      if (out) child.stdout.pipe(out);
      else child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null;
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ code: 127, output: `${output}\n${err.message}` });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        out?.end();
        resolve({ code: code ?? 1, output });
      });
    }),
};

export class Updater {
  private logText = '';

  constructor(
    private readonly cfg: UpdaterConfig,
    private readonly keyring: PublicKeyring,
    private readonly io: UpdaterIO = defaultIO,
  ) {}

  private async log(msg: string) {
    const line = `[${new Date(this.io.now()).toISOString()}] ${msg}\n`;
    this.logText += line;
    const file = join(this.cfg.workDir, 'updater.log');
    try {
      if (existsSync(file) && statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`);
      await appendFile(file, line);
    } catch {
      // günlük yazılamazsa güncelleme yine de sürer
    }
  }

  private token(): string | null {
    return readEnvValue(this.cfg.envFile, 'ERP_UPDATER_TOKEN');
  }

  private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.io.fetch(`${this.cfg.appUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { 'x-updater-token': this.token() ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    return json;
  }

  private async report(id: string, status: string, message?: string) {
    try {
      await this.api('POST', '/api/system/updater/report', { id, status, ...(message ? { message: message.slice(0, 2000) } : {}), log: this.logText.slice(-REPORT_LOG_MAX) });
    } catch (err) {
      await this.log(`durum bildirilemedi (${status}): ${(err as Error).message}`);
    }
  }

  /** Uygulamanın çalışan sürümü (yanıt yoksa null). */
  private async runningVersion(): Promise<string | null> {
    try {
      const res = await this.io.fetch(`${this.cfg.appUrl.replace(/\/+$/, '')}/api/public-config`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return ((await res.json()) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  }

  private async waitVersion(version: string, seconds: number): Promise<boolean> {
    for (let i = 0; i < seconds; i += 2) {
      if ((await this.runningVersion()) === version) return true;
      await this.io.sleep(2000);
    }
    return false;
  }

  /** Aynı anda tek güncelleyici (zamanlayıcı her dakika tetikler). 3 saatten eski kilit bayat sayılır. */
  private lock(): (() => void) | null {
    mkdirSync(this.cfg.workDir, { recursive: true });
    const file = join(this.cfg.workDir, 'updater.lock');
    if (existsSync(file) && this.io.now() - statSync(file).mtimeMs > 3 * 60 * 60 * 1000) rmSync(file, { force: true });
    try {
      closeSync(openSync(file, 'wx'));
    } catch {
      return null;
    }
    writeFileSync(file, String(process.pid));
    return () => rmSync(file, { force: true });
  }

  private async download(p: PendingUpdate, m: ReleaseManifest): Promise<string> {
    const entry = m.files.find((f) => f.target === this.cfg.platform && f.name === p.file);
    if (!entry) throw new Error(`Manifestoda ${this.cfg.platform} için ${p.file} yok`);
    const dir = join(this.cfg.workDir, 'downloads');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, entry.name);
    if (existsSync(dest) && statSync(dest).size === entry.size && sha256File(dest) === entry.sha256) {
      await this.log(`indirme önbellekte: ${entry.name}`);
      return dest;
    }
    await this.log(`indiriliyor: ${entry.name} (${Math.round(entry.size / 1024 / 1024)} MB)`);
    const res = await this.io.fetch(p.downloadUrl, { redirect: 'error', signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`İndirme başarısız (HTTP ${res.status})`);
    const part = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    const size = statSync(part).size;
    const sum = sha256File(part);
    if (size !== entry.size || sum !== entry.sha256) {
      rmSync(part, { force: true });
      throw new Error('İndirilen dosyanın SHA-256 özeti ya da boyutu manifestoyla uyuşmuyor (bozuk ya da değiştirilmiş)');
    }
    renameSync(part, dest);
    return dest;
  }

  private async backup(): Promise<string> {
    const dir = join(this.cfg.workDir, 'backups');
    mkdirSync(dir, { recursive: true });
    if (this.cfg.mode === 'docker') {
      const out = join(dir, `erp-oncesi-${new Date(this.io.now()).toISOString().replace(/[:.]/g, '-')}.dump`);
      const r = await this.io.run('docker', [...this.composeArgs(this.cfg.dockerDir!), 'exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-Fc', this.cfg.dbName ?? 'erp'], {
        stdoutFile: out,
        timeoutMs: 60 * 60_000,
      });
      if (r.code !== 0 || !existsSync(out) || statSync(out).size === 0) throw new Error(`Yedek alınamadı: ${r.output.slice(-500)}`);
      return out;
    }
    const [cmd, ...args] = this.cfg.backupCommand ?? [];
    if (!cmd) throw new Error('Yedek komutu yapılandırılmamış');
    const r = await this.io.run(cmd, args, { timeoutMs: 60 * 60_000 });
    const path = /Yedek: (.+)$/m.exec(r.output)?.[1]?.trim();
    if (r.code !== 0 || !path) throw new Error(`Yedek alınamadı: ${r.output.slice(-500)}`);
    return path;
  }

  private composeArgs(dir: string) {
    return ['compose', '-f', join(dir, 'deploy', 'docker-compose.prod.yml'), '--env-file', join(dir, 'deploy', '.env')];
  }

  private async extract(archive: string, version: string): Promise<string> {
    const dest = join(this.cfg.workDir, 'kits', version);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const r =
      this.cfg.platform === 'win-x64'
        ? await this.io.run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`])
        : await this.io.run('tar', ['-xzf', archive, '-C', dest]);
    if (r.code !== 0) throw new Error(`Kit açılamadı: ${r.output.slice(-500)}`);
    const kit = readdirSync(dest).find((n) => existsSync(join(dest, n, 'kit.json')));
    if (!kit) throw new Error('Arşivde kit.json bulunamadı');
    const meta = JSON.parse(readFileSync(join(dest, kit, 'kit.json'), 'utf8')) as { version?: string; target?: string };
    if (meta.version !== version || meta.target !== this.cfg.platform) throw new Error(`Kit sürümü/hedefi beklenenden farklı (${meta.version} ${meta.target})`);
    return join(dest, kit);
  }

  /** Kitin kurulum sihirbazını etkileşimsiz çalıştırır (isteğe bağlı yedekten veritabanı geri yükleme ile). */
  private installer(kitDir: string, restoreDb?: string): Promise<{ code: number; output: string }> {
    if (this.cfg.platform === 'win-x64') {
      return this.io.run(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(kitDir, 'installer', 'install.ps1'), '-Yes', '-Mode', 'prod', '-Path', this.cfg.mode, ...this.cfg.installArgs, ...(restoreDb ? ['-RestoreDb', restoreDb] : [])],
        { cwd: kitDir, timeoutMs: 60 * 60_000 },
      );
    }
    return this.io.run('bash', [join(kitDir, 'installer', 'install.sh'), '--yes', '--mode=prod', `--path=${this.cfg.mode}`, ...this.cfg.installArgs, ...(restoreDb ? [`--restore-db=${restoreDb}`] : [])], {
      cwd: kitDir,
      timeoutMs: 60 * 60_000,
    });
  }

  private previousKit(fromVersion: string): string | null {
    if (this.cfg.mode === 'docker') return this.cfg.dockerDir && existsSync(join(this.cfg.dockerDir, 'kit.json')) ? this.cfg.dockerDir : null;
    const dir = this.cfg.nativePrefix ? join(this.cfg.nativePrefix, 'versions', fromVersion) : null;
    return dir && existsSync(join(dir, 'installer')) ? dir : null;
  }

  async runOnce(): Promise<RunResult> {
    const release = this.lock();
    if (!release) return { outcome: 'busy' };
    try {
      if (!this.token()) return { outcome: 'idle', message: 'ERP_UPDATER_TOKEN yok' };
      let pending: { update: PendingUpdate | null; currentVersion?: string };
      try {
        pending = await this.api('GET', '/api/system/updater/pending');
      } catch (err) {
        return { outcome: 'app_unreachable', message: (err as Error).message };
      }
      const p = pending.update;
      if (!p) return { outcome: 'idle' };
      const fromVersion = pending.currentVersion ?? '';
      // Önceki deneme yarıda kaldıysa ve yeni sürüm zaten çalışıyorsa yalnızca bildir
      if (fromVersion === p.version) {
        await this.report(p.id, 'done', 'Yeni sürüm çalışıyor');
        return { outcome: 'done' };
      }
      await this.log(`güncelleme başlıyor: ${fromVersion} → ${p.version}`);
      await this.report(p.id, 'downloading');

      let manifest: ReleaseManifest;
      let archive: string;
      try {
        manifest = parseReleaseManifest(p.manifest, this.keyring);
        if (manifest.version !== p.version) throw new Error('Manifesto sürümü uyuşmuyor');
        archive = await this.download(p, manifest);
      } catch (err) {
        await this.log(`indirme/doğrulama hatası: ${(err as Error).message}`);
        await this.report(p.id, 'failed', (err as Error).message);
        return { outcome: 'failed', message: (err as Error).message };
      }

      let backup: string;
      let kitDir: string;
      try {
        backup = await this.backup();
        await this.log(`yedek alındı: ${backup}`);
        kitDir = await this.extract(archive, p.version);
        if (this.cfg.mode === 'docker') {
          // Docker kurulumunun parolaları ve ayarları yeni kit klasörüne taşınır (aynı compose projesi, aynı birimler)
          mkdirSync(join(kitDir, 'deploy'), { recursive: true });
          writeFileSync(join(kitDir, 'deploy', '.env'), readFileSync(join(this.cfg.dockerDir!, 'deploy', '.env')), { mode: 0o600 });
        }
      } catch (err) {
        await this.log(`hazırlık hatası: ${(err as Error).message}`);
        await this.report(p.id, 'failed', (err as Error).message);
        return { outcome: 'failed', message: (err as Error).message };
      }

      await this.report(p.id, 'applying');
      await this.log(`sihirbaz çalışıyor: ${kitDir}`);
      const r = await this.installer(kitDir);
      await this.log(`sihirbaz çıkış kodu ${r.code}\n${r.output.slice(-20_000)}`);
      if (r.code === 0 && (await this.waitVersion(p.version, 180))) {
        await this.log('güncelleme tamamlandı');
        await this.report(p.id, 'done');
        this.prune(p.version, fromVersion);
        return { outcome: 'done' };
      }

      // Başarısız: eski sürüm hâlâ yanıt veriyorsa (migration tek işlemde geri alındı) yalnızca bildir
      const running = await this.runningVersion();
      if (running === fromVersion) {
        const msg = 'Güncelleme uygulanamadı; önceki sürüm çalışmaya devam ediyor (veritabanı değişmedi). Ayrıntı günlükte.';
        await this.log(msg);
        await this.report(p.id, 'failed', msg);
        return { outcome: 'failed', message: msg };
      }
      // Yeni sürüm bozuk ya da uygulama kapalı: eski kitle yedekten geri dön
      const prev = this.previousKit(fromVersion);
      if (!prev) {
        const msg = `Güncelleme başarısız ve önceki sürüm (${fromVersion}) bulunamadı; yedek: ${backup}. Elle geri yükleme gerekir (docs/OPERATIONS.md §6).`;
        await this.log(msg);
        await this.report(p.id, 'failed', msg);
        return { outcome: 'failed', message: msg };
      }
      await this.log(`geri dönülüyor: ${prev} (yedek ${backup})`);
      const rb = await this.installer(prev, backup);
      await this.log(`geri dönüş çıkış kodu ${rb.code}\n${rb.output.slice(-20_000)}`);
      if (rb.code === 0 && (await this.waitVersion(fromVersion, 180))) {
        const msg = `Güncelleme başarısız; ${fromVersion} sürümüne ve güncelleme öncesi yedeğe geri dönüldü.`;
        await this.report(p.id, 'rolled_back', msg);
        return { outcome: 'rolled_back', message: msg };
      }
      const msg = `Güncelleme ve geri dönüş başarısız; uygulama yanıt vermiyor. Yedek: ${backup}. Elle müdahale gerekir.`;
      await this.log(msg);
      await this.report(p.id, 'failed', msg);
      return { outcome: 'failed', message: msg };
    } finally {
      release();
    }
  }

  /** Eski indirmeleri ve kitleri temizler: yeni ve bir önceki sürüm kalır (Docker kit klasörü kullanımdadır). */
  private prune(keep: string, previous: string) {
    for (const sub of ['downloads', 'kits']) {
      const dir = join(this.cfg.workDir, sub);
      if (!existsSync(dir)) continue;
      for (const n of readdirSync(dir)) {
        if (n.includes(keep) || n.includes(previous)) continue;
        rmSync(join(dir, n), { recursive: true, force: true });
      }
    }
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
