/**
 * Videoyu 1080p MP4 olarak üretir: out/muhasebe-erp-tanitim.mp4
 *   npm run render                 (ses ve müzik hazır olmalı: npm run voice && npm run music)
 *   REMOTION_BROWSER_EXECUTABLE=/yol/chrome npm run render   (Chrome Headless Shell indirilemiyorsa)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('out', { recursive: true });
const r = spawnSync(
  'npx',
  ['remotion', 'render', 'src/index.ts', 'Tanitim', 'out/muhasebe-erp-tanitim.mp4', '--crf=20', '--audio-bitrate=192k', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
