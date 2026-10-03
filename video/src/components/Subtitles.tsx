import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../theme';
import type { Cue } from '../timing';

/** Aktif ifadeyi alt yazı olarak gösterir; süreler seslendirmenin gerçek süresinden gelir. */
export const Subtitles: React.FC<{ cues: Cue[] }> = ({ cues }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const cue = cues.find((c) => t >= c.start - 0.05 && t <= c.end + 0.2);
  if (!cue) return null;
  const inP = interpolate(t, [cue.start - 0.05, cue.start + 0.15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const outP = interpolate(t, [cue.end + 0.05, cue.end + 0.2], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const o = Math.min(inP, outP);
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 30, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          maxWidth: 1580,
          padding: '12px 32px 14px',
          borderRadius: 14,
          background: 'rgba(12,10,8,0.9)',
          border: `1px solid ${C.line}`,
          color: C.white,
          fontFamily: FONT,
          fontWeight: 500,
          fontSize: 38,
          lineHeight: 1.28,
          textAlign: 'center',
          textWrap: 'balance',
          letterSpacing: -0.2,
          opacity: o,
          transform: `translateY(${(1 - o) * 12}px)`,
        }}
      >
        {cue.text}
      </div>
    </div>
  );
};
