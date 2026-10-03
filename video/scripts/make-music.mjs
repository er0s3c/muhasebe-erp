/**
 * Arka plan müziği: ffmpeg ile üretilen, telifsiz, sakin bir pad (Am – F – C – G). Harici dosya/indirme gerekmez.
 * Konuşmanın altında Remotion tarafında kısık çalınır. Süre: DURATION (sn, varsayılan 75).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/audio/music.mp3');
mkdirSync(dirname(out), { recursive: true });
const DURATION = Number(process.env.DURATION ?? 75);
const BAR = 4; // sn, bir akor
const chords = [
  [220.0, 261.63, 329.63, 440.0], // Am
  [174.61, 261.63, 349.23, 440.0], // F
  [196.0, 261.63, 329.63, 392.0], // C
  [196.0, 246.94, 293.66, 392.0], // G
];
const bass = [55.0, 43.65, 65.41, 49.0];
const bars = Math.ceil(DURATION / BAR) + 1;
const inputs = [];
const labels = [];
let n = 0;
for (let b = 0; b < bars; b++) {
  const ch = b % 4;
  const start = b * BAR;
  for (const f of [...chords[ch], bass[ch]]) {
    const low = f < 100;
    const len = BAR + 1.6;
    inputs.push('-f', 'lavfi', '-t', String(len), '-i', `sine=frequency=${f}:sample_rate=44100`);
    const vol = low ? 0.5 : 0.16;
    labels.push(
      `[${n}:a]afade=t=in:st=0:d=1.4,afade=t=out:st=${len - 1.6}:d=1.6,volume=${vol},adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}[a${n}]`,
    );
    n++;
  }
}
const mix = labels.map((_, i) => `[a${i}]`).join('');
const filter =
  labels.join(';') +
  `;${mix}amix=inputs=${n}:normalize=0,aecho=0.8:0.55:420|760:0.35|0.22,lowpass=f=1800,tremolo=f=0.18:d=0.25,` +
  `atrim=0:${DURATION},afade=t=out:st=${DURATION - 4}:d=4,loudnorm=I=-26:TP=-3[m]`;
const script = join(root, '.music-filter.txt');
writeFileSync(script, filter);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex_script', script, '-map', '[m]', '-ac', '2', '-ar', '44100', '-b:a', '128k', out]);
console.log('Müzik hazır:', out);
