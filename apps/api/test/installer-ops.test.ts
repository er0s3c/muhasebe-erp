import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions } from '@erp/license-core';

/**
 * Kurulum/güncelleme/yedek işletim düzeltmeleri (OPS-1…24): yanıt dosyası ayrıştırıcısı (bash + PowerShell), SemVer karşılaştırması,
 * güvenli JSON/tırnaklama, yedek temizliği, kaldırmanın kuru çalıştırması ve kalıcı silme onayı, kurulu sistemde ayar bayrakları,
 * sürüm düşürme koruması ve sürüm kiti lisans sunucusu denetimi. Yönetici komutları (root/postgres/systemd) taklit edilir:
 * hiçbir sınama /opt, /etc, systemd ya da gerçek PostgreSQL rollerine dokunmaz.
 */
const ROOT = resolve(__dirname, '../../..');
const PWSH = process.env.PWSH || 'pwsh';
const HAS_PWSH = spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }).status === 0;
const HAS_SHELLCHECK = spawnSync('shellcheck', ['--version'], { stdio: 'ignore' }).status === 0;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'erp-ops-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bash = (script: string, env: Record<string, string> = {}) => {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', code: r.status ?? -1 };
};
const pwsh = (script: string, env: Record<string, string> = {}) => {
  const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', code: r.status ?? -1 };
};

/** config.sh yüklü bash ortamı (yanıt anahtarları boş). */
const CFG_PRE = `die(){ echo "DIE: $*"; exit 1; }; warn(){ :; }; info(){ :; }; okm(){ :; }; OPT_YES=0; ANSWERS_FILE=""; source "${ROOT}/installer/lib/config.sh"; for v in $ANSWER_KEYS PATH_CHOICE; do printf -v "$v" ''; done\n`;
const PS_PRE = `function Die($m){ Write-Output "DIE: $m"; exit 1 }; function Warn($m){}; function Info($m){}; $Yes=$false; $AnswersFile=''; . '${ROOT}/installer/lib/config.ps1'\n`;

/** install.sh'yi işlevleriyle kaynak alır (akış çalışmaz); yönetici komutları yazdırılır, çalıştırılmaz. */
function installSh(t: string, args: string, body: string, env: Record<string, string> = {}) {
  const script = `ERP_INSTALL_SOURCE_ONLY=1 . "${ROOT}/installer/install.sh" ${args}
trap - ERR; set +e
PREFIX="${t}/opt" ETC="${t}/etc" VARDIR="${t}/var" HAS_SYSTEMD=1 UPD_WORK="${t}/updw" NATIVE_BACKUP_DIR="${t}/bk" UPD_DIR="${t}/opt/updater"
as_root(){ echo "ROOT: $*"; }; as_postgres(){ echo "PG: $*"; }; can_root(){ return 0; }; pg_port(){ echo 5432; }; docker_ok(){ return 1; }
${body}`;
  return bash(script, env);
}

describe('yanıt dosyası: yorum, BOM, tırnak (OPS-1, OPS-17, OPS-18)', () => {
  const sample = () => {
    const f = join(dir, 'kurallar.answers');
    writeFileSync(
      f,
      '\ufeffMODE=prod\r\nINSTALL_PATH=native   # yerel\r\nSMTP_HOST=   # boş, yalnızca yorum\nSMTP_PASSWORD="a #b c "\nSMTP_USER=\'x"y\'\nMAIL_FROM_NAME=Firma # ERP\nLICENSE_SERVER_URL=#yorum\nBACKUP_DIR=/srv/a#b\n',
      { mode: 0o600 },
    );
    return f;
  };
  const expected = { MODE: 'prod', INSTALL_PATH: 'native', SMTP_HOST: '', SMTP_PASSWORD: 'a #b c ', SMTP_USER: 'x"y', MAIL_FROM_NAME: 'Firma', LICENSE_SERVER_URL: '', BACKUP_DIR: '/srv/a#b' };
  const exampleExpected = { MODE: 'prod', INSTALL_PATH: 'native', ACCESS: 'local', PORT: '3000', DEMO: 'no', SMTP_HOST: '', SMTP_PORT: '', LICENSE_SERVER_URL: '', MAIL_FROM_NAME: 'Muhasebe ERP', BACKUP_DIR: '', BACKUP_KEEP: '14', BACKUP_TIME: '02:30', TLS_MODE: '' };

  const bashRead = (file: string, keys: string[]) => {
    const r = bash(`${CFG_PRE}load_answers "${file}"; for k in ${keys.join(' ')}; do v="$k"; [[ $k == INSTALL_PATH ]] && v=PATH_CHOICE; printf '%s=[%s]\\n' "$k" "\${!v}"; done`);
    expect(r.out).not.toMatch(/DIE:/);
    return Object.fromEntries([...r.stdout.matchAll(/^([A-Z_]+)=\[(.*)\]$/gm)].map((m) => [m[1], m[2]]));
  };
  const psRead = (file: string, keys: string[]) => {
    const r = pwsh(`${PS_PRE}Import-Answers '${file}'; foreach ($k in @(${keys.map((k) => `'${k}'`).join(',')})) { "$k=[$($script:A[$k])]" }`);
    expect(r.out).not.toMatch(/DIE:/);
    return Object.fromEntries([...r.stdout.matchAll(/^([A-Z_]+)=\[(.*)\]\r?$/gm)].map((m) => [m[1], m[2]]));
  };

  it('bash: installer/answers.example olduğu gibi geçerli; "ANAHTAR=   # yorum" boş değerdir', () => {
    expect(bashRead(join(ROOT, 'installer/answers.example'), Object.keys(exampleExpected))).toEqual(exampleExpected);
  });
  it('bash: BOM, CRLF, tırnaklı değerde # ve boşluk korunur, # ile başlayan değer yorumdur', () => {
    expect(bashRead(sample(), Object.keys(expected))).toEqual(expected);
  });
  it.skipIf(!HAS_PWSH)('PowerShell: aynı dosyalardan aynı değerler (answers.example ve kurallar)', () => {
    expect(psRead(join(ROOT, 'installer/answers.example'), Object.keys(exampleExpected))).toEqual(exampleExpected);
    expect(psRead(sample(), Object.keys(expected))).toEqual(expected);
  });
  it('kurallar belgelenmiş (answers.example ve OPERATIONS §2)', () => {
    const ex = readFileSync(join(ROOT, 'installer/answers.example'), 'utf8');
    const ops = readFileSync(join(ROOT, 'docs/OPERATIONS.md'), 'utf8');
    for (const t of [ex, ops]) {
      expect(t).toMatch(/tırnak/);
      expect(t).toMatch(/BOM/);
    }
    expect(ops).toMatch(/SMTP_HOST= {3}# açıklama` \*\*boş\*\*/);
  });
});

describe('SemVer karşılaştırması: TypeScript, bash ve PowerShell aynı sonucu verir (OPS-10)', () => {
  const vs = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0-rc.9', '1.0.0-rc.10', '1.0.0-rc-1', '1.0.0-rc-2', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  const pairs = vs.flatMap((a) => vs.map((b) => [a, b] as const));
  const want = pairs.map(([a, b]) => compareVersions(a, b));

  it('TypeScript sıralaması SemVer önceliğine uyar', () => {
    for (let i = 0; i < 11; i++) expect(compareVersions(vs[i]!, vs[i + 1]!), `${vs[i]} < ${vs[i + 1]}`).toBe(-1);
  });
  it('bash ver_cmp', () => {
    const input = `${pairs.map(([a, b]) => `${a} ${b}`).join('\n')}\n`;
    const out = spawnSync('bash', ['-c', `${CFG_PRE}while read -r a b; do ver_cmp "$a" "$b"; done`], { input, encoding: 'utf8' }).stdout.trim().split('\n').map(Number);
    expect(out).toEqual(want);
  });
  it.skipIf(!HAS_PWSH)('PowerShell Compare-SemVer', () => {
    const list = pairs.map(([a, b]) => `@('${a}','${b}')`).join(',');
    const r = pwsh(`${PS_PRE}foreach ($p in @(${list})) { Compare-SemVer $p[0] $p[1] }`);
    expect(r.stdout.trim().split(/\r?\n/).map(Number)).toEqual(want);
  });
});

describe('üretilen dosyalarda güvenli JSON ve tırnaklama (OPS-6, OPS-22)', () => {
  it('updater.json Node ile üretilir: tırnak/ters bölü/boşluklu yollar JSON\'u bozmaz; HTTPS denetimi yazılır', () => {
    const t = mkdtempSync(join(dir, 'upd-'));
    const kit = join(t, 'kit "a\\b" x');
    mkdirSync(join(kit, 'app', 'runtime'), { recursive: true });
    mkdirSync(join(kit, 'app', 'dist'), { recursive: true });
    symlinkSync(process.execPath, join(kit, 'app', 'runtime', 'node'));
    writeFileSync(join(kit, 'app', 'dist', 'updater.js'), '');
    const body = `ROOT=${JSON.stringify(kit)}
as_root(){ case "$1" in tee) shift; [[ "$1" == "${t}"* ]] && cat > "$1" || cat > /dev/null ;; chown|chmod|systemctl) ;; *) "$@" ;; esac; }
ensure_env_secret(){ :; }; HAS_SYSTEMD=0; PORT=3001; ACCESS=domain; DOMAIN=erp.test; TLS_MODE=selfsigned; HTTPS_PORT=8443
install_updater docker "${t}/deploy/.env" >/dev/null 2>&1; cat "${t}/etc/updater.json"`;
    const r = installSh(t, '', body);
    const cfg = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(cfg).toMatchObject({ mode: 'docker', dockerDir: kit, workDir: `${t}/updw`, installArgs: ['--port=3001', '--access=domain', '--domain=erp.test'], httpsCheck: { port: 8443, host: 'erp.test' } });
  });

  it('systemd ve cron satırları boşluk, %, $, tırnak içeren yolları kaçışlar', () => {
    const r = bash(`${CFG_PRE}sd_quote '/a b/%x$y"z'; echo; sd_path '/a b/%x'; echo; cron_quote '/a b/%x'`);
    expect(r.stdout.split('\n')).toEqual(['"/a b/%%x$$y\\"z"', '/a b/%%x', '/a\\ b/\\%x']);
  });

  it.skipIf(!HAS_PWSH)("PowerShell yedek betiği: tek tırnaklı yol ' içerse de doğru ayrıştırılır; parola komut satırında değil", () => {
    const t = mkdtempSync(join(dir, 'psbk-'));
    const backupDir = "C:\\Yedek'ler ve $x";
    const r = pwsh(`${PS_PRE}
function Ok($m){}; function New-ScheduledTaskAction { 1 }; function New-ScheduledTaskTrigger { 1 }; function New-ScheduledTaskPrincipal { 1 }; function New-ScheduledTaskSettingsSet { 1 }; function Register-ScheduledTask { }
$DataDir = '${t}/data'; $ProgDir = '${t}/prog'; $Root = '${t}/kit'; $DbName = 'erp'
$script:PgInfo = [pscustomobject]@{ Bin = 'C:\\PostgreSQL\\16\\bin' }
$script:A['BACKUP_DIR'] = $env:BDIR; $script:A['BACKUP_KEEP'] = '0'; $script:A['BACKUP_TIME'] = '02:30'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${ROOT}/installer/install.ps1', [ref]$null, [ref]$null)
foreach ($n in @('Get-BackupScriptPath', 'Write-BackupTask')) { . ([scriptblock]::Create($ast.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true).Extent.Text)) }
foreach ($p in @('native', 'docker')) {
  $script:Path = $p; Write-BackupTask
  $f = Get-BackupScriptPath; $e = $null; $tk = $null
  $a2 = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tk, [ref]$e)
  $dirVal = $a2.Find({ param($x) $x -is [System.Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -eq '$dir' }, $true).Right.Expression.Value
  $keepVal = $a2.Find({ param($x) $x -is [System.Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -eq '$keep' }, $true).Right.Extent.Text
  "$p errors=$($e.Count) dir=[$dirVal] keep=$keepVal pw=$((Get-Content -Raw $f) -match 'PGPASSWORD') argpw=$((Get-Content -Raw $f) -match '-d \\$url')"
}`, { BDIR: backupDir });
    expect(r.out).toContain(`native errors=0 dir=[${backupDir}] keep=1 pw=True argpw=False`);
    expect(r.out).toContain(`docker errors=0 dir=[${backupDir}] keep=1 pw=False argpw=False`);
  });
});

describe('yedek temizliği yalnızca kendi dosyalarına dokunur, en az 1 yedek kalır (OPS-7, OPS-8)', () => {
  /** Sahte pg_dump/pg_restore: argümanları ve parolanın ortamda olup olmadığını kaydeder. */
  const fakePg = (t: string) => {
    const bin = join(t, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'pg_dump'), `#!/usr/bin/env bash\necho "args=$* pw=\${PGPASSWORD:-yok} user=\${PGUSER:-} db=\${PGDATABASE:-}" >> "${t}/calls"\nout=-\nwhile (( $# )); do [[ $1 == -f ]] && { out=$2; shift; }; shift; done\nif [[ $out == - ]]; then printf PGDMP; else printf PGDMP > "$out"; fi\n`);
    writeFileSync(join(bin, 'pg_restore'), '#!/usr/bin/env bash\ncat > /dev/null\n');
    chmodSync(join(bin, 'pg_dump'), 0o755);
    chmodSync(join(bin, 'pg_restore'), 0o755);
    return bin;
  };
  const seed = (d: string, names: string[]) => {
    mkdirSync(d, { recursive: true });
    for (const n of names) writeFileSync(join(d, n), 'x');
  };

  it('scripts/backup.sh: --keep-count 0 reddedilir; yabancı erp-*.dump dosyaları silinmez; parola argümanda değil', () => {
    const t = mkdtempSync(join(dir, 'bk-'));
    const bin = fakePg(t);
    const d = join(t, 'yedek klasörü');
    seed(d, ['erp-erp-20200101T000000Z.dump', 'erp-erp-20200102T000000Z.dump', 'erp-erp-20200103T000000Z.dump', 'erp-elle-alinan.dump', 'erp-baska-20200101T000000Z.dump', 'not.txt']);
    const env = { PATH: `${bin}:${process.env.PATH}`, MIGRATION_DATABASE_URL: 'postgres://erp:gi%40zli@127.0.0.1:5432/erp' };
    const zero = spawnSync('bash', [join(ROOT, 'scripts/backup.sh'), '--dir', d, '--keep-count', '0'], { encoding: 'utf8', env: { ...process.env, ...env } });
    expect(zero.status).toBe(2);
    expect(zero.stderr).toMatch(/en az 1/);
    const r = spawnSync('bash', [join(ROOT, 'scripts/backup.sh'), '--dir', d, '--keep-count', '2'], { encoding: 'utf8', env: { ...process.env, ...env } });
    expect(r.status, r.stderr).toBe(0);
    const left = readdirSync(d).sort();
    expect(left.filter((n) => /^erp-erp-\d{8}T\d{6}Z\.dump$/.test(n))).toHaveLength(2);
    expect(left).toEqual(expect.arrayContaining(['erp-erp-20200103T000000Z.dump', 'erp-elle-alinan.dump', 'erp-baska-20200101T000000Z.dump', 'not.txt']));
    const calls = readFileSync(join(t, 'calls'), 'utf8');
    expect(calls).toContain('pw=gi@zli user=erp db=erp');
    for (const m of calls.matchAll(/args=(.*?) pw=/g)) expect(m[1]).not.toMatch(/gi%40zli|gi@zli/);
  });

  it('yerel yedek betiği (erp-backup): boşluklu klasör, yalnızca erp-YYYYMMDD-HHMMSS.dump temizlenir, parola argümanda değil', () => {
    const t = mkdtempSync(join(dir, 'nbk-'));
    const bin = fakePg(t);
    const d = join(t, 'my backups %x');
    seed(d, ['erp-20200101-000000.dump', 'erp-20200102-000000.dump', 'erp-baska.dump', 'erp-erp-20200101T000000Z.dump']);
    mkdirSync(join(t, 'etc'), { recursive: true });
    mkdirSync(join(t, 'opt', 'bin'), { recursive: true });
    writeFileSync(join(t, 'etc', 'migrate.env'), 'MIGRATION_DATABASE_URL=postgres://erp:p%2540ss%20w@127.0.0.1:5432/erp\n');
    const body = `as_root(){ case "$1" in tee) shift; cat > "$1" ;; chown|systemctl) ;; *) "$@" ;; esac; }; HAS_SYSTEMD=0; can_root(){ return 1; }; PG_MAJOR=x
BACKUP_DIR=${JSON.stringify(d)} BACKUP_KEEP=0 write_backup_tool >/dev/null 2>&1
sed -i "s#/usr/lib/postgresql/x/bin/pg_dump#${bin}/pg_dump#" "${t}/opt/bin/erp-backup"
bash "${t}/opt/bin/erp-backup"`;
    const r = installSh(t, '', body);
    expect(r.out).toMatch(/Yedek: .*my backups %x\/erp-\d{8}-\d{6}\.dump/);
    const left = readdirSync(d).sort();
    // BACKUP_KEEP=0 → en az 1: yalnızca yeni yedek kalır; başka adlandırılmış dosyalar korunur
    expect(left.filter((n) => /^erp-\d{8}-\d{6}\.dump$/.test(n))).toHaveLength(1);
    expect(left).toEqual(expect.arrayContaining(['erp-baska.dump', 'erp-erp-20200101T000000Z.dump']));
    const calls = readFileSync(join(t, 'calls'), 'utf8');
    expect(calls).toContain('pw=p%40ss w user=erp db=erp');
    for (const m of calls.matchAll(/args=(.*?) pw=/g)) expect(m[1]).not.toMatch(/p%2540ss|p%40ss/);
  });
});

describe('kaldırma: kuru çalıştırma ve kalıcı silme onayı (OPS-2, OPS-16, DOC-8)', () => {
  const setup = () => {
    const t = mkdtempSync(join(dir, 'un-'));
    mkdirSync(join(t, 'etc'), { recursive: true });
    mkdirSync(join(t, 'opt'), { recursive: true });
    writeFileSync(join(t, 'etc', 'erp.env'), 'PORT=3000\n');
    writeFileSync(join(t, 'etc', 'migrate.env'), 'MIGRATION_DATABASE_URL=postgres://erp:x@127.0.0.1:5432/erp_musteri\n');
    writeFileSync(join(t, 'etc', 'wizard.conf'), 'ACCESS=local\nPORT=3000\nDB_NAME=erp_musteri\nDB_CREATED=yes\nBACKUP_DIR=/srv/ozel-yedek\n');
    symlinkSync('versions/1.0.0', join(t, 'opt', 'current'));
    return t;
  };
  const run = (t: string, args: string, env: Record<string, string> = {}) => installSh(t, args, 'init_input; detect >/dev/null 2>&1; uninstall_main', env);

  it('--uninstall --purge --dry-run hiçbir şeyi çalıştırmaz, silinecekleri listeler', () => {
    const t = setup();
    const r = run(t, '--uninstall --purge --dry-run --yes');
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/^(ROOT|PG):/m);
    expect(r.out).toMatch(/\(kuru\) veritabanı silinir: erp_musteri/);
    expect(r.out).toMatch(/Özel yedek klasörü \(\/srv\/ozel-yedek\) KORUNUR/);
  });

  it('--purge --yes onay vermez: terminal yoksa durur; yanlış yanıtta durur; SIL yazılınca yalnızca kayıtlı veritabanı silinir', () => {
    const t = setup();
    const none = run(t, '--uninstall --purge --yes');
    expect(none.out).toMatch(/onayı alınamadı/);
    expect(none.out).not.toMatch(/^(ROOT|PG):/m);
    writeFileSync(join(t, 'in'), 'evet\n');
    const wrong = run(t, '--uninstall --purge --yes', { ERP_WIZARD_INPUT: join(t, 'in') });
    expect(wrong.out).toMatch(/Onay verilmedi/);
    expect(wrong.out).not.toMatch(/^(ROOT|PG):/m);
    writeFileSync(join(t, 'in'), 'SIL\n');
    const ok = run(t, '--uninstall --purge --yes', { ERP_WIZARD_INPUT: join(t, 'in') });
    expect(ok.out).toMatch(/^PG: psql .*drop database if exists "erp_musteri" with \(force\)/m);
    expect(ok.out).not.toMatch(/drop database if exists "?erp"? /);
    const flag = run(t, '--uninstall --purge --i-understand-purge');
    expect(flag.out).toMatch(/^PG: psql .*drop database/m);
  });

  it('kurulumdan önce var olan veritabanı --purge ile silinmez; --purge olmadan veri korunur', () => {
    const t = setup();
    writeFileSync(join(t, 'etc', 'wizard.conf'), 'DB_NAME=erp\nDB_CREATED=no\nROLES_CREATED=no\n');
    const r = run(t, '--uninstall --purge --i-understand-purge');
    expect(r.out).not.toMatch(/drop database/);
    expect(r.out).not.toMatch(/drop role/);
    expect(r.out).toMatch(/kurulumdan önce vardı/);
    const keep = run(t, '--uninstall --yes');
    expect(keep.out).not.toMatch(/drop database|rm -rf .*\/etc /);
    expect(keep.out).toMatch(/Korunanlar: veritabanı/);
  });

  it.skipIf(!HAS_PWSH)('PowerShell: -Uninstall -Purge -DryRun hiçbir şey silmez; onaysız -Purge durur', () => {
    const t = mkdtempSync(join(dir, 'psun-'));
    mkdirSync(join(t, 'data'), { recursive: true });
    writeFileSync(join(t, 'data', 'erp.env'), 'PORT=3000\n');
    writeFileSync(join(t, 'data', 'wizard.conf'), 'DB_CREATED=yes\nBACKUP_DIR=D:\\Ozel\n');
    const script = (dry: boolean) => `function Say($m){ Write-Output $m }; function Info($m){ Write-Output $m }; function Warn($m){ Write-Output "! $m" }; function Ok($m){ Write-Output "OK $m" }; function Stage($m){ Write-Output "== $m" }
function Die($m){ Write-Output "DIE: $m"; exit 1 }; function Get-Service { $null }; function Get-WinswExe { 'winsw' }; function Get-PgInstall { $null }; function Remove-Junction($p) { }
function Unregister-ScheduledTask { Write-Output 'UNREGISTER' }; function Get-NetFirewallRule { }
$DataDir = '${t}/data'; $ProgDir = '${t}/prog'; $Root = '${t}/kit'; $DbName = 'erp'; $SvcId = 'MuhasebeERP'; $Purge = $true; $DryRun = $${dry}; $IUnderstandPurge = $false; $Path = ''
$Yes = $true; $AnswersFile = ''; . '${ROOT}/installer/lib/config.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${ROOT}/installer/install.ps1', [ref]$null, [ref]$null)
foreach ($n in @('Test-SamePath', 'Confirm-Purge', 'Invoke-Step', 'Invoke-Uninstall', 'Uninstall-Native', 'Uninstall-Docker')) { . ([scriptblock]::Create($ast.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true).Extent.Text)) }
$wast = [System.Management.Automation.Language.Parser]::ParseFile('${ROOT}/installer/lib/wizard.ps1', [ref]$null, [ref]$null)
foreach ($n in @('Import-ExistingSettings', 'Read-Lines')) { . ([scriptblock]::Create($wast.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true).Extent.Text)) }
function Get-EnvValue($f, $k) { '' }
$script:StepErrors = 0; $script:Cur = @{}
Invoke-Uninstall
"VAR=$(Test-Path '${t}/data')"`;
    const dry = pwsh(script(true));
    expect(dry.out).toMatch(/\(kuru\) zamanlanmış görevler silinir/);
    expect(dry.out).not.toMatch(/UNREGISTER/);
    expect(dry.out).toMatch(/Özel yedek klasörü \(D:\\Ozel\) KORUNUR/);
    expect(dry.out).toContain('VAR=True');
    const noConfirm = pwsh(script(false));
    expect(noConfirm.out).toMatch(/DIE: .*onayı alınamadı/);
    expect(noConfirm.out).not.toMatch(/UNREGISTER/);
    expect(existsSync(join(t, 'data'))).toBe(true);
  });
});

describe('kurulu sistemde yanıt dosyası/bayrak ve sürüm düşürme (OPS-15, OPS-9)', () => {
  const conf = (t: string) => {
    mkdirSync(join(t, 'etc'), { recursive: true });
    writeFileSync(join(t, 'etc', 'erp.env'), 'PORT=3000\nAPP_VERSION=1.2.0\n');
    writeFileSync(join(t, 'etc', 'wizard.conf'), 'ACCESS=lan\nPORT=3000\nTLS_MODE=none\nDEMO=no\n');
  };
  const body = 'MODE=prod; EXISTING=1; EXISTING_PATH=native; load_existing_settings native; refuse_settings_on_existing && echo GECTI';

  it('farklı bayrak ya da yanıt dosyası sessizce yok sayılmaz: sihirbaz durur (kuru çalıştırmada da)', () => {
    const t = mkdtempSync(join(dir, 'ex-'));
    conf(t);
    expect(installSh(t, '--port=4000 --dry-run', body).out).toMatch(/Kurulu sistemin ayarlarından farklı bayrak verildi: PORT: kurulu=3000, verilen=4000/);
    expect(installSh(t, '--port=3000 --access=lan', body).out).toContain('GECTI');
    const ans = join(t, 'a.answers');
    writeFileSync(ans, 'PORT=3000\n', { mode: 0o600 });
    expect(installSh(t, `--answers=${ans}`, body).out).toMatch(/yanıt dosyası yalnızca YENİ kurulumda okunur.*--reconfigure/);
    // Güncelleyicinin çalıştırması durmaz (bayraklar kurulumdaki değerlerdir; uyuşmazlık uyarılır)
    expect(installSh(t, '--port=4000', body, { ERP_UPDATER_RUN: '1' }).out).toContain('GECTI');
  });

  it('kurulu sürümden eski kit kurulmaz; --restore-db (geri dönüş) ve --allow-downgrade istisnadır', () => {
    const t = mkdtempSync(join(dir, 'dg-'));
    conf(t);
    const dg = 'MODE=prod; EXISTING=1; KIT=1; KIT_VERSION=1.1.0; load_existing_settings native; check_downgrade && echo GECTI';
    expect(installSh(t, '', dg).out).toMatch(/Kurulu sürüm 1\.2\.0, bu kit 1\.1\.0 \(daha eski\)/);
    expect(installSh(t, '--restore-db=/x.dump', dg).out).toContain('GECTI');
    expect(installSh(t, '--allow-downgrade', dg).out).toContain('GECTI');
    expect(installSh(t, '', dg.replace('1.1.0', '1.2.0-rc.1')).out).toMatch(/daha eski/);
    expect(installSh(t, '', dg.replace('1.1.0', '1.3.0')).out).toContain('GECTI');
  });
});

describe('sürüm kiti: lisans sunucusu adresi zorunlu, --out mutlak yol (OPS-11, OPS-20)', () => {
  const tsx = join(ROOT, 'node_modules/.bin/tsx');
  const release = (args: string[], env: Record<string, string | undefined>, cwd = ROOT) => {
    const e = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
    return spawnSync(tsx, [join(ROOT, 'scripts/release.ts'), ...args], { cwd, encoding: 'utf8', env: e });
  };

  it('LICENSE_SERVER_URL yoksa ya da https değilse kit üretilmez', () => {
    const out = join(dir, 'rel1');
    const none = release(['--version=1.0.0', '--skip-build', `--out=${out}`], { LICENSE_SERVER_URL: undefined });
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/LICENSE_SERVER_URL verilmedi.*--allow-no-license-server/);
    expect(existsSync(out)).toBe(false);
    const http = release(['--version=1.0.0', '--skip-build', `--out=${out}`], { LICENSE_SERVER_URL: 'http://lisans.test' });
    expect(http.status).toBe(1);
    expect(http.stderr).toMatch(/https/);
  });

  it('--allow-no-license-server ile uyarır; --out mutlak yol olduğu gibi kullanılır', () => {
    const cwd = mkdtempSync(join(dir, 'relcwd-'));
    const out = join(dir, 'rel abs');
    const r = release(['--version=1.0.0', '--skip-build', '--allow-no-license-server', `--out=${out}`], { LICENSE_SERVER_URL: undefined }, cwd);
    // Boş çalışma klasöründe derleme yok: kit aşamasından önce durur, ama çıktı klasörü mutlak yolda açılmıştır
    expect(r.stderr).toMatch(/önce derleyin/);
    expect(r.stderr + r.stdout).toMatch(/lisans sunucusu adresi YOK/);
    expect(existsSync(join(out, '1.0.0'))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('kit.json lisans sunucusu adresini kaydeder; sihirbaz kitte adres olup olmadığını söyler', () => {
    expect(readFileSync(join(ROOT, 'scripts/release.ts'), 'utf8')).toMatch(/licenseServerUrl: licenseServerUrl \|\| null/);
    const r = bash(`ROOT=/x; KIT=1; KIT_LICENSE_URL=""; LICENSE_SERVER_URL=""; LICENSE_CODE=""; MODE=prod; ACCESS=local; PORT=3000; DEMO=no; MAIL_ENABLED=no; REGISTRATION=yes; BACKUP_TIME=02:30; BACKUP_DIR=/b; BACKUP_KEEP=14
say(){ echo "$*"; }; source "${ROOT}/installer/lib/wizard.sh"; print_settings`);
    expect(r.out).toMatch(/Lisans sunucusu: +YOK \(kitte de yok/);
  });
});

describe('betikler: sözdizimi ve statik denetim', () => {
  const files = ['installer/install.sh', 'installer/lib/config.sh', 'installer/lib/wizard.sh', 'scripts/backup.sh', 'scripts/restore.sh'];
  it('bash -n', () => {
    for (const f of files) expect(spawnSync('bash', ['-n', join(ROOT, f)]).status, f).toBe(0);
  });
  it.skipIf(!HAS_SHELLCHECK)('shellcheck (uyarı düzeyi) temiz', () => {
    const r = spawnSync('shellcheck', ['-x', '-S', 'warning', ...files.map((f) => join(ROOT, f))], { encoding: 'utf8', cwd: ROOT });
    expect(r.stdout, r.stdout).toBe('');
  });
  it('compose dosyalarında günlük döndürme (json-file, boyut sınırı) var (OPS-23)', () => {
    for (const f of ['deploy/docker-compose.prod.yml', 'deploy/docker-compose.demo.yml', 'deploy/license/docker-compose.yml']) {
      const y = readFileSync(join(ROOT, f), 'utf8');
      expect(y, f).toMatch(/x-logging: &default-logging\n {2}driver: json-file\n {2}options:\n {4}max-size: '10m'\n {4}max-file: '5'/);
      const services = y.split('\nvolumes:')[0]!.split('\nservices:\n')[1]!;
      const names = [...services.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)].map((m) => m[1]);
      const logged = (services.match(/logging: \*default-logging/g) ?? []).length;
      expect(logged, f).toBe(names.length);
    }
  });
  it('ayar yedekleri (.bak-*) birikmez: her dosyanın en yeni 5 yedeği kalır (OPS-24)', () => {
    const names = Array.from({ length: 8 }, (_, i) => `/e/erp.env.bak-2026010${i + 1}-000000`).concat(['/e/erp.env.bak-elle', '/e/wizard.conf.bak-20260101-000000']);
    const r = spawnSync('bash', ['-c', `${CFG_PRE}prune_bak_list /e/erp.env 5`], { input: names.join('\n'), encoding: 'utf8' });
    expect(r.stdout.trim().split('\n')).toEqual(['/e/erp.env.bak-20260103-000000', '/e/erp.env.bak-20260102-000000', '/e/erp.env.bak-20260101-000000']);
  });
});

