import React from 'react';
import { Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../theme';
import { easeInOut, prog } from './ui';

export const IMG_W = 1376;
export const IMG_H = 860;
export const BAR_H = 44;

/** Görüntü üzerinde kesirli koordinatlar: [x, y, genişlik, yükseklik] (0–1). */
export type Rect = [number, number, number, number];
export type Cam = { t: number; s: number; cx: number; cy: number };
export type Callout = { rect: Rect; label: string; side?: 'top' | 'bottom' | 'left' | 'right'; from: number; to: number; pad?: number };
export type Shot = { src: string; page: string; from: number; to: number; cam: Cam[]; callouts: Callout[] };

/** Anahtar karelerden (shot'a göre yerel saniye) kamera durumu; kenarlardan taşmayacak şekilde kırpılır. */
function camAt(keys: Cam[], t: number): { s: number; cx: number; cy: number } {
  let a = keys[0];
  let b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].t && t <= keys[i + 1].t) {
      a = keys[i];
      b = keys[i + 1];
      break;
    }
  }
  if (t <= keys[0].t) b = a;
  else if (t >= keys[keys.length - 1].t) a = b;
  const k = a === b ? 0 : easeInOut((t - a.t) / (b.t - a.t));
  const s = a.s + (b.s - a.s) * k;
  const lim = (v: number) => Math.min(1 - 0.5 / s, Math.max(0.5 / s, v));
  return { s, cx: lim(a.cx + (b.cx - a.cx) * k), cy: lim(a.cy + (b.cy - a.cy) * k) };
}

const CalloutView: React.FC<{ c: Callout; frame: number; fps: number; tx: number; ty: number; s: number }> = ({ c, frame, fps, tx, ty, s }) => {
  const pIn = prog(frame, c.from * fps, 12);
  const pOut = 1 - prog(frame, c.to * fps - 10, 10);
  const p = Math.min(pIn, pOut);
  if (p <= 0.001) return null;
  const pad = c.pad ?? 10;
  const x = c.rect[0] * IMG_W * s + tx - pad;
  const y = c.rect[1] * IMG_H * s + ty - pad;
  const w = c.rect[2] * IMG_W * s + pad * 2;
  const h = c.rect[3] * IMG_H * s + pad * 2;
  const side = c.side ?? 'bottom';
  const cx = Math.min(IMG_W - 230, Math.max(230, x + w / 2));
  const cy = Math.min(IMG_H - 40, Math.max(40, y + h / 2));
  const chipPos: React.CSSProperties =
    side === 'bottom'
      ? { left: cx, top: Math.min(IMG_H - 70, y + h + 16), transform: 'translateX(-50%)' }
      : side === 'top'
        ? { left: cx, top: Math.max(14, y - 66), transform: 'translateX(-50%)' }
        : side === 'left'
          ? { left: Math.max(14, x - 16), top: cy, transform: 'translate(-100%, -50%)' }
          : { left: Math.min(IMG_W - 14, x + w + 16), top: cy, transform: 'translateY(-50%)' };
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          width: w,
          height: h,
          borderRadius: 14,
          boxShadow: `0 0 0 4000px rgba(12,10,8,${0.5 * p})`,
          outline: `3px solid rgba(228,242,34,${p})`,
          outlineOffset: 0,
        }}
      />
      <div
        style={{
          position: 'absolute',
          ...chipPos,
          opacity: p,
          marginTop: side === 'bottom' ? (1 - p) * -8 : (1 - p) * 8,
          background: C.lime,
          color: C.ink,
          fontFamily: FONT,
          fontWeight: 600,
          fontSize: 30,
          padding: '12px 24px 13px',
          borderRadius: 12,
          whiteSpace: 'nowrap',
          letterSpacing: -0.3,
          boxShadow: '0 10px 30px rgba(12,10,8,0.28)',
        }}
      >
        {c.label}
      </div>
    </>
  );
};

/** Tarayıcı penceresi: üst çubuk + ekran görüntüsü + kamera hareketi + vurgular. Sahne karesine göre çalışır. */
export const ShotWindow: React.FC<{
  shots: Shot[];
  chapter: string;
  children?: React.ReactNode;
}> = ({ shots, chapter, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <div
      style={{
        width: IMG_W,
        height: IMG_H + BAR_H,
        borderRadius: 22,
        overflow: 'hidden',
        background: C.white,
        border: `1.5px solid ${C.border}`,
        boxShadow: '0 40px 100px rgba(12,10,8,0.22), 0 6px 18px rgba(12,10,8,0.1)',
        position: 'relative',
      }}
    >
      <div
        style={{
          height: BAR_H,
          background: '#faf9f8',
          borderBottom: `1px solid ${C.border}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 18px',
          fontFamily: FONT,
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', gap: 9 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 13, height: 13, borderRadius: 7, background: '#d9d7d5' }} />
          ))}
        </div>
        <div style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', fontSize: 17, color: C.ash, fontWeight: 500 }}>
          Muhasebe ERP · {([...shots].reverse().find((sh) => t >= sh.from - 0.2) ?? shots[0]).page}
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 15, color: C.ash, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 500 }}>
          {chapter} · Örnek veri
        </div>
      </div>
      <div style={{ position: 'relative', width: IMG_W, height: IMG_H, overflow: 'hidden', background: C.bone }}>
        {shots.map((sh, i) => {
          const fromF = sh.from * fps;
          const toF = sh.to * fps;
          // Sonraki ekran öncekinin üstünde belirir (ara boşluk yok); öncekini tamamen örtünce kaldırılır.
          const o = i === 0 ? 1 : prog(frame, fromF - 4, 10);
          if (i !== 0 && frame < fromF - 5) return null;
          if (i !== shots.length - 1 && frame > shots[i + 1].from * fps + 8) return null;
          void toF;
          const cam = camAt(sh.cam, t - sh.from);
          const tx = IMG_W / 2 - cam.cx * IMG_W * cam.s;
          const ty = IMG_H / 2 - cam.cy * IMG_H * cam.s;
          return (
            <div key={sh.src + i} style={{ position: 'absolute', inset: 0, opacity: o, transform: `scale(${interpolate(o, [0, 1], [1.015, 1])})` }}>
              <Img
                src={staticFile(`shots/${sh.src}`)}
                style={{ position: 'absolute', left: 0, top: 0, width: IMG_W, height: IMG_H, transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${cam.s})` }}
              />
              {sh.callouts.map((c, k) => (
                <CalloutView key={k} c={c} frame={frame} fps={fps} tx={tx} ty={ty} s={cam.s} />
              ))}
            </div>
          );
        })}
        {children}
      </div>
    </div>
  );
};
