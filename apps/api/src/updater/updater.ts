/**
 * Ana makine güncelleyicisi (`dist/updater.js`): kurulum sihirbazı her dakika çalışacak şekilde zamanlar (systemd zamanlayıcısı /
 * Windows zamanlanmış görevi; yönetici yetkisiyle). Tek seferlik çalışır:
 *
 *   1) Uygulamadan zamanı gelmiş, sahibin onayladığı güncellemeyi ister (paylaşılan ERP_UPDATER_TOKEN; yoksa çıkar).
 *   2) Satıcı imzalı manifestoyu gömülü anahtarla doğrular, kiti lisans sunucusundan indirir, SHA-256 ve boyutu denetler.
 *   3) Yedek alır (yerel: erp-backup; Docker: pg_dump kap içinde). Yedek alınamazsa güncelleme yapılmaz.
 *   4) Kiti açar ve YENİ kitin kurulum sihirbazını etkileşimsiz çalıştırır (durdurma, kopyalama, migration, başlatma, sağlık).
 *      Docker yolunda kurulum klasörü SABİTTİR: yeni kitin program dosyaları kurulum klasörüne yerinde konur (eskileri geri dönüş
 *      için saklanır); deploy/.env, Caddyfile.local, certs/, wizard.conf ve backups/ hiç taşınmaz.
 *   5) Uygulamanın yeni sürümle yanıt verdiğini (HTTPS yapılandırılmışsa HTTPS üzerinden de) doğrular → "bitti".
 *   6) Başarısızlıkta: eski sürüm hâlâ yanıt veriyorsa (migration geri alındı) → "başarısız"; yanıt yoksa ya da yeni sürüm bozuksa
 *      ESKİ kitin sihirbazı yedekten veritabanını geri yükleyerek yeniden kurar → "geri alındı".
 *
 * Korumalar: sürüm düşürme reddedilir; aynı güncelleme en çok `maxAttempts` kez (artan beklemeyle) denenir; kilit, onu tutan
 * süreç yaşıyorsa (ve 6 saatten yeni ise) geçerlidir; güncelleme öncesi Docker dökümlerinden yalnızca son `keepBackups` tanesi kalır.
 *
 * Dış bağımlılık yoktur (paket tek dosyadır; node_modules gerekmez). Günlük: <workDir>/updater.log.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  createWriteStream,
  createReadStream,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions, parseReleaseManifest, type PublicKeyring, type ReleaseManifest } from '@erp/license-core';

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
  /** HTTPS (Caddy) yapılandırılmışsa: güncellemeden sonra https://127.0.0.1:<port> (SNI: host) üzerinden sağlık denetimi. */
  httpsCheck?: { port: number; host: string; caFile?: string };
  /** Aynı güncellemenin en çok kaç kez deneneceği (varsayılan 3). */
  maxAttempts?: number;
  /** Docker yolunda güncelleme öncesi dökümlerden kaç tanesi saklanır (varsayılan 3). */
  keepBackups?: number;
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
  /** HTTPS sağlık denetimi: güvenilir CA ve sunucu adı doğrulanır. */
  httpsStatus?: (port: number, host: string, path: string, caFile?: string) => Promise<number>;
  /** Sürecin yaşayıp yaşamadığı (kilit bayatlığı). */
  pidAlive?: (pid: number) => boolean;
}

const LOG_MAX = 5 * 1024 * 1024;
const REPORT_LOG_MAX = 60_000;
const LOCK_MAX_MS = 6 * 60 * 60 * 1000;
/** n. yeniden denemeden önce beklenecek süre (ilk deneme hemen). */
const RETRY_BACKOFF_MS = [0, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
/** Kitle gelen (kurulum klasöründe değiştirilecek) üst düzey girdiler; deploy/ ve backups/ ayrıca ele alınır. */
const KIT_ENTRIES = ['app', 'installer', 'scripts', 'infra', 'docs', 'image', 'docker', 'winsw', 'kit.json', 'install.sh', 'Kur.cmd', 'README.md', 'THIRD-PARTY-NOTICES.md'];

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function httpsStatus(port: number, host: string, path: string, caFile?: string): Promise<number> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path, method: 'GET', servername: /^[\d.]+$/.test(host) ? undefined : host, headers: { host }, rejectUnauthorized: true, ...(caFile ? { ca: readFileSync(caFile) } : {}), timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

/** Yeniden adlandırma; farklı dosya sistemindeyse kopyala + sil. */
function moveSync(from: string, to: string) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function chownTree(path: string, uid: number, gid: number) {
  const st = lstatSync(path);
  lchownSync(path, uid, gid);
  if (st.isDirectory()) for (const n of readdirSync(path)) chownTree(join(path, n), uid, gid);
}

export function readEnvValue(file: string, key: string): string | null {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return null;
}

export const defaultIO: UpdaterIO = {
  httpsStatus,
  pidAlive,
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

  private async report(id: string, status: string, message?: string, required = false) {
    try {
      await this.api('POST', '/api/system/updater/report', { id, status, ...(message ? { message: message.slice(0, 2000) } : {}), log: this.logText.slice(-REPORT_LOG_MAX) });
    } catch (err) {
      await this.log(`durum bildirilemedi (${status}): ${(err as Error).message}`);
      if (required) throw new Error('Güncelleme bakım kilidi doğrulanamadı; kurulum başlamadı', { cause: err });
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

  /**
   * Aynı anda tek güncelleyici (zamanlayıcı her dakika tetikler). Kilit dosyası sahibinin PID'ini taşır: süreç ölmüşse (çökme,
   * yeniden başlatma) kilit hemen bayat sayılır; süreç yaşıyorsa (uzun süren güncelleme) kilit 6 saate kadar geçerlidir.
   */
  private lock(): (() => void) | null {
    mkdirSync(this.cfg.workDir, { recursive: true, mode: 0o700 });
    const file = join(this.cfg.workDir, 'updater.lock');
    if (existsSync(file)) {
      const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
      const age = this.io.now() - statSync(file).mtimeMs;
      const alive = (this.io.pidAlive ?? pidAlive)(pid);
      if (!alive || age > LOCK_MAX_MS) rmSync(file, { force: true });
    }
    try {
      closeSync(openSync(file, 'wx'));
    } catch {
      return null;
    }
    writeFileSync(file, String(process.pid));
    return () => rmSync(file, { force: true });
  }

  // ---- Deneme sayacı (bildirim gidemese bile aynı güncelleme her dakika baştan denenmesin) --------------------------------
  private attemptsFile() {
    return join(this.cfg.workDir, 'attempts.json');
  }
  private readAttempts(): Record<string, { count: number; last: number }> {
    try {
      return JSON.parse(readFileSync(this.attemptsFile(), 'utf8')) as Record<string, { count: number; last: number }>;
    } catch {
      return {};
    }
  }
  private writeAttempts(a: Record<string, { count: number; last: number }>) {
    try {
      writeFileSync(this.attemptsFile(), JSON.stringify(a), { mode: 0o600 });
    } catch {
      // sayaç yazılamazsa deneme yine yapılır
    }
  }

  private async download(p: PendingUpdate, m: ReleaseManifest): Promise<string> {
    const entry = m.files.find((f) => f.target === this.cfg.platform && f.name === p.file);
    if (!entry) throw new Error(`Manifestoda ${this.cfg.platform} için ${p.file} yok`);
    const dir = join(this.cfg.workDir, 'downloads');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, entry.name);
    if (existsSync(dest) && statSync(dest).size === entry.size && await sha256File(dest) === entry.sha256) {
      await this.log(`indirme önbellekte: ${entry.name}`);
      return dest;
    }
    await this.log(`indiriliyor: ${entry.name} (${Math.round(entry.size / 1024 / 1024)} MB)`);
    const res = await this.io.fetch(p.downloadUrl, { redirect: 'error', signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`İndirme başarısız (HTTP ${res.status})`);
    const part = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    const size = statSync(part).size;
    const sum = await sha256File(part);
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
      if (r.code !== 0 || !existsSync(out) || statSync(out).size === 0) {
        rmSync(out, { force: true });
        throw new Error(`Yedek alınamadı: ${r.output.slice(-500)}`);
      }
      this.pruneBackups(dir);
      return out;
    }
    const [cmd, ...args] = this.cfg.backupCommand ?? [];
    if (!cmd) throw new Error('Yedek komutu yapılandırılmamış');
    const r = await this.io.run(cmd, args, { timeoutMs: 60 * 60_000 });
    const path = /Yedek: (.+)$/m.exec(r.output)?.[1]?.trim();
    if (r.code !== 0 || !path) throw new Error(`Yedek alınamadı: ${r.output.slice(-500)}`);
    return path;
  }

  /** Güncelleme öncesi dökümlerden (erp-oncesi-*.dump) en yeni `keepBackups` tanesi kalır. */
  private pruneBackups(dir: string) {
    const keep = Math.max(1, this.cfg.keepBackups ?? 3);
    const dumps = readdirSync(dir)
      .filter((n) => /^erp-oncesi-[0-9TZ-]+\.dump$/.test(n))
      .sort()
      .reverse();
    for (const n of dumps.slice(keep)) rmSync(join(dir, n), { force: true });
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

  /**
   * Docker yolu: yeni kitin program dosyalarını SABİT kurulum klasörüne koyar; eski dosyalar `stash` klasörüne alınır (geri
   * dönüş için). Kurulumun durumu (deploy/.env, Caddyfile.local, certs/, wizard.conf, *.bak-*, backups/) yerinde kalır.
   */
  private swapKit(live: string, next: string, stash: string) {
    rmSync(stash, { recursive: true, force: true });
    mkdirSync(join(stash, 'deploy'), { recursive: true });
    const names = [...new Set([...readdirSync(next), ...KIT_ENTRIES])].filter((n) => n !== 'deploy' && n !== 'backups');
    const deploy = existsSync(join(next, 'deploy')) ? readdirSync(join(next, 'deploy')) : [];
    // Yarıda kalırsa geri alınabilsin diye önce liste yazılır
    writeFileSync(join(stash, 'swap.json'), JSON.stringify({ names, deploy }));
    if (existsSync(join(live, 'deploy', '.env'))) cpSync(join(live, 'deploy', '.env'), join(stash, 'env.before'));
    const owner = statSync(live);
    for (const [rel, dst] of [...names.map((n) => [n, n] as const), ...deploy.map((f) => [join('deploy', f), join('deploy', f)] as const)]) {
      if (existsSync(join(live, rel))) moveSync(join(live, rel), join(stash, dst));
      if (existsSync(join(next, rel))) {
        moveSync(join(next, rel), join(live, rel));
        // Kit klasörü kurulumu yapan kullanıcınındır: yeni dosyalar da onun olsun (güncelleyici root/SYSTEM çalışır)
        if (process.platform !== 'win32' && process.getuid?.() === 0) chownTree(join(live, rel), owner.uid, owner.gid);
      }
    }
  }

  /** swapKit'i geri alır: yeni dosyalar silinir, eskiler (ve güncelleme öncesi deploy/.env) yerine konur. */
  private unswapKit(live: string, stash: string) {
    const listFile = join(stash, 'swap.json');
    if (!existsSync(listFile)) return;
    const { names, deploy } = JSON.parse(readFileSync(listFile, 'utf8')) as { names: string[]; deploy: string[] };
    for (const rel of [...names, ...deploy.map((f) => join('deploy', f))]) {
      rmSync(join(live, rel), { recursive: true, force: true });
      if (existsSync(join(stash, rel))) moveSync(join(stash, rel), join(live, rel));
    }
    if (existsSync(join(stash, 'env.before'))) writeFileSync(join(live, 'deploy', '.env'), readFileSync(join(stash, 'env.before')), { mode: 0o600 });
    rmSync(listFile, { force: true });
  }

  /** HTTPS yapılandırılmışsa Caddy'nin yeni sürümü sunduğunu doğrular. */
  private async verifyHttps(): Promise<boolean> {
    const h = this.cfg.httpsCheck;
    if (!h) return true;
    const probe = this.io.httpsStatus ?? httpsStatus;
    for (let i = 0; i < 45; i++) {
      if ((await probe(h.port, h.host, '/api/health/ready', h.caFile)) === 200) return true;
      await this.io.sleep(2000);
    }
    return false;
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
        this.forget(p.id);
        return { outcome: 'done' };
      }
      // Sürüm düşürme yapılmaz (veritabanı yeni şemaya taşınmış olabilir; geri dönüş yalnızca başarısız güncellemenin parçasıdır)
      if (/^\d+\.\d+\.\d+/.test(fromVersion) && compareVersions(p.version, fromVersion) < 0) {
        const msg = `Sürüm düşürme reddedildi: çalışan ${fromVersion}, istenen ${p.version}`;
        await this.log(msg);
        await this.report(p.id, 'failed', msg);
        return { outcome: 'failed', message: msg };
      }
      // Deneme sınırı ve artan bekleme: durum bildirilemese de (uygulama kapalı/kısıtlı) her dakika baştan kesinti yaşanmaz
      const attempts = this.readAttempts();
      const prev = attempts[p.id] ?? { count: 0, last: 0 };
      const max = Math.max(1, this.cfg.maxAttempts ?? 3);
      if (prev.count >= max) {
        const msg = `Güncelleme ${prev.count} kez denendi ve başarılamadı; yeniden denenmeyecek (günlük: ${join(this.cfg.workDir, 'updater.log')}). Yeniden onaylayın ya da yerelde kurun.`;
        await this.report(p.id, 'failed', msg);
        return { outcome: 'failed', message: msg };
      }
      const wait = RETRY_BACKOFF_MS[Math.min(prev.count, RETRY_BACKOFF_MS.length - 1)]!;
      if (prev.count > 0 && this.io.now() - prev.last < wait) return { outcome: 'idle', message: 'yeniden deneme zamanı gelmedi' };
      attempts[p.id] = { count: prev.count + 1, last: this.io.now() };
      this.writeAttempts(attempts);
      await this.log(`güncelleme başlıyor: ${fromVersion} → ${p.version} (deneme ${prev.count + 1}/${max})`);
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
      const docker = this.cfg.mode === 'docker';
      const stash = join(this.cfg.workDir, 'kits', `${fromVersion || 'onceki'}-onceki`);
      try {
        await this.report(p.id, 'applying', undefined, true);
        backup = await this.backup();
        await this.log(`yedek alındı: ${backup}`);
        kitDir = await this.extract(archive, p.version);
        if (docker) {
          // Kurulum klasörü sabit kalır: yeni program dosyaları yerinde değiştirilir (ayarlar, sertifikalar, yedekler taşınmaz)
          this.swapKit(this.cfg.dockerDir!, kitDir, stash);
          await this.log(`kit dosyaları kurulum klasörüne kondu: ${this.cfg.dockerDir} (eskiler: ${stash})`);
          kitDir = this.cfg.dockerDir!;
        }
      } catch (err) {
        if (docker) this.unswapKit(this.cfg.dockerDir!, stash);
        await this.log(`hazırlık hatası: ${(err as Error).message}`);
        await this.report(p.id, 'failed', (err as Error).message);
        return { outcome: 'failed', message: (err as Error).message };
      }

      await this.log(`sihirbaz çalışıyor: ${kitDir}`);
      const r = await this.installer(kitDir);
      await this.log(`sihirbaz çıkış kodu ${r.code}\n${r.output.slice(-20_000)}`);
      if (r.code === 0 && (await this.waitVersion(p.version, 180))) {
        if (!(await this.verifyHttps())) {
          const h = this.cfg.httpsCheck!;
          const msg = `Uygulama ${p.version} sürümünde çalışıyor ama HTTPS (Caddy, ${h.host}:${h.port}) yanıt vermiyor. Elle denetleyin: docker compose … --profile tls logs caddy`;
          await this.log(msg);
          await this.report(p.id, 'failed', msg);
          this.forget(p.id);
          return { outcome: 'failed', message: msg };
        }
        await this.log('güncelleme tamamlandı');
        await this.report(p.id, 'done');
        this.forget(p.id);
        this.prune(p.version, fromVersion);
        return { outcome: 'done' };
      }

      // Başarısız: eski sürüm hâlâ yanıt veriyorsa (migration tek işlemde geri alındı) yalnızca bildir
      const running = await this.runningVersion();
      if (running === fromVersion) {
        // Kurulum klasörü çalışan sürümle uyumlu kalsın
        if (docker) this.unswapKit(this.cfg.dockerDir!, stash);
        const msg = 'Güncelleme uygulanamadı; önceki sürüm çalışmaya devam ediyor (veritabanı değişmedi). Ayrıntı günlükte.';
        await this.log(msg);
        await this.report(p.id, 'failed', msg);
        return { outcome: 'failed', message: msg };
      }
      // Yeni sürüm bozuk ya da uygulama kapalı: eski kitle yedekten geri dön
      if (docker) this.unswapKit(this.cfg.dockerDir!, stash);
      const prevKit = this.previousKit(fromVersion);
      if (!prevKit) {
        const msg = `Güncelleme başarısız ve önceki sürüm (${fromVersion}) bulunamadı; yedek: ${backup}. Elle geri yükleme gerekir (docs/OPERATIONS.md §6).`;
        await this.log(msg);
        await this.report(p.id, 'failed', msg);
        return { outcome: 'failed', message: msg };
      }
      await this.log(`geri dönülüyor: ${prevKit} (yedek ${backup})`);
      const rb = await this.installer(prevKit, backup);
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

  private forget(id: string) {
    const a = this.readAttempts();
    if (a[id]) {
      delete a[id];
      this.writeAttempts(a);
    }
  }

  /**
   * Eski indirmeleri ve açılmış kitleri temizler: yeni ve bir önceki sürüm kalır. Docker yolunda açılan kit klasörü boşalmıştır
   * (dosyalar kurulum klasörüne taşındı); eski kurulumlardan kalan, hâlâ kullanımdaki bir kit klasörü (dockerDir) asla silinmez.
   */
  private prune(keep: string, previous: string) {
    const live = this.cfg.dockerDir ? join(this.cfg.dockerDir) : null;
    for (const sub of ['downloads', 'kits']) {
      const dir = join(this.cfg.workDir, sub);
      if (!existsSync(dir)) continue;
      for (const n of readdirSync(dir)) {
        if (n === keep || n === previous || n.includes(`-${keep}-`) || n.startsWith(`${previous}-`) || n.includes(`-${previous}-`)) continue;
        const full = join(dir, n);
        if (live && (live === full || live.startsWith(`${full}/`) || live.startsWith(`${full}\\`))) continue;
        rmSync(full, { recursive: true, force: true });
      }
    }
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
