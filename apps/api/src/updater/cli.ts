import { readFileSync } from 'node:fs';
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
const result = await new Updater(cfg, ring).runOnce();
if (result.outcome !== 'idle' && result.outcome !== 'busy') console.log(`${result.outcome}${result.message ? `: ${result.message}` : ''}`);
process.exit(result.outcome === 'failed' ? 1 : 0);
