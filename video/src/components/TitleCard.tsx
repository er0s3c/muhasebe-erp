import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../theme';
import { DarkBackground, Micro, RevealLine, easeInOut, prog } from './ui';

/** Bölüm başlık kartı: büyük numara, başlık, alt başlık ve bölüm ilerleme noktaları. `exitAt` karesinde yukarı kayarak çıkar. */
export const TitleCard: React.FC<{
  index: number;
  count: number;
  title: string;
  subtitle: string;
  exitAt: number;
}> = ({ index, count, title, subtitle, exitAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exit = prog(frame, exitAt, 20, easeInOut);
  if (exit >= 1) return null;
  const tile = spring({ frame: frame - 4, fps, config: { damping: 15, stiffness: 120 } });
  const num = String(index).padStart(2, '0');
  return (
    <AbsoluteFill style={{ transform: `translateY(${-exit * 105}%)` }}>
      <DarkBackground />
      <AbsoluteFill style={{ justifyContent: 'center', padding: '0 170px', fontFamily: FONT }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 70 }}>
          <div
            style={{
              width: 250,
              height: 250,
              borderRadius: 34,
              background: C.lime,
              color: C.ink,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 150,
              fontWeight: 600,
              letterSpacing: -6,
              transform: `scale(${interpolate(tile, [0, 1], [0.6, 1])}) rotate(${interpolate(tile, [0, 1], [-8, 0])}deg)`,
              opacity: Math.min(1, tile * 2),
              flexShrink: 0,
            }}
          >
            {num}
          </div>
          <div style={{ minWidth: 0 }}>
            <Micro style={{ marginBottom: 22, opacity: prog(frame, 8, 14) }}>
              Bölüm {index} / {count}
            </Micro>
            <RevealLine from={10} style={{ fontSize: 104, fontWeight: 500, color: C.white, letterSpacing: -3.5, lineHeight: 1.04 }}>
              {title}
            </RevealLine>
            <div style={{ marginTop: 26, fontSize: 40, color: C.ashLight, fontWeight: 400, opacity: prog(frame, 22, 18), transform: `translateY(${(1 - prog(frame, 22, 18)) * 16}px)`, letterSpacing: -0.3 }}>
              {subtitle}
            </div>
          </div>
        </div>
        <div style={{ position: 'absolute', left: 170, bottom: 150, display: 'flex', gap: 12 }}>
          {Array.from({ length: count }, (_, i) => {
            const active = i + 1 === index;
            const done = i + 1 < index;
            return (
              <div
                key={i}
                style={{
                  height: 8,
                  width: active ? 96 : 40,
                  borderRadius: 4,
                  background: active ? C.lime : done ? 'rgba(228,242,34,0.45)' : 'rgba(255,255,255,0.18)',
                  opacity: prog(frame, 14 + i * 3, 12),
                }}
              />
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
