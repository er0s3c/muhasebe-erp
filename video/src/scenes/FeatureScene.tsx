import React from 'react';
import { AbsoluteFill, Html5Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { NARRATION } from '../theme';
import { PaperBackground } from '../components/ui';
import { ShotWindow, BAR_H, IMG_H, IMG_W, type Shot } from '../components/ShotWindow';
import { TitleCard } from '../components/TitleCard';
import { Subtitles } from '../components/Subtitles';
import { CardsOverlay, type OverlayCard } from '../components/CardsOverlay';
import type { SceneTiming } from '../timing';

export type FeatureSpec = {
  number: number;
  count: number;
  title: string;
  subtitle: string;
  chapter: string;
  shots: Shot[];
  overlay?: { from: number; heading: string; layout: 'row' | 'grid'; cards: OverlayCard[]; tag?: { text: string; at: number } };
};

/** Bölüm sahnesi: başlık kartı → tarayıcı penceresinde gerçek ekran görüntüleri, vurgular, alt yazı ve seslendirme. */
export const FeatureScene: React.FC<{ timing: SceneTiming; spec: FeatureSpec }> = ({ timing, spec }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const exitAt = Math.round((timing.cues[0].end + 0.2) * fps);
  const appear = spring({ frame: frame - exitAt - 6, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill>
      <PaperBackground />
      <AbsoluteFill style={{ alignItems: 'center', paddingTop: 20 }}>
        <div
          style={{
            width: IMG_W,
            height: IMG_H + BAR_H,
            transform: `translateY(${interpolate(appear, [0, 1], [40, 0])}px) scale(${interpolate(appear, [0, 1], [0.955, 1])})`,
          }}
        >
          <ShotWindow shots={spec.shots} chapter={spec.chapter}>
            {spec.overlay && <CardsOverlay {...spec.overlay} />}
          </ShotWindow>
        </div>
      </AbsoluteFill>
      <TitleCard index={spec.number} count={spec.count} title={spec.title} subtitle={spec.subtitle} exitAt={exitAt} />
      <Subtitles cues={timing.cues} />
      {NARRATION && <Html5Audio src={staticFile(timing.audio)} />}
    </AbsoluteFill>
  );
};
