import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Composition, Html5Audio, continueRender, delayRender, interpolate, staticFile, useVideoConfig, useCurrentFrame } from 'remotion';
import { TransitionSeries, linearTiming, type TransitionPresentation } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import { fontsReady } from './fonts';
import { FPS, HEIGHT, WIDTH } from './theme';
import { TOTAL_FRAMES, TRANSITION, scenes, sceneById } from './timing';
import { buildSpecs } from './specs';
import { Intro } from './scenes/Intro';
import { Outro } from './scenes/Outro';
import { FeatureScene } from './scenes/FeatureScene';

const specs = buildSpecs();

/** Arka plan müziği: konuşmanın altında kısık; açılışta yükselir, kapanışta söner. */
const Music: React.FC = () => {
  const { durationInFrames } = useVideoConfig();
  return (
    <Html5Audio
      src={staticFile('audio/music.mp3')}
      volume={(f) => interpolate(f, [0, 45, durationInFrames - 75, durationInFrames - 1], [0, 0.42, 0.42, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
    />
  );
};

const Tanitim: React.FC = () => {
  const [handle] = useState(() => delayRender('Yazı tipleri yükleniyor'));
  useEffect(() => {
    fontsReady.then(() => continueRender(handle)).catch((e) => {
      console.error(e);
      continueRender(handle);
    });
  }, [handle]);

  const t = linearTiming({ durationInFrames: TRANSITION });
  const order = ['giris', 'muhasebe', 'fatura', 'kasa', 'insaat', 'guvenlik', 'kapanis'];
  // Geçişler: açılış→bölümler "silme", bölümler arası "kayma", kapanışa "solma"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const presentation = (i: number): TransitionPresentation<any> => (i === 0 ? wipe({ direction: 'from-left' }) : i === order.length - 2 ? fade() : slide({ direction: 'from-right' }));
  return (
    <AbsoluteFill style={{ background: '#1a1919' }}>
      <TransitionSeries>
        {order.flatMap((id, i) => {
          const s = sceneById(id);
          const node =
            id === 'giris' ? <Intro timing={s} /> : id === 'kapanis' ? <Outro timing={s} /> : <FeatureScene timing={s} spec={specs[id]} />;
          const parts = [
            <TransitionSeries.Sequence key={id} durationInFrames={s.frames}>
              {node}
            </TransitionSeries.Sequence>,
          ];
          if (i < order.length - 1) parts.push(<TransitionSeries.Transition key={`${id}-t`} presentation={presentation(i)} timing={t} />);
          return parts;
        })}
      </TransitionSeries>
      <Music />
    </AbsoluteFill>
  );
};

export const Root: React.FC = () => (
  <Composition id="Tanitim" component={Tanitim} durationInFrames={TOTAL_FRAMES} fps={FPS} width={WIDTH} height={HEIGHT} />
);

// scenes sırası zaman çizelgesiyle uyumlu olmalı
if (scenes.length !== 7) throw new Error('Beklenen 7 sahne (giriş, 5 bölüm, kapanış)');
