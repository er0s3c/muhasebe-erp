import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSmtpUrl, checkCert, explainSmtpError, scrub, smtpTest } from '../../../installer/tools/erp-tool.mjs';

/**
 * Kurulum sihirbazı: saf parçaların (yanıt dosyası, doğrulayıcılar, SMTP adresi, ortam düzenleyici, sertifika denetimi) sınaması.
 * install.sh kitaplığı bash ile, araçlar doğrudan içe aktarılarak, Windows kitaplığı (pwsh varsa) çapraz karşılaştırmayla sınanır.
 */
const ROOT = resolve(__dirname, '../../..');
const CONFIG_SH = join(ROOT, 'installer/lib/config.sh');
const hasBin = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0 || spawnSync(cmd, ['version'], { stdio: 'ignore' }).status === 0;
const HAS_OPENSSL = hasBin('openssl');
const PWSH = process.env.PWSH || (process.platform === 'win32' ? 'powershell' : 'pwsh');
const HAS_PWSH = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '1'], { stdio: 'ignore' }).status === 0;
const HAS_BASH = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' }).status === 0;

/** config.sh'yi kaynak alıp betiği çalıştırır (die/warn kısaltmalarıyla). */
function sh(script: string, env: Record<string, string> = {}): { out: string; code: number } {
  const pre = `die(){ echo "DIE: $*"; exit 1; }; warn(){ echo "WARN: $*"; }; info(){ :; }; okm(){ :; }; OPT_YES=0; ANSWERS_FILE=""; for v in MODE PATH_CHOICE ACCESS DOMAIN PORT DEMO REGISTRATION LICENSE_SERVER_URL LICENSE_CODE MAIL_ENABLED SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_PASSWORD MAIL_FROM_ADDRESS MAIL_FROM_NAME MAIL_TEST_TO APP_BASE_URL TLS_MODE ACME_EMAIL CERT_FILE KEY_FILE HTTP_PORT HTTPS_PORT BACKUP_DIR BACKUP_KEEP BACKUP_TIME; do printf -v "$v" ''; done; source "${CONFIG_SH}"\n`;
  const r = spawnSync('bash', ['-c', pre + script], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status ?? -1 };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'erp-wizard-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('SMTP adresi', () => {
  const cases = [
    { host: 'smtp.x.com', port: '587', security: 'starttls', user: 'me@x.com', pass: 'p@s$w/ord!' },
    { host: 'h', port: '465', security: 'ssl', user: '', pass: '' },
    { host: '10.0.0.1', port: '25', security: 'none', user: 'u', pass: "a b'c(d)*e%f#g" },
  ];

  it('güvenlik türüne göre şema ve seçenek üretir; özel karakterler kodlanır', () => {
    expect(buildSmtpUrl(cases[0]!)).toBe('smtp://me%40x.com:p%40s%24w%2Ford%21@smtp.x.com:587?requireTLS=true');
    expect(buildSmtpUrl(cases[1]!)).toBe('smtps://h:465');
    expect(buildSmtpUrl(cases[2]!)).toBe("smtp://u:a%20b%27c%28d%29%2Ae%25f%23g@10.0.0.1:25?ignoreTLS=true");
    expect(() => buildSmtpUrl({ host: 'h', port: '1', security: 'x' })).toThrow();
  });

  it.skipIf(!HAS_BASH)('bash işlevi Node yardımcısıyla aynı adresi üretir', () => {
    for (const c of cases) {
      const { out } = sh(`smtp_url "$H" "$P" "$S" "$U" "$W"`, { H: c.host, P: c.port, S: c.security, U: c.user, W: c.pass });
      expect(out, JSON.stringify(c)).toBe(buildSmtpUrl(c));
    }
  });

  it.skipIf(!HAS_PWSH)('PowerShell işlevi aynı adresi üretir', () => {
    const lib = join(ROOT, 'installer/lib/config.ps1');
    for (const c of cases) {
      const script = `function Die($m){throw $m}; function Warn($m){}; $Yes=$false; $AnswersFile=''; . '${lib}'; New-SmtpUrl $env:H $env:P $env:S $env:U $env:W`;
      const r = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', env: { ...process.env, H: c.host, P: c.port, S: c.security, U: c.user, W: c.pass } });
      expect(r.stdout.trim(), JSON.stringify(c)).toBe(buildSmtpUrl(c));
    }
  });

  it('hata iletisinden parola ayıklanır ve düz Türkçe açıklama verilir', () => {
    expect(scrub('auth failed for smtp://me:gizli@h:25 pw=gizli', ['gizli'])).not.toContain('gizli');
    expect(explainSmtpError(Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH' }))).toMatch(/parola/i);
    expect(explainSmtpError(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toMatch(/reddedildi/);
    expect(explainSmtpError(new Error('getaddrinfo ENOTFOUND x'))).toMatch(/DNS/);
  });

  it('sahte SMTP sunucusuna test e-postası gönderir; kapalı porta hata verir', async () => {
    const got: string[] = [];
    const server = net.createServer((s) => {
      let data = false;
      s.write('220 fake\r\n');
      s.on('data', (b) => {
        for (const l of b.toString().split('\r\n')) {
          if (data) { if (l === '.') { data = false; s.write('250 queued\r\n'); } else got.push(l); continue; }
          const u = l.toUpperCase();
          if (u.startsWith('EHLO')) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
          else if (u.startsWith('AUTH PLAIN')) s.write('235 ok\r\n');
          else if (u.startsWith('DATA')) { data = true; s.write('354 go\r\n'); }
          else if (u.startsWith('QUIT')) { s.write('221 bye\r\n'); s.end(); }
          else if (l) s.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const url = buildSmtpUrl({ host: '127.0.0.1', port: String(port), security: 'none', user: 'kul', pass: 'sifre' });
      await smtpTest({ url, from: 'Firma ERP <erp@firma.com>', to: 'test@firma.com', modulesDir: ROOT, timeoutMs: 5000 });
      expect(got.join('\n')).toMatch(/Subject: .*(Muhasebe ERP|=\?UTF-8)/i);
    } finally {
      server.close();
    }
    await expect(smtpTest({ url: 'smtp://127.0.0.1:1?ignoreTLS=true', from: 'a@b.co', to: 'c@d.co', modulesDir: ROOT, timeoutMs: 2000 })).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe.skipIf(!HAS_BASH)('yanıt dosyası (bash)', () => {
  const run = (answers: string, pre = '') => {
    const f = join(dir, 'answers.txt');
    writeFileSync(f, answers, { mode: 0o600 });
    return sh(`${pre}\nload_answers "${f}"\nprintf '[%s][%s][%s][%s][%s]' "$MODE" "$PATH_CHOICE" "$DEMO" "$SMTP_PASSWORD" "$PORT"`);
  };

  it('KEY=VALUE, yorum, tırnak, satır sonu yorumu ve = içeren değerleri okur', () => {
    const r = run('# yorum\r\nMODE = prod   # satır sonu yorumu\nINSTALL_PATH=native\nDEMO="no"\nSMTP_PASSWORD=gi=zli\nPORT=3001\n');
    expect(r.out).toContain('[prod][native][no][gi=zli][3001]');
    expect(r.out).toMatch(/WARN: Yanıt dosyasında parola/);
  });

  it('komut satırı değeri dosyadan önceliklidir; boş değer varsayılan bırakır', () => {
    expect(run('PORT=3001\nDEMO=\n', 'PORT=4000').out).toContain('[][][][][4000]');
  });

  it('bilinmeyen anahtar ve bozuk satır reddedilir; dosyadaki kod çalıştırılmaz', () => {
    expect(run('FOO=1\n').out).toMatch(/DIE: .*bilinmeyen anahtar 'FOO'/);
    expect(run('bozuk satır\n').out).toMatch(/DIE: .*biçimi bekleniyor/);
    const marker = join(dir, 'pwned');
    run(`MODE=$(touch ${marker})\n`);
    expect(() => readFileSync(marker)).toThrow();
  });

  it('örnek dosya geçerli ve her anahtar belgelenmiş; Windows kitaplığıyla anahtar kümesi aynı', () => {
    const example = join(ROOT, 'installer/answers.example');
    if (HAS_BASH) expect(sh(`load_answers "${example}"; echo ok`).out).toContain('ok');
    const keysSh = /ANSWER_KEYS="([^"]+)"/.exec(readFileSync(CONFIG_SH, 'utf8').replace(/\\\n/g, ''))![1]!.split(/\s+/).sort();
    const ps = readFileSync(join(ROOT, 'installer/lib/config.ps1'), 'utf8');
    const keysPs = [...(/\$script:AnswerKeys = @\(([\s\S]*?)\)\r?\n/.exec(ps)![1]!.matchAll(/'([A-Z_]+)'/g))].map((m) => m[1]!).sort();
    expect(keysPs).toEqual(keysSh);
    const exampleText = readFileSync(example, 'utf8');
    const ops = readFileSync(join(ROOT, 'docs/OPERATIONS.md'), 'utf8');
    for (const k of keysSh) {
      expect(exampleText, `answers.example: ${k}`).toMatch(new RegExp(`^${k}=`, 'm'));
      expect(ops.includes(`\`${k}\``), `OPERATIONS.md: ${k}`).toBe(true);
    }
  });
});

describe.skipIf(!HAS_BASH)('doğrulayıcılar ve ortam düzenleyici (bash)', () => {
  const ok = (fn: string, v: string) => sh(`${fn} "$V" >/dev/null && echo yes || echo no`, { V: v }).out.trim() === 'yes';

  it('port, e-posta, alan adı, saat, lisans', () => {
    expect([ok('v_port', '80'), ok('v_port', '0'), ok('v_port', '70000'), ok('v_port', 'abc')]).toEqual([true, false, false, false]);
    expect([ok('v_email', 'ad@firma.com'), ok('v_email', 'ad@firma'), ok('v_email', 'a b@c.com')]).toEqual([true, false, false]);
    expect([ok('v_fqdn', 'erp.firma.com'), ok('v_fqdn', 'localhost'), ok('v_fqdn', '-a.com')]).toEqual([true, false, false]);
    expect([ok('v_host', '192.168.1.2'), ok('v_host', 'erp-pc'), ok('v_host', '300.1.1.1x')]).toEqual([true, true, false]);
    expect([ok('v_time', '02:30'), ok('v_time', '24:00'), ok('v_time', '2:30')]).toEqual([true, false, false]);
    expect([ok('v_license_code', 'ABCDE-12345-ABCDE-12345-ABCDE'), ok('v_license_code', 'ABC'), ok('v_license_url', 'https://l.firma.com'), ok('v_license_url', 'http://l.firma.com')]).toEqual([true, false, true, false]);
    expect([ok('v_display_name', 'Firma ERP'), ok('v_display_name', 'a"b'), ok('v_display_name', 'a$b')]).toEqual([true, false, false]);
  });

  it('env_apply anahtarı değiştirir, ekler, siler ve tekrarları tekilleştirir', () => {
    const r = sh(`printf 'A=1\\nSMTP_URL=old\\nB=2\\nSMTP_URL=dup\\n# yorum\\n' | env_apply SMTP_URL=yeni C=3 -B`);
    expect(r.out).toBe('A=1\nSMTP_URL=yeni\n# yorum\nC=3\n');
  });

  it('Caddy dosyası kipine göre üretilir', () => {
    const auto = sh('render_caddyfile auto me@x.com 443 no').out;
    expect(auto).toContain('email me@x.com');
    expect(auto).not.toContain('tls ');
    const byo = sh('render_caddyfile byo "" 8443 yes').out;
    expect(byo).toContain('tls /etc/caddy/certs/fullchain.pem /etc/caddy/certs/privkey.pem');
    expect(byo).toContain('auto_https disable_redirects');
    expect(sh('render_caddyfile selfsigned "" 443 no').out).toContain('tls internal');
  });
});

describe.skipIf(!HAS_OPENSSL)('sertifika denetimi (openssl ve Node aynı karara varır)', () => {
  const ossl = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  let caCert = '', leafCert = '', leafKey = '', otherKey = '';
  beforeAll(() => {
    ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Test CA', '-addext', 'basicConstraints=critical,CA:TRUE');
    ossl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=erp.test');
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:erp.test,DNS:*.lan.test\nbasicConstraints=CA:FALSE\n');
    ossl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '30', '-out', 'leaf.pem', '-extfile', 'ext.cnf');
    ossl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other.key', '-out', 'other.csr', '-subj', '/CN=other');
    caCert = readFileSync(join(dir, 'ca.pem'), 'utf8');
    leafCert = readFileSync(join(dir, 'leaf.pem'), 'utf8');
    leafKey = readFileSync(join(dir, 'leaf.key'), 'utf8');
    otherKey = readFileSync(join(dir, 'other.key'), 'utf8');
    writeFileSync(join(dir, 'full.pem'), leafCert + caCert);
    writeFileSync(join(dir, 'reversed.pem'), caCert + leafCert);
    writeFileSync(join(dir, 'leafonly.pem'), leafCert);
  });

  const bashCheck = (cert: string, key: string, domain = '') => {
    const r = sh(`cert_check_openssl "${join(dir, cert)}" "${join(dir, key)}" "$D"; echo "rc=$?"`, { D: domain });
    return { ok: r.out.includes('rc=0'), text: r.out };
  };
  const nodeCheck = (certPem: string, keyPem: string, domain = '', now?: Date) => checkCert({ certPem, keyPem, domain, now });

  it('geçerli tam zincir: ikisi de kabul eder; joker alan adı kapsanır', () => {
    const full = readFileSync(join(dir, 'full.pem'), 'utf8');
    for (const d of ['erp.test', 'pc.lan.test']) {
      expect(bashCheck('full.pem', 'leaf.key', d).ok, `bash ${d}`).toBe(true);
      expect(nodeCheck(full, leafKey, d).ok, `node ${d}`).toBe(true);
    }
  });

  it('yanlış anahtar, yanlış alan adı, ters zincir sırası reddedilir', () => {
    writeFileSync(join(dir, 'other.key'), otherKey);
    const full = readFileSync(join(dir, 'full.pem'), 'utf8');
    const rev = readFileSync(join(dir, 'reversed.pem'), 'utf8');
    expect(bashCheck('full.pem', 'other.key', 'erp.test')).toMatchObject({ ok: false });
    expect(bashCheck('full.pem', 'other.key', 'erp.test').text).toMatch(/HATA .*anahtar/i);
    expect(nodeCheck(full, otherKey, 'erp.test').errors.join()).toMatch(/anahtar/i);
    expect(bashCheck('full.pem', 'leaf.key', 'baska.test').ok).toBe(false);
    expect(nodeCheck(full, leafKey, 'baska.test').ok).toBe(false);
    expect(bashCheck('reversed.pem', 'leaf.key', 'erp.test').ok).toBe(false);
    expect(nodeCheck(rev, leafKey, 'erp.test').ok).toBe(false);
  });

  it('yalnızca yaprak sertifika uyarı verir; süresi dolmuş sertifika reddedilir', () => {
    const only = nodeCheck(leafCert, leafKey, 'erp.test');
    expect(only.ok).toBe(true);
    expect(only.warnings.join()).toMatch(/ara sertifika/);
    expect(bashCheck('leafonly.pem', 'leaf.key', 'erp.test').text).toMatch(/UYARI .*ara sertifika/);
    const future = new Date(Date.now() + 90 * 86_400_000);
    expect(nodeCheck(leafCert, leafKey, 'erp.test', future).errors.join()).toMatch(/süresi dolmuş/);
  });

  it('parolalı anahtar ve sertifika dosyasına gömülü anahtar reddedilir', () => {
    expect(nodeCheck(leafCert + leafKey, leafKey).ok).toBe(false);
    expect(nodeCheck(leafCert, '-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n').errors.join()).toMatch(/parola/);
  });

  it('araç komutu çıkış kodu ve çıktıyla çalışır; anahtar içeriği yazdırılmaz', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'installer/tools/erp-tool.mjs'), 'cert-check', '--cert', join(dir, 'full.pem'), '--key', join(dir, 'leaf.key'), '--domain', 'erp.test'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('PRIVATE KEY');
    const bad = spawnSync(process.execPath, [join(ROOT, 'installer/tools/erp-tool.mjs'), 'cert-check', '--cert', join(dir, 'full.pem'), '--key', join(dir, 'other.key')], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
  });
});

describe('betikler', () => {
  it.skipIf(!HAS_BASH)('bash sözdizimi geçerli; --help çalışır', () => {
    for (const f of ['installer/install.sh', 'installer/lib/config.sh', 'installer/lib/wizard.sh', 'scripts/backup.sh', 'scripts/restore.sh']) {
      expect(spawnSync('bash', ['-n', join(ROOT, f)], { encoding: 'utf8' }).status, f).toBe(0);
    }
    const help = spawnSync('bash', [join(ROOT, 'installer/install.sh'), '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    for (const flag of ['--answers', '--reconfigure', '--dry-run', '--yes', '--tls']) expect(help.stdout).toContain(flag);
  });

  it('PowerShell betikleri ayrıştırılır (pwsh varsa); Windows betikleri BOM ile kaydedilmiştir', () => {
    for (const f of ['installer/install.ps1', 'installer/lib/config.ps1', 'installer/lib/wizard.ps1']) {
      const bytes = readFileSync(join(ROOT, f));
      expect([...bytes.subarray(0, 3)], `${f} BOM`).toEqual([0xef, 0xbb, 0xbf]); // Windows PowerShell 5.1 BOM'suz dosyayı ANSI sanır
      if (HAS_PWSH) {
        const r = spawnSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${join(ROOT, f)}',[ref]$t,[ref]$e);$e.Count`], { encoding: 'utf8' });
        expect(r.stdout.trim(), f).toBe('0');
      }
    }
  });
});
