// Runs the health check of an uploaded theme: after the pack is ready and after every change of screen, once the layout
// has settled; again every 60 s while the pack is on the stage; and after an animation or a transition ends (a pack may start
// one late). A failure puts the stage back on the base theme and tells the box ("Tema tidak sah").
import { useEffect, useRef } from 'preact/hooks';
import type { StageScreenId } from '../screens/screenId.ts';
import { applyPlates, checkScreenHealth, HEALTH_DELAY_MS, HEALTH_INTERVAL_MS, realMeasure } from './health.ts';
import type { ResolvedTheme } from './index.ts';

export const THEME_HEALTH_PATH = '/api/kiosk/theme-health';
/**
 * Events that say an animation or a transition just finished (or was cut): the check runs again once things have been
 * quiet for a moment. It waits for the end, not the start, so a fade-in of the base theme is never judged half way.
 */
export const MOTION_EVENTS = ['animationend', 'animationcancel', 'transitionend', 'transitioncancel'] as const;
export const MOTION_QUIET_MS = 700;
/** A failure rejects the pack only when the check fails again at least this long after the first failure (a fade or a settle in progress is not a fault). */
export const HEALTH_RECHECK_MS = 3000;
/** A change of the stage's data-* attributes starts a check once things have been quiet this long. */
export const ATTR_QUIET_MS = 200;
/** A failure report that did not get through is posted again after each of these waits (then given up on). */
export const REPORT_BACKOFF_MS: readonly number[] = [5_000, 20_000, 60_000, 300_000];

/** Posts a report; on a network error or a server error it tries again after each wait of REPORT_BACKOFF_MS. */
function post(body: unknown, attempt = 0): void {
  const again = (): void => {
    const wait = REPORT_BACKOFF_MS[attempt];
    if (wait !== undefined) setTimeout(() => post(body, attempt + 1), wait);
  };
  try {
    void fetch(THEME_HEALTH_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((res) => {
        // 429 means the box already has a report of this kind this minute: not worth another try
        if (!res.ok && res.status !== 429 && res.status < 400) again();
        else if (!res.ok && res.status >= 500) again();
      })
      .catch(again);
  } catch {
    again();
  }
}

export function useThemeHealth(o: {
  /** An uploaded theme is on the stage with its stylesheet loaded (never for a built-in theme). */
  active: boolean;
  theme: ResolvedTheme;
  screen: StageScreenId;
  logoSet: boolean;
  reject: (reason: string) => void;
  /** Tell the box (not the preview). */
  report: boolean;
}): void {
  const reported = useRef<string | null>(null);
  const version = o.theme.pack?.version ?? 0;
  useEffect(() => {
    if (!o.active || o.theme.pack === null) return undefined;
    const identity = `${o.theme.name}@${version}`;
    let done = false;
    /** When the check first failed in the current run of failures; null while it passes. */
    let firstFailAt: number | null = null;
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      if (done) return;
      const stage = document.querySelector('.stage');
      if (stage === null) return;
      try {
        applyPlates(stage);
      } catch {
        /* a plate is an extra: the check below still runs */
      }
      const result = checkScreenHealth(stage, o.screen, {
        logoSet: o.logoSet,
        base: o.theme.base,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        measure: realMeasure,
      });
      if (!result.ok) {
        const now = Date.now();
        if (firstFailAt === null) {
          // the first failure: look again in a moment, the layout may be mid-animation
          firstFailAt = now;
          if (recheck !== undefined) clearTimeout(recheck);
          recheck = setTimeout(run, HEALTH_RECHECK_MS);
          return;
        }
        if (now - firstFailAt < HEALTH_RECHECK_MS) return; // too soon to be a second, separate look
        done = true;
        if (recheck !== undefined) clearTimeout(recheck);
        if (o.report) post({ theme: o.theme.name, version, screen: o.screen, ok: false, failed: result.failed });
        o.reject('health');
      } else {
        firstFailAt = null;
        if (recheck !== undefined) { clearTimeout(recheck); recheck = undefined; }
        if (reported.current !== identity) {
          // the first pass after a load says all is well, once
          reported.current = identity;
          if (o.report) post({ theme: o.theme.name, version, screen: o.screen, ok: true, failed: [] });
        }
      }
    };
    const timer = setTimeout(run, HEALTH_DELAY_MS);
    const every = setInterval(run, HEALTH_INTERVAL_MS);
    let motion: ReturnType<typeof setTimeout> | undefined;
    const onMotion = (): void => {
      if (motion !== undefined) clearTimeout(motion);
      motion = setTimeout(() => {
        motion = undefined;
        run();
      }, MOTION_QUIET_MS);
    };
    for (const e of MOTION_EVENTS) document.addEventListener(e, onMotion, true);
    // Any change of the stage's own attributes (phase, dim, live, screen, ...) can switch a pack's conditional rules on: look again.
    let attr: ReturnType<typeof setTimeout> | undefined;
    const observed = document.querySelector('.stage');
    const observer = typeof MutationObserver === 'function' && observed !== null
      ? new MutationObserver((records) => {
          if (!records.some((r) => r.attributeName !== null && r.attributeName.startsWith('data-') && r.attributeName !== 'data-pack')) return;
          if (attr !== undefined) clearTimeout(attr);
          attr = setTimeout(() => { attr = undefined; run(); }, ATTR_QUIET_MS);
        })
      : null;
    observer?.observe(observed!, { attributes: true });
    return () => {
      done = true;
      clearTimeout(timer);
      clearInterval(every);
      if (recheck !== undefined) clearTimeout(recheck);
      if (attr !== undefined) clearTimeout(attr);
      observer?.disconnect();
      if (motion !== undefined) clearTimeout(motion);
      for (const e of MOTION_EVENTS) document.removeEventListener(e, onMotion, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.active, o.theme.name, version, o.screen, o.logoSet]);
}
