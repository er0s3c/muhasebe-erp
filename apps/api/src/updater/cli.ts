import { readFileSync, mkdirSync, createReadStream, copyFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseReleaseManifest } from '@erp/license-core';
import { join } from 'node:path';
import { BUILD_KEYRING_JSON } from '../licensing/build-info';
import { parseKeyring } from '../licensing/keyring';
import devKeys from '../licensing/public-keys.json';
import { Updater, type UpdaterConfig } from './updater';

/**
 * `node updater.js [--config=<yol>]` — kurulum sihirbazının zamanladığı tek seferlik güncelleyici çalıştırması.
 * Varsayılan yapılandırma: Linux /etc/muhasebe-erp/updater.json, Windows %ProgramData%\MuhasebeERP\updater.json.
 */
const arg = process.argv.find((a) => a.startsWith('--config='))?.slice('--config='.length);
const fallback = process.platform === 'win32' ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'MuhasebeERP', 'updater.json') : '/etc/muhasebe-erp/updater.json';
const path = arg ?? fallback;

let cfg: UpdaterConfig;
try {
  cfg = JSON.parse(readFileSync(path, 'utf8')) as UpdaterConfig;
} catch (err) {
  console.error(`Güncelleyici yapılandırması okunamadı (${path}): ${(err as Error).message}`);
  process.exit(2);
}
// Satıcı açık anahtarı derlemeye gömülüdür (geliştirmede depodaki anahtar)
const ring = parseKeyring(BUILD_KEYRING_JSON ?? JSON.stringify(devKeys));
const offlineManifest = process.argv.find((a) => a.startsWith('--offline-manifest='))?.slice('--offline-manifest='.length);
const offlineArchive = process.argv.find((a) => a.startsWith('--offline-archive='))?.slice('--offline-archive='.length);
if (offlineManifest || offlineArchive) {
  if (!offlineManifest || !offlineArchive || !process.argv.includes('--confirm-offline')) throw new Error('Çevrimdışı paket, imzalı manifesto ve açık bakım onayı gerekli');
  const signed = readFileSync(offlineManifest, 'utf8').trim(); const m = parseReleaseManifest(signed, ring);
  const file = m.files.find((f) => f.target === cfg.platform); if (!file) throw new Error('Paket bu platforma uygun değil');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(offlineArchive)) hash.update(chunk);
  if (statSync(offlineArchive).size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('Çevrimdışı paket değiştirilmiş veya bozuk');
  const dir = join(cfg.workDir, 'downloads'); mkdirSync(dir, { recursive: true }); copyFileSync(offlineArchive, join(dir, file.name));
  const token = /^ERP_UPDATER_TOKEN=(.+)$/m.exec(readFileSync(cfg.envFile, 'utf8'))?.[1]?.trim();
  const response = await fetch(`${cfg.appUrl}/api/system/updater/offline`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-updater-token': token ?? '' }, body: JSON.stringify({ manifest: signed, confirmed: true }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Çevrimdışı güncelleme onayı reddedildi (${response.status})`);
}
const result = await new Updater(cfg, ring).runOnce();
if (result.outcome !== 'idle' && result.outcome !== 'busy') console.log(`${result.outcome}${result.message ? `: ${result.message}` : ''}`);
process.exit(result.outcome === 'failed' ? 1 : 0);
