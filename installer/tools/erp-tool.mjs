#!/usr/bin/env node
// Muhasebe ERP kurulum sihirbazı yardımcısı (Linux ve Windows aynı dosyayı kullanır).
// Kitteki gömülü Node.js ile ya da Node 22+ ile çalışır; ek paket gerektirmez (SMTP denemesi için kitteki/ depodaki nodemailer).
//
//   smtp-url   --host H --port P --security ssl|starttls|none [--user U] [--pass-env DEĞİŞKEN]    SMTP_URL değerini yazar
//   smtp-test  --to ADRES                  ortam: SMTP_URL, MAIL_FROM [, ERP_NODE_MODULES_DIR]    test e-postası gönderir
//   cert-check --cert DOSYA --key DOSYA [--domain ALAN] [--min-days N]                            sertifika/anahtar doğrular
//
// Çıkış kodu: 0 başarılı, 1 doğrulama/gönderim başarısız, 2 kullanım hatası. Parola ve özel anahtar ASLA yazdırılmaz.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Yüzde kodlama: yalnızca A-Z a-z 0-9 - _ . ~ olduğu gibi kalır (PowerShell EscapeDataString ve sihirbazın bash işleviyle aynı). */
export function urlEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** SMTP_URL üretir (nodemailer biçimi). security: ssl = smtps (465), starttls = zorunlu STARTTLS (587), none = şifresiz. */
export function buildSmtpUrl({ host, port, security, user = '', pass = '' }) {
  if (!['ssl', 'starttls', 'none'].includes(security)) throw new Error('security: ssl, starttls ya da none olmalı');
  const scheme = security === 'ssl' ? 'smtps' : 'smtp';
  const auth = user ? `${urlEncode(user)}:${urlEncode(pass)}@` : '';
  const query = security === 'starttls' ? '?requireTLS=true' : security === 'none' ? '?ignoreTLS=true' : '';
  return `${scheme}://${auth}${host}:${port}${query}`;
}

/** Hata iletisinden parola/URL sızıntısını ayıklar. */
export function scrub(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out.replace(/(:\/\/[^:/@\s]*:)[^@\s]*@/g, '$1***@');
}

/** SMTP hatasını düz Türkçe bir açıklamaya çevirir. */
export function explainSmtpError(err) {
  const code = err && typeof err === 'object' ? String(err.code ?? '') : '';
  const msg = `${err instanceof Error ? err.message : String(err)} ${String(err && typeof err === 'object' ? (err.responseCode ?? '') : '')}`;
  if (code === 'EAUTH' || /\b535\b|authentication/i.test(msg)) return 'Kullanıcı adı ya da parola reddedildi (kimlik doğrulama başarısız). Parolayı ve (Gmail/Office365 için) "uygulama parolası" gerekip gerekmediğini kontrol edin.';
  if (code === 'ENOTFOUND' || code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return 'SMTP sunucu adı bulunamadı (DNS). Sunucu adını yazım hatası için kontrol edin.';
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return 'Bağlantı reddedildi: sunucu bu portu dinlemiyor ya da güvenlik duvarı engelliyor. Port ve güvenlik türünü (SSL/STARTTLS) kontrol edin.';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /ETIMEDOUT|timeout|timed out/i.test(msg)) return 'Zaman aşımı: sunucuya ulaşılamadı. Sunucu adı, port ve giden bağlantı izni (güvenlik duvarı) kontrol edin.';
  if (/certificate|self.signed|unable to verify|CERT_|altnames/i.test(msg) || (code === 'ESOCKET' && /ssl|tls|cert/i.test(msg))) return 'TLS sertifikası doğrulanamadı (sunucu adı sertifikayla uyuşmuyor ya da kendi imzalı). Uygulama doğrulamayı kapatmaz; kendi imzalı sertifika için CA dosyasını NODE_EXTRA_CA_CERTS ile verin.';
  if (/wrong version number|ssl routines|greeting never received|packet length/i.test(msg)) return 'Güvenlik türü ve port uyuşmuyor (ör. 465 için SSL/TLS, 587 için STARTTLS seçilmeli).';
  if (code === 'EENVELOPE' || /recipient|550|553|554|relay/i.test(msg)) return 'Sunucu gönderen ya da alıcı adresini reddetti (gönderen adresi bu hesaba ait olmalı olabilir).';
  return 'Gönderilemedi.';
}

function loadNodemailer(modulesDir) {
  const bases = [modulesDir, process.env.ERP_NODE_MODULES_DIR, process.cwd()].filter(Boolean);
  for (const b of bases) {
    try {
      return createRequire(join(b, 'noop.js'))('nodemailer');
    } catch {
      /* sıradaki konum */
    }
  }
  throw new Error('nodemailer bulunamadı (kitte app/node_modules, depoda node_modules içinde olmalı)');
}

export async function smtpTest({ url, from, to, modulesDir, timeoutMs = 20_000 }) {
  const nodemailer = loadNodemailer(modulesDir);
  const transport = nodemailer.createTransport(url, {
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  try {
    await transport.verify();
    await transport.sendMail({
      from,
      to,
      subject: 'Muhasebe ERP kurulum sihirbazı: test e-postası',
      text: 'Bu ileti Muhasebe ERP kurulum sihirbazından gönderildi. Bunu okuyabiliyorsanız e-posta ayarları doğrudur.\n',
    });
  } finally {
    transport.close();
  }
}

/** PEM metnindeki tüm sertifikaları sırayla ayrıştırır. */
export function parsePemCerts(pem) {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

/**
 * Sertifika dosyasını ve anahtarı doğrular. Dönüş: { ok, errors[], warnings[], info[] } (ileti dizileri Türkçe).
 * Kontroller: sertifika okunuyor mu, anahtar sertifikaya uyuyor mu, süresi dolmuş mu / yakında dolacak mı, alan adını kapsıyor mu,
 * zincir sırası (yaprak önce, her sertifikayı sonraki imzalar), ara sertifika eksik mi.
 */
export function checkCert({ certPem, keyPem, domain = '', minDays = 14, now = new Date() }) {
  const errors = [];
  const warnings = [];
  const info = [];
  let certs = [];
  try {
    certs = parsePemCerts(certPem);
  } catch (e) {
    errors.push(`Sertifika dosyası okunamadı: ${e instanceof Error ? e.message : e}`);
  }
  if (certs.length === 0 && errors.length === 0) {
    errors.push('Sertifika dosyasında PEM sertifikası bulunamadı (BEGIN CERTIFICATE satırı yok). Dosya .pem/.crt (Base64) olmalı; .pfx/.p12 ise önce PEM\'e çevirin.');
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(certPem)) {
    errors.push('Sertifika dosyasının içinde özel anahtar var: yalnızca sertifika (ve zincir) dosyasını verin; anahtarı ayrı dosyada verin.');
  }
  if (/ENCRYPTED PRIVATE KEY|Proc-Type:.*ENCRYPTED/.test(keyPem)) {
    errors.push('Özel anahtar parola ile korunuyor; sunucu otomatik açamaz. Parolasız anahtar üretin (openssl rsa -in anahtar.key -out anahtar-parolasiz.key).');
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(keyPem) && errors.length === 0) {
    errors.push('Anahtar dosyasında özel anahtar bulunamadı (PEM biçimi beklenir).');
  }
  if (errors.length) return { ok: false, errors, warnings, info };

  const leaf = certs[0];
  info.push(`Sertifika: ${leaf.subject.replace(/\n/g, ', ')}; geçerlilik sonu ${new Date(leaf.validTo).toISOString().slice(0, 10)}`);
  try {
    const key = createPrivateKey(keyPem);
    if (!leaf.checkPrivateKey(key)) errors.push('Özel anahtar bu sertifikaya ait değil (ortak anahtarlar uyuşmuyor). Doğru .key dosyasını seçin.');
  } catch (e) {
    errors.push(`Özel anahtar okunamadı: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  const from = new Date(leaf.validFrom);
  const to = new Date(leaf.validTo);
  if (to.getTime() <= now.getTime()) errors.push(`Sertifikanın süresi dolmuş (${to.toISOString().slice(0, 10)}).`);
  else if (from.getTime() > now.getTime()) errors.push(`Sertifika henüz geçerli değil (başlangıç ${from.toISOString().slice(0, 10)}); sunucu saatini kontrol edin.`);
  else {
    const days = Math.floor((to.getTime() - now.getTime()) / 86_400_000);
    if (days < minDays) warnings.push(`Sertifikanın bitişine ${days} gün kaldı; yenilemeyi unutmayın.`);
  }
  if (domain) {
    const covered = isIP(domain) ? leaf.checkIP(domain) !== undefined : leaf.checkHost(domain) !== undefined;
    if (!covered) errors.push(`Sertifika "${domain}" adını kapsamıyor (konu/SAN: ${leaf.subjectAltName ?? leaf.subject.replace(/\n/g, ', ')}).`);
  }
  // Zincir sırası: yaprak ilk, sonra her biri bir öncekinin vereni
  for (let i = 0; i + 1 < certs.length; i++) {
    if (!certs[i].checkIssued(certs[i + 1])) {
      errors.push(`Zincir sırası yanlış: ${i + 1}. sertifikayı ${i + 2}. sertifika imzalamıyor. Dosya "yaprak, ara, (kök)" sırasında olmalı (full-chain).`);
      break;
    }
  }
  const selfSigned = leaf.checkIssued(leaf);
  if (certs.length === 1 && !selfSigned) warnings.push('Dosyada yalnızca sunucu sertifikası var, ara sertifika yok: bazı tarayıcı/istemciler güvenmeyebilir. Sağlayıcının "full chain / fullchain" dosyasını kullanın.');
  if (selfSigned) warnings.push('Kendi imzalı sertifika: tarayıcılar uyarı gösterir; istemci bilgisayarlara güvenilir kök olarak eklenmelidir.');
  return { ok: errors.length === 0, errors, warnings, info };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i];
  }
  return out;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (cmd === 'smtp-url') {
    if (!a.host || !a.port || !a.security) throw Object.assign(new Error('Kullanım: smtp-url --host H --port P --security ssl|starttls|none [--user U] [--pass-env DEĞİŞKEN]'), { usage: true });
    process.stdout.write(`${buildSmtpUrl({ host: a.host, port: a.port, security: a.security, user: a.user ?? '', pass: a['pass-env'] ? (process.env[a['pass-env']] ?? '') : '' })}\n`);
    return 0;
  }
  if (cmd === 'smtp-test') {
    const url = process.env.SMTP_URL;
    const from = process.env.MAIL_FROM;
    if (!a.to || !url || !from) throw Object.assign(new Error('Kullanım: SMTP_URL ve MAIL_FROM ortamıyla: smtp-test --to adres'), { usage: true });
    const secrets = [];
    try {
      const u = new URL(url);
      if (u.password) secrets.push(u.password, decodeURIComponent(u.password));
    } catch {
      /* URL ayrıştırılamazsa yalnızca kalıp temizliği yapılır */
    }
    try {
      await smtpTest({ url, from, to: a.to, modulesDir: process.env.ERP_NODE_MODULES_DIR });
      process.stdout.write(`Test e-postası gönderildi: ${a.to}\n`);
      return 0;
    } catch (e) {
      process.stdout.write(`${explainSmtpError(e)}\nAyrıntı: ${scrub(e instanceof Error ? e.message : e, secrets)}\n`);
      return 1;
    }
  }
  if (cmd === 'cert-check') {
    if (!a.cert || !a.key) throw Object.assign(new Error('Kullanım: cert-check --cert DOSYA --key DOSYA [--domain ALAN] [--min-days N]'), { usage: true });
    let r;
    try {
      r = checkCert({ certPem: readFileSync(a.cert, 'utf8'), keyPem: readFileSync(a.key, 'utf8'), domain: a.domain ?? '', minDays: Number(a['min-days'] ?? 14) });
    } catch (e) {
      process.stdout.write(`HATA Dosya okunamadı: ${e instanceof Error ? e.message.replace(/'[^']*private[^']*'/gi, "'anahtar dosyası'") : e}\n`);
      return 1;
    }
    for (const m of r.info) process.stdout.write(`BİLGİ ${m}\n`);
    for (const m of r.warnings) process.stdout.write(`UYARI ${m}\n`);
    for (const m of r.errors) process.stdout.write(`HATA ${m}\n`);
    return r.ok ? 0 : 1;
  }
  throw Object.assign(new Error('Komut: smtp-url | smtp-test | cert-check'), { usage: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
      process.exit(e && e.usage ? 2 : 1);
    },
  );
}
