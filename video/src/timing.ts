import timeline from './timeline.json';
import { FPS } from './theme';

export type Cue = { text: string; start: number; end: number };
export type SceneTiming = { id: string; audio: string; voiceSeconds: number; cues: Cue[]; frames: number };

/** Sahne geçişi (kare). Ardışık iki sahne bu kadar iç içe geçer; konuşma geçiş bittikten sonra başlar (make-voice LEAD). */
export const TRANSITION = 15;
/** Konuşma bittikten sonra sahnenin ekranda kaldığı ek süre (sn). */
const HOLD: Record<string, number> = { giris: 1.6, kapanis: 3.2 };

export const scenes: SceneTiming[] = timeline.scenes.map((s) => ({
  ...s,
  frames: Math.ceil((s.voiceSeconds + (HOLD[s.id] ?? 0.5)) * FPS),
}));

export const sceneById = (id: string) => {
  const s = scenes.find((x) => x.id === id);
  if (!s) throw new Error(`Sahne yok: ${id}`);
  return s;
};

export const TOTAL_FRAMES = scenes.reduce((a, s) => a + s.frames, 0) - TRANSITION * (scenes.length - 1);
export const sec = (s: number) => Math.round(s * FPS);
