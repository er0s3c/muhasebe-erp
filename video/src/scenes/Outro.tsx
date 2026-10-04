import React from 'react';
import { AbsoluteFill, Html5Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, FPS, NARRATION } from '../theme';
import { Chip, DarkBackground, Logo, Micro, prog } from '../components/ui';
import { Subtitles } from '../components/Subtitles';
import type { SceneTiming } from '../timing';

const TAGS = ['Muhasebe', 'Cari', 'Stok', 'Fatura', 'Kasa & banka', 'İnşaat & taahhüt'];

export const Outro: React.FC<{ timing: SceneTiming }> = ({ timing }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const logo = spring({ frame: frame - 6, fps, config: { damping: 14, stiffness: 110 } });
  const words = ['Sade.', 'Güçlü.', 'Güvenilir.'];
  const w0 = Math.round(timing.cues[1].start * FPS) - 2;
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <DarkBackground glow={{ x: '50%', y: '70%' }} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 90 }}>
        <div style={{ transform: `scale(${interpolate(logo, [0, 1], [0.5, 1])})`, opacity: Math.min(1, logo * 2) }}>
          <Logo size={150} />
        </div>
        <div style={{ marginTop: 40, fontSize: 138, fontWeight: 500, letterSpacing: -5.5, color: C.white, opacity: prog(frame, 14, 20), transform: `translateY(${(1 - prog(frame, 14, 20)) * 30}px)` }}>
          Muhasebe ERP
        </div>
        <div style={{ display: 'flex', gap: 38, marginTop: 34, fontSize: 70, fontWeight: 500, letterSpacing: -2 }}>
          {words.map((w, i) => {
            const p = prog(frame, w0 + i * 24, 16);
            return (
              <span key={w} style={{ color: i === 2 ? C.lime : C.white, opacity: p, transform: `translateY(${(1 - p) * 26}px)`, display: 'inline-block' }}>
                {w}
              </span>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 56, opacity: prog(frame, w0 + 80, 20) }}>
          {TAGS.map((t) => (
            <Chip key={t} dark style={{ fontSize: 24 }}>
              {t}
            </Chip>
          ))}
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 150, textAlign: 'center', opacity: prog(frame, w0 + 100, 20) }}>
        <Micro size={18} color={C.ash} style={{ letterSpacing: '0.14em' }}>
          Gösterilen ekranlar örnek (demo) verilerle hazırlanmıştır
        </Micro>
      </div>
      <Subtitles cues={timing.cues} />
      {NARRATION && <Html5Audio src={staticFile(timing.audio)} />}
    </AbsoluteFill>
  );
};
