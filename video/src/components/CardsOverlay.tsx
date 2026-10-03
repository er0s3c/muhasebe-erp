import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT } from '../theme';
import { Micro, prog } from './ui';

const ICONS: Record<string, React.ReactNode> = {
  stock: <path d="M3 8l9-5 9 5v8l-9 5-9-5V8zm0 0l9 5m0 0l9-5m-9 5v10" />,
  party: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </>
  ),
  ledger: (
    <>
      <path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z" />
      <path d="M9 9h6M9 13h6" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zm-3 9l2 2 4-4" />,
  roles: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6" />
      <path d="M16 5a3.5 3.5 0 010 6.5M18 14c2 .7 3.5 2.6 3.5 5" />
    </>
  ),
  audit: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5M11 8v3.5l2.5 1.5" />
    </>
  ),
  backup: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
};

export type OverlayCard = { icon: keyof typeof ICONS; title: string; sub: string; at: number };

const Icon: React.FC<{ name: keyof typeof ICONS; size: number }> = ({ name, size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={C.ink} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {ICONS[name]}
  </svg>
);

/** Pencere içinde, ekran görüntüsünü karartıp üstüne kartları sırayla getiren kaplama. */
export const CardsOverlay: React.FC<{
  from: number; // sn
  heading: string;
  cards: OverlayCard[];
  layout: 'row' | 'grid';
  tag?: { text: string; at: number };
}> = ({ from, heading, cards, layout, tag }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bg = prog(frame, from * fps, 14);
  if (bg <= 0) return null;
  const cardW = layout === 'row' ? 340 : 540;
  return (
    <AbsoluteFill style={{ background: `rgba(12,10,8,${0.58 * bg})`, alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      {heading && (
        <div style={{ opacity: bg, transform: `translateY(${(1 - bg) * 16}px)`, marginBottom: 30 }}>
          <Micro color={C.lime} size={22}>
            {heading}
          </Micro>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: layout === 'row' ? 0 : 26,
          width: layout === 'row' ? 1300 : 1130,
        }}
      >
        {cards.map((c, i) => {
          const sp = spring({ frame: frame - c.at * fps, fps, config: { damping: 16, stiffness: 140 } });
          return (
            <React.Fragment key={c.title}>
              {layout === 'row' && i > 0 && (
                <div style={{ width: 70, display: 'flex', justifyContent: 'center', opacity: sp }}>
                  <svg width="44" height="24" viewBox="0 0 44 24" fill="none" stroke={C.lime} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 12h38M30 3l10 9-10 9" />
                  </svg>
                </div>
              )}
              <div
                style={{
                  width: cardW,
                  boxSizing: 'border-box',
                  padding: layout === 'row' ? '30px 28px' : '28px 30px',
                  borderRadius: 20,
                  background: C.white,
                  display: 'flex',
                  flexDirection: layout === 'row' ? 'column' : 'row',
                  alignItems: layout === 'row' ? 'flex-start' : 'center',
                  gap: layout === 'row' ? 18 : 24,
                  opacity: Math.min(1, sp * 1.6),
                  transform: `translateY(${interpolate(sp, [0, 1], [34, 0])}px) scale(${interpolate(sp, [0, 1], [0.94, 1])})`,
                  boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
                }}
              >
                <div style={{ width: 68, height: 68, borderRadius: 16, background: C.lime, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name={c.icon} size={36} />
                </div>
                <div>
                  <div style={{ fontSize: 34, fontWeight: 600, color: C.ink, letterSpacing: -0.6, lineHeight: 1.15 }}>{c.title}</div>
                  <div style={{ fontSize: 22, color: C.ash, marginTop: 8, lineHeight: 1.3 }}>{c.sub}</div>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
      {tag && (
        <div
          style={{
            marginTop: 38,
            opacity: prog(frame, tag.at * fps, 12),
            transform: `translateY(${(1 - prog(frame, tag.at * fps, 12)) * 12}px)`,
            background: C.lime,
            color: C.ink,
            fontSize: 30,
            fontWeight: 600,
            padding: '12px 28px',
            borderRadius: 12,
            letterSpacing: -0.3,
          }}
        >
          {tag.text}
        </div>
      )}
    </AbsoluteFill>
  );
};
