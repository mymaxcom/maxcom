import { useEffect, useRef, useState } from 'preact/hooks';
import type { Settings } from '@surau/core';
import type { LiveView } from '../data/live.ts';
import { openWhep } from '../data/whep.ts';
import type { WhepState } from '../data/whep.ts';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import type { LiveDisplayMode } from './liveMode.ts';
import './live.css';

/** No new video frame for this long: the picture counts as gone and the kiosk falls back to its normal screens. */
export const FRAME_STALE_MS = 10_000;

export interface LiveVideoProps {
  live: LiveView;
  settings: Settings;
  /** 'clear': the video fills the live screen's frame; 'blurred': full stage, blurred, under the prayer screen. */
  mode: Exclude<LiveDisplayMode, 'none'>;
  /**
   * Told whether real pictures are on screen: playing AND a frame arrived in the last [FRAME_STALE_MS]. The app
   * shows the live screen only then; with no frames (ingest stalled, WHEP failed) the normal screens stay.
   */
  onAir?: (playing: boolean) => void;
}

/**
 * The live's video (Plan 5 Task 6, reworked 2026-11-14). Owned by the app ABOVE the phase switch, so one WHEP
 * session runs for the whole live: switching between the clear live screen and a blurred live under a prayer
 * screen moves and blurs the same element, it never unmounts it and never reconnects.
 * It stays invisible until it really plays, and when the player gives up it is removed: never a black or broken
 * box. Preview (not playable) renders nothing here: the live screen shows its strip and a waiting card instead.
 */
export function LiveVideo({ live, settings, mode, onAir }: LiveVideoProps) {
  const cfg = settings.liveOnKiosk;
  const fit = cfg?.fit === 'contain' ? 'contain' : 'cover';
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoOk, setVideoOk] = useState(live.playable);
  const [playing, setPlaying] = useState(false);
  // True from a frame (or the `playing` event) until FRAME_STALE_MS pass without the next one. The same <video>
  // stays mounted across a stall and a resume: nothing here reconnects.
  const [fresh, setFresh] = useState(false);
  const lastFrameRef = useRef(0);
  const markFrame = (): void => {
    lastFrameRef.current = Date.now();
    setFresh(true);
  };
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

  const showVideo = live.playable && videoOk;

  // Frame watch: requestVideoFrameCallback (Chrome 83+) where it exists, else `timeupdate` (about 4 per second).
  useEffect(() => {
    if (!showVideo) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    let stopped = false;
    let handle: number | null = null;
    const rvfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    });
    const onTimeUpdate = (): void => markFrame();
    if (typeof rvfc.requestVideoFrameCallback === 'function') {
      const tick = (): void => {
        if (stopped) return;
        markFrame();
        handle = rvfc.requestVideoFrameCallback!(tick);
      };
      handle = rvfc.requestVideoFrameCallback(tick);
    } else {
      video.addEventListener('timeupdate', onTimeUpdate);
    }
    const timer = setInterval(() => {
      if (lastFrameRef.current !== 0 && Date.now() - lastFrameRef.current > FRAME_STALE_MS) setFresh(false);
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
      video.removeEventListener('timeupdate', onTimeUpdate);
      if (handle !== null) rvfc.cancelVideoFrameCallback?.(handle);
    };
  }, [showVideo]);

  // While the camera is lost (live.waiting) the last picture stays: the video element is not removed and the live
  // screen keeps the stage. Only a picture that was really on air is held; when waiting clears the normal
  // freshness rules apply again. (The box ends a wait longer than 10 minutes by stopping the live itself.)
  const waiting = live.waiting === true;
  const flowing = showVideo && playing && fresh;
  const heldRef = useRef(false);
  if (flowing) heldRef.current = true;
  else if (!waiting || !showVideo) heldRef.current = false;
  const shown = flowing || (waiting && heldRef.current);
  const onAirRef = useRef(onAir);
  onAirRef.current = onAir;
  useEffect(() => {
    onAirRef.current?.(shown);
  }, [shown]);
  useEffect(() => () => onAirRef.current?.(false), []);

  if (!showVideo) return null;
  return (
    <div class={`live live--${mode}`} data-mode={mode} data-playing={shown ? 'true' : 'false'} aria-hidden="true">
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
        onPlaying={() => {
          markFrame();
          setPlaying(true);
        }}
        onEmptied={() => setPlaying(false)}
        onLoadedMetadata={readOrientation}
        onResize={readOrientation}
      />
      {/* Only in the blurred mode: the template's own field over the blurred picture, so the prayer screen on top
          reads exactly as it does on its normal background. */}
      <div class="live__veil" />
    </div>
  );
}

export interface LiveStripProps {
  live: LiveView;
  lang: Lang;
  /** Real pictures are on screen: the topic shows instead of "Siaran langsung sedang berjalan". */
  onAir: boolean;
}

/** The kuliah strip: the red tally, the penceramah, then the kuliah label and the topic. */
export function LiveStrip({ live, lang, onAir }: LiveStripProps) {
  const k = live.kuliah;
  return (
    <div class={`live-strip region-live-strip glass${onAir ? '' : ' is-waiting'}`} data-testid="live-strip" role="status">
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
  );
}
