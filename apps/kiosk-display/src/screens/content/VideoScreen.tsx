import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { VIDEO_LIMITS } from '@surau/core';
import { tilawahPlanOf } from '../../audio/tilawah.ts';
import { assetSrc } from '../../content/assets.ts';
import type { CardProps } from '../../content/ContentLayer.tsx';
import { isPreview } from '../../data/preview.ts';
import { readPlayerMessage, youtubeEmbedUrl, YT_ORIGIN } from '../../video/youtube.ts';
import { headerBottom } from './PosterScreen.tsx';

/** A video that has not played for this long (never started, or stopped to load) is given up and the rotation goes on. */
export const VIDEO_STALL_MS = 10_000;

/** A YouTube frame that has not reached the playing state this long after it was put up (a dead frame: LAN up, internet down) is given up. */
export const VIDEO_START_MS = 15_000;

/** The YouTube handshake: `listening` is repeated every second, at most this many times, until the player answers once. */
export const YT_HANDSHAKE_TRIES = 10;

/** Whether the browser says it has no internet; an unknown answer counts as online (the stall rule catches the rest). */
export function offlineNow(): boolean {
  try {
    return globalThis.navigator?.onLine === false;
  } catch {
    return false;
  }
}

/**
 * The video screen (2026.11.13): the whole stage is the picture and the header row (name and dates on one side, the
 * next-prayer chip and the clock on the other) is drawn over it, on a soft theme-tinted scrim behind the header row only.
 * No strip, no ticker, no text of its own. A 16:9 video fills the stage (cover); another shape is shown whole over a
 * blurred copy of itself. Plays to the end (at most 10 minutes), then reports `onFinished` so the rotation moves on; so it
 * does on an error, on a stall of more than 10 seconds and when a YouTube item has no internet.
 *
 * It sounds only when the item's own switch is on. It exists only while the main screen does, so a prayer phase or a live
 * removes it at once (the player is unmounted, not paused); a recitation (tilawah) removes it the same way.
 */
export function VideoScreen({ content, itemId, view, onRendered, onFinished }: CardProps) {
  const v = content.videos?.find((x) => x.id === itemId);
  const preview = isPreview();
  const tilawahBusy = tilawahPlanOf(view, content) !== null;
  const online = !offlineNow();
  const isYoutube = v?.source !== 'upload';
  const file = v?.source === 'upload' ? assetSrc(v.assetId) : null;
  const embed = v && isYoutube
    ? youtubeEmbedUrl(v.youtubeId ?? '', {
        muted: v.sound !== true,
        ...(v.source === 'rakaman' && v.startSec !== undefined ? { start: v.startSec } : {}),
        ...(v.source === 'rakaman' && v.endSec !== undefined ? { end: v.endSec } : {}),
      })
    : null;
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const playable = !!v && !failed && !tilawahBusy && (isYoutube ? embed !== null && online : file !== null);
  const rendered = playable;

  useEffect(() => {
    onRendered?.(rendered);
  }, [rendered, onRendered]);

  // One report per showing: an item that cannot play (no internet, a recitation due, a failed file) hands the screen on.
  const finished = useRef(false);
  const finish = (): void => {
    if (finished.current) return;
    finished.current = true;
    onFinished?.();
  };
  useEffect(() => {
    finished.current = false;
  }, [itemId]);
  useEffect(() => {
    if (v && !playable) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, playable]);

  // The 10-minute cap (the slot is as long as the video, at most this long).
  useEffect(() => {
    if (!playable) return undefined;
    const id = window.setTimeout(finish, VIDEO_LIMITS.maxSeconds * 1000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playable, itemId]);

  // Stall watch: `kick` is called whenever the player shows life; ten seconds without it ends the showing.
  const stall = useRef<number | null>(null);
  const kick = (ms: number = VIDEO_STALL_MS): void => {
    if (stall.current !== null) window.clearTimeout(stall.current);
    stall.current = window.setTimeout(() => {
      setFailed(true);
      finish();
    }, ms);
  };
  const calm = (): void => {
    if (stall.current !== null) window.clearTimeout(stall.current);
    stall.current = null;
  };
  useEffect(() => {
    if (!playable || preview) return calm;
    // a file that never starts to play; a YouTube frame that never reaches the playing state (the frame may load
    // an error page, or never load, with the LAN up and the internet down: navigator.onLine cannot tell)
    kick(isYoutube ? VIDEO_START_MS : VIDEO_STALL_MS);
    return calm;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playable, itemId, preview]);

  // The YouTube player talks by postMessage: ended or an error ends the showing; ten seconds of buffering is a stall.
  const frame = useRef<HTMLIFrameElement>(null);
  const heard = useRef(false);
  const shake = useRef<number | null>(null);
  const stopShake = (): void => {
    if (shake.current !== null) window.clearInterval(shake.current);
    shake.current = null;
  };
  useEffect(() => {
    heard.current = false;
    stopShake();
    if (!playable || !isYoutube || preview) return undefined;
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== YT_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const sig = readPlayerMessage(e.data);
      if (!sig) return;
      heard.current = true;
      stopShake();
      if (sig.error || sig.state === 0) {
        calm();
        finish();
      } else if (sig.state === 1) calm();
      else if (sig.state === 3 || sig.state === 5 || sig.state === -1) kick();
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      stopShake();
      calm();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playable, isYoutube, itemId, preview]);
  const shakeHands = (): void => {
    try {
      const w = frame.current?.contentWindow;
      w?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN);
      for (const ev of ['onStateChange', 'onError']) {
        w?.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: [ev], id: 1, channel: 'widget' }), YT_ORIGIN);
      }
    } catch {
      /* a frame that is gone */
    }
  };
  const onFrameLoad = (): void => {
    // The widget handshake, repeated like the official API does until the player answers once (it may not be ready
    // at the first try). The watchdog set at mount judges a player that never answers.
    stopShake();
    if (heard.current) return;
    shakeHands();
    let tries = 1;
    shake.current = window.setInterval(() => {
      if (heard.current || tries >= YT_HANDSHAKE_TRIES) {
        stopShake();
        return;
      }
      tries += 1;
      shakeHands();
    }, 1000);
  };

  // The <video> element: stopped for good when it leaves (picture and sound), not left paused behind.
  const el = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const node = el.current;
    return () => {
      if (!node) return;
      try {
        node.pause();
        node.removeAttribute('src');
        node.load();
      } catch {
        /* element already gone */
      }
    };
  }, [itemId, playable]);
  useLayoutEffect(() => {
    if (el.current) el.current.muted = v?.sound !== true;
  }, [v?.sound, itemId]);

  const stageRef = useRef<HTMLElement>(null);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return undefined;
    const measure = (): void => setTop((prev) => {
      const b = headerBottom(node);
      return b === null || (prev !== null && Math.abs(prev - b) < 0.5) ? prev : b;
    });
    measure();
    const settle = window.setTimeout(measure, 700);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearTimeout(settle);
    };
  }, [rendered, itemId]);

  if (!rendered || !v) return null;
  // A 16:9 file fills the stage (cover); any other shape stays whole (contain) over the dark backdrop.
  const shape = ratio === null || Math.abs(ratio - 16 / 9) < 0.03 ? 'cover' : 'contain';
  return (
    <article
      ref={stageRef}
      class="video-stage"
      data-card="videos"
      data-item={v.id}
      data-source={v.source}
      data-sound={v.sound === true ? 'on' : 'off'}
      style={top !== null ? `--video-top:${top.toFixed(1)}px` : undefined}
    >
      <div class="video-back" aria-hidden="true" />
      {preview ? null : file !== null ? (
        <video
          ref={el}
          class="video-el"
          data-fit={shape}
          src={file}
          autoPlay
          playsInline
          muted={v.sound !== true}
          preload="auto"
          onLoadedMetadata={(e) => {
            const n = e.currentTarget;
            if (n.videoWidth > 0 && n.videoHeight > 0) setRatio(n.videoWidth / n.videoHeight);
          }}
          onEnded={finish}
          onError={() => {
            setFailed(true);
            finish();
          }}
          onPlaying={calm}
          onTimeUpdate={calm}
          onWaiting={() => kick()}
          onStalled={() => kick()}
        />
      ) : embed !== null ? (
        <iframe
          ref={frame}
          class="video-el video-frame"
          title=""
          src={embed}
          allow="autoplay; encrypted-media"
          referrerpolicy="strict-origin-when-cross-origin"
          tabIndex={-1}
          aria-hidden="true"
          onLoad={onFrameLoad}
        />
      ) : null}
      <div class="video-scrim" aria-hidden="true" />
    </article>
  );
}
