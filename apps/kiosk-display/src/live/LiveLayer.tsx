import { useEffect, useRef, useState } from 'preact/hooks';
import type { Settings } from '@surau/core';
import type { LiveView } from '../data/live.ts';
import { openWhep } from '../data/whep.ts';
import type { WhepState } from '../data/whep.ts';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import './live.css';

export interface LiveLayerProps {
  live: LiveView;
  settings: Settings;
  lang: Lang;
}

/**
 * The live on the kiosk (Plan 5 Task 6). Mounted by Main only in the `normal` phase and only while the box
 * says live, so every prayer phase unmounts it (and closes the WHEP session). Two parts:
 *  - the video, full stage, behind the glass (the identity block, the next prayer box, the ticker and the
 *    prayer bar stay where they are, on top). It stays invisible until it really plays, and when the player
 *    gives up it is removed: never a black or broken box, the normal background shows instead;
 *  - the kuliah strip, low in the content band where the cards would rotate.
 * Preview (and a player that cannot play) shows the strip alone with "Siaran langsung sedang berjalan".
 */
export function LiveLayer({ live, settings, lang }: LiveLayerProps) {
  const cfg = settings.liveOnKiosk;
  const fit = cfg?.fit === 'contain' ? 'contain' : 'cover';
  const showStrip = cfg?.showStrip !== false;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoOk, setVideoOk] = useState(live.playable);
  const [playing, setPlaying] = useState(false);
  // Orientation of the incoming picture, from the decoder's own size: read when the metadata arrives and on
  // every `resize` (a new stream with other dimensions mid-live). A portrait picture is always shown whole.
  const [orientation, setOrientation] = useState<'portrait' | 'landscape' | null>(null);
  const readOrientation = (): void => {
    const video = videoRef.current;
    if (!video) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    setOrientation(h > w ? 'portrait' : 'landscape');
  };
  const { audio, volume } = live;
  const path = live.path ?? '';
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  // A new run of the player (path or audio change, live back on) starts with the video box mounted again.
  useEffect(() => {
    setVideoOk(live.playable);
  }, [live.playable, audio, path]);

  // Volume changes apply in place; they never tear the connection down.
  useEffect(() => {
    const video = videoRef.current;
    if (video && Number.isFinite(volume)) video.volume = Math.min(1, Math.max(0, volume / 100));
  }, [volume]);

  useEffect(() => {
    if (!live.playable) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    let session: { close(): Promise<void> } | null = null;
    const onState = (s: WhepState): void => {
      if (s === 'unsupported') {
        setPlaying(false);
        setVideoOk(false);
      } else if (s === 'nostream' || s === 'retrying' || s === 'connecting') {
        setPlaying(false);
      }
    };
    try {
      session = openWhep(video, { audio, volume: volumeRef.current, onState });
    } catch (e) {
      console.error('kiosk live player failed to start; showing the strip only', e);
      setVideoOk(false);
    }
    return () => {
      void session?.close().catch(() => undefined);
    };
  }, [live.playable, audio, path, videoOk]);

  const k = live.kuliah;
  const showVideo = live.playable && videoOk;
  const onAir = showVideo && playing;

  return (
    <>
      {showVideo ? (
        <div class="live" data-playing={onAir ? 'true' : 'false'} aria-hidden="true">
          <video
            ref={videoRef}
            class="live__video"
            data-testid="live-video"
            data-fit={orientation === 'portrait' ? 'contain' : fit}
            data-orientation={orientation ?? undefined}
            muted
            autoplay
            playsInline
            disablePictureInPicture
            onPlaying={() => setPlaying(true)}
            onEmptied={() => setPlaying(false)}
            onLoadedMetadata={readOrientation}
            onResize={readOrientation}
          />
          <div class="live__scrim" />
        </div>
      ) : null}
      {showStrip || !onAir ? (
        <div class={`live-strip glass${onAir ? '' : ' is-waiting'}`} data-testid="live-strip" role="status">
          <span class="live-strip__tag">
            <i class="live-strip__dot" aria-hidden="true" />
            {t('liveNow', lang)}
          </span>
          <div class="live-strip__body">
            {k ? (
              <>
                <div class="live-strip__who">{k.penceramah}</div>
                <div class="live-strip__about">
                  <span class="live-strip__label">{k.label}</span>
                  {onAir ? (
                    k.topic ? (
                      <>
                        <span class="sep" aria-hidden="true" />
                        <span class="live-strip__topic">{k.topic}</span>
                      </>
                    ) : null
                  ) : (
                    <>
                      <span class="sep" aria-hidden="true" />
                      <span class="live-strip__topic">{t('liveRunning', lang)}</span>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div class="live-strip__who">{t('liveRunning', lang)}</div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
