import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { C, FONT } from '../theme';

export const ease = Easing.bezier(0.22, 1, 0.36, 1); // easeOutExpo benzeri
export const easeInOut = Easing.inOut(Easing.cubic);

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** `from` karesinden başlayıp `dur` karede 0→1 giden yumuşak ilerleme. */
export const prog = (frame: number, from: number, dur = 18, easing: (t: number) => number = ease) =>
  easing(clamp01((frame - from) / dur));

/** Uygulamadaki logo: limon sarısı kare üstünde siyah M. */
export const Logo: React.FC<{ size: number; radius?: number }> = ({ size, radius }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: radius ?? size * 0.22,
      background: C.lime,
      color: C.ink,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: FONT,
      fontWeight: 600,
      fontSize: size * 0.62,
      letterSpacing: -size * 0.03,
      lineHeight: 1,
    }}
  >
    M
  </div>
);

/** Açık zemin: kırık beyaz kâğıt + hafif nokta ızgarası (çok yavaş kayar). */
export const PaperBackground: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.bone }}>
      <AbsoluteFill
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(12,10,8,0.085) 1.4px, transparent 1.6px)',
          backgroundSize: '36px 36px',
          backgroundPosition: `${frame * 0.12}px ${frame * 0.08}px`,
        }}
      />
    </AbsoluteFill>
  );
};

/** Koyu zemin: Obsidian + çok hafif ızgara ve köşede soluk limon ışıma. */
export const DarkBackground: React.FC<{ glow?: { x: string; y: string } }> = ({ glow = { x: '85%', y: '110%' } }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.obsidian }}>
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)',
          backgroundSize: '80px 80px',
          backgroundPosition: `${-frame * 0.25}px ${-frame * 0.15}px`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${glow.x} ${glow.y}, rgba(228,242,34,0.16), transparent 48%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/** Küçük büyük harf etiket (uygulamadaki `.micro`). */
export const Micro: React.FC<{ children: React.ReactNode; color?: string; size?: number; style?: React.CSSProperties }> = ({
  children,
  color = C.ashLight,
  size = 22,
  style,
}) => (
  <div
    style={{
      fontFamily: FONT,
      fontWeight: 500,
      fontSize: size,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color,
      ...style,
    }}
  >
    {children}
  </div>
);

/** Metni alttan maske içinde kaydırarak açan satır. */
export const RevealLine: React.FC<{ children: React.ReactNode; from: number; dur?: number; style?: React.CSSProperties }> = ({
  children,
  from,
  dur = 22,
  style,
}) => {
  const frame = useCurrentFrame();
  const p = prog(frame, from, dur);
  return (
    <div style={{ overflow: 'hidden', paddingBottom: '0.12em', marginBottom: '-0.12em', ...style }}>
      <div style={{ transform: `translateY(${(1 - p) * 110}%)`, opacity: interpolate(p, [0, 0.4], [0, 1], { extrapolateRight: 'clamp' }) }}>
        {children}
      </div>
    </div>
  );
};

export const Chip: React.FC<{ children: React.ReactNode; dark?: boolean; style?: React.CSSProperties }> = ({ children, dark, style }) => (
  <div
    style={{
      fontFamily: FONT,
      fontWeight: 500,
      fontSize: 26,
      padding: '12px 22px',
      borderRadius: 10,
      border: `1.5px solid ${dark ? C.line : C.border}`,
      color: dark ? C.white : C.ink,
      background: dark ? 'rgba(255,255,255,0.06)' : C.white,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {children}
  </div>
);
