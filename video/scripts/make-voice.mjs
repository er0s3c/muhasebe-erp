/**
 * Seslendirmeyi üretir ve zaman çizelgesini yazar (content/script.json → public/audio/*.mp3 + src/timeline.json).
 *
 * Motorlar (VOICE_ENGINE):
 *   mbrola (varsayılan)  tamamen çevrimdışı, ücretsiz: espeak-ng + MBROLA Türkçe ses (apt: espeak-ng mbrola mbrola-tr1)
 *   espeak               yalnızca espeak-ng (daha robotik, ek paket gerekmez)
 *   edge                 Microsoft Edge nöral sesi (tr-TR-AhmetNeural), ücretsiz ama internet ister: pip install edge-tts
 *
 * Her ifade ayrı seslendirilir; böylece alt yazı süreleri tahmin değil, gerçek ses süresidir.
 *   VOICE_RATE=165 (espeak hızı, kelime/dk)  VOICE_NAME=tr-TR-AhmetNeural (edge)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = JSON.parse(readFileSync(join(root, 'content/script.json'), 'utf8'));
const engine = process.env.VOICE_ENGINE ?? 'mbrola';
const rate = process.env.VOICE_RATE ?? '165';
const work = join(root, '.voice-work');
const outDir = join(root, 'public/audio');
const SR = 48000;
const LEAD = 0.55; // sahne başında sessizlik (sn): sahne geçişi (0,5 sn) bitince konuşma başlar
const TAIL = 0.3; // sahne sonunda sessizlik (sn)

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
const duration = (file) =>
  parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

function synth(text, out) {
  const raw = out.replace(/\.wav$/, '.raw.wav');
  if (engine === 'edge') {
    const mp3 = out.replace(/\.wav$/, '.mp3');
    execFileSync('edge-tts', ['--voice', process.env.VOICE_NAME ?? 'tr-TR-AhmetNeural', '--rate=-3%', '--text', text, '--write-media', mp3]);
    ff('-i', mp3, '-ar', String(SR), '-ac', '1', raw);
  } else if (engine === 'espeak') {
    execFileSync('espeak-ng', ['-v', 'tr', '-s', rate, '-p', '38', '-w', raw, text]);
  } else {
    const voice = process.env.VOICE_NAME ?? 'tr1';
    // espeak fonemleri üretir; MBROLA Türkçe sesinde olmayan "&" (kısa ünsüz arası ünlü) ve "l/" (koyu l) birimleri
    // sessizlik bırakır, bu yüzden bilinen karşılıklarıyla değiştirilir.
    const pho = spawnSync('espeak-ng', ['-v', `mb-${voice}`, '-s', rate, '-q', '--pho', text], { encoding: 'utf8' }).stdout;
    const fixed = pho.replace(/^&/gm, 'I').replace(/^[lL]\//gm, 'l');
    const phoFile = out.replace(/\.wav$/, '.pho');
    writeFileSync(phoFile, fixed);
    const r = spawnSync('mbrola', [`/usr/share/mbrola/${voice}/${voice}`, phoFile, raw], { encoding: 'utf8' });
    if (r.status !== 0 || /Fatal/.test(r.stderr ?? '')) throw new Error(`mbrola: ${r.stderr}`);
    if (/unknown/.test(r.stderr ?? '')) console.warn(`  ! eksik birim: ${r.stderr.trim().split('\n')[0]}`);
  }
  // Baştaki/sondaki sessizliği kırp, 48 kHz'e çıkar, hafif EQ (insan sesine ön plan) ve sıkıştırma uygula
  ff(
    '-i', raw,
    '-af',
    'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,' +
      'highpass=f=90,lowpass=f=7600,equalizer=f=2800:t=q:w=1.2:g=2.5,equalizer=f=220:t=q:w=1:g=1.5,' +
      'acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=3,aresample=' + SR,
    '-ac', '1', out,
  );
}

function silence(sec, out) {
  ff('-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=mono`, '-t', String(sec), out);
}

const timeline = { fps: 30, sampleRate: SR, engine, scenes: [] };
for (const scene of script.scenes) {
  console.log(`▶ ${scene.id}`);
  const parts = [];
  const cues = [];
  let t = LEAD;
  silence(LEAD, join(work, `${scene.id}-lead.wav`));
  parts.push(join(work, `${scene.id}-lead.wav`));
  scene.cues.forEach((cue, i) => {
    const f = join(work, `${scene.id}-${i}.wav`);
    synth(cue.say ?? cue.text, f);
    const d = duration(f);
    cues.push({ text: cue.text, start: +t.toFixed(3), end: +(t + d).toFixed(3) });
    parts.push(f);
    t += d;
    if (i < scene.cues.length - 1) {
      const g = join(work, `${scene.id}-gap${i}.wav`);
      silence(script.gapSeconds, g);
      parts.push(g);
      t += script.gapSeconds;
    }
  });
  silence(TAIL, join(work, `${scene.id}-tail.wav`));
  parts.push(join(work, `${scene.id}-tail.wav`));
  const list = join(work, `${scene.id}.txt`);
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  const joined = join(work, `${scene.id}-joined.wav`);
  ff('-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined);
  // Konuşma sesini -16 LUFS civarına getir
  ff('-i', joined, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=7', '-ar', String(SR), '-ac', '1', '-b:a', '160k', join(outDir, `${scene.id}.mp3`));
  const total = duration(join(outDir, `${scene.id}.mp3`));
  timeline.scenes.push({ id: scene.id, audio: `audio/${scene.id}.mp3`, voiceSeconds: +total.toFixed(3), cues });
  console.log(`  ${total.toFixed(2)} sn, ${cues.length} ifade`);
}
const sum = timeline.scenes.reduce((a, s) => a + s.voiceSeconds, 0);
console.log(`Toplam ses: ${sum.toFixed(1)} sn`);
writeFileSync(join(root, 'src/timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
rmSync(work, { recursive: true, force: true });
