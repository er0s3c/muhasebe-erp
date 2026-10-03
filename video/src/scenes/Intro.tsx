import React from 'react';
import { AbsoluteFill, Html5Audio, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, NARRATION } from '../theme';
import { Chip, DarkBackground, Logo, Micro, RevealLine, prog } from '../components/ui';
import { Subtitles } from '../components/Subtitles';
import type { SceneTiming } from '../timing';

const MODULES = ['Muhasebe', 'Cari', 'Stok', 'Fatura', 'Kasa & banka', 'İnşaat'];
const SYMBOLS = ['₺', '£', '€', '$'];

export const Intro: React.FC<{ timing: SceneTiming }> = ({ timing }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shot = spring({ frame: frame - 26, fps, config: { damping: 200 }, durationInFrames: 40 });
  const float = Math.sin(frame / 38) * 8;
  const logo = spring({ frame: frame - 14, fps, config: { damping: 14, stiffness: 120 } });
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <DarkBackground glow={{ x: '78%', y: '45%' }} />
      {/* sağda eğik, süzülen gerçek ekran */}
      <div
        style={{
          position: 'absolute',
          left: 1010,
          top: 140,
          width: 1100,
          height: 688,
          perspective: 2600,
          opacity: shot,
          transform: `translateX(${interpolate(shot, [0, 1], [260, 0])}px) translateY(${float}px)`,
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            transform: 'rotateY(-16deg) rotateX(5deg) rotateZ(1.2deg)',
            transformOrigin: 'left center',
            borderRadius: 22,
            overflow: 'hidden',
            border: '1.5px solid rgba(255,255,255,0.18)',
            boxShadow: '0 60px 120px rgba(0,0,0,0.55)',
            background: C.bone,
          }}
        >
          <Img src={staticFile('shots/dashboard.png')} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'left top' }} />
        </div>
      </div>
      {/* para birimi simgeleri */}
      {SYMBOLS.map((s, i) => {
        const p = prog(frame, 70 + i * 8, 24);
        return (
          <div
            key={s}
            style={{
              position: 'absolute',
              left: 1010 + i * 140,
              top: 850 + Math.sin((frame + i * 25) / 30) * 8,
              width: 92,
              height: 92,
              borderRadius: 22,
              background: C.lime,
              color: C.ink,
              fontSize: 54,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: p,
              transform: `translateY(${(1 - p) * 40}px) scale(${0.8 + 0.2 * p})`,
              boxShadow: '0 16px 40px rgba(0,0,0,0.4)',
            }}
          >
            {s}
          </div>
        );
      })}
      <AbsoluteFill style={{ padding: '0 0 0 140px', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginBottom: 46, transform: `scale(${interpolate(logo, [0, 1], [0.5, 1])})`, transformOrigin: 'left center', opacity: Math.min(1, logo * 2) }}>
          <Logo size={84} />
          <Micro color={C.ashLight} size={24}>
            KKTC işletmeleri için
          </Micro>
        </div>
        <RevealLine from={22} style={{ fontSize: 160, fontWeight: 500, color: C.white, letterSpacing: -6.5, lineHeight: 1 }}>
          Muhasebe
        </RevealLine>
        <RevealLine from={32} style={{ fontSize: 160, fontWeight: 500, color: C.white, letterSpacing: -6.5, lineHeight: 1, marginTop: 4 }}>
          <span style={{ background: C.lime, color: C.ink, padding: '0 28px 6px', borderRadius: 22, marginLeft: -4 }}>ERP</span>
        </RevealLine>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'nowrap', marginTop: 56 }}>
          {MODULES.map((m, i) => {
            const p = prog(frame, 80 + i * 5, 16);
            return (
              <Chip key={m} dark style={{ opacity: p, transform: `translateY(${(1 - p) * 14}px)`, fontSize: 23, padding: '11px 18px' }}>
                {m}
              </Chip>
            );
          })}
        </div>
      </AbsoluteFill>
      <Subtitles cues={timing.cues} />
      {NARRATION && <Html5Audio src={staticFile(timing.audio)} />}
    </AbsoluteFill>
  );
};
