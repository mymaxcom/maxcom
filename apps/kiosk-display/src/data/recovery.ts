import { dateOf, instantOf } from '@surau/core';

const DAY_MS = 24 * 60 * 60 * 1000;
const ERROR_RELOAD_MS = 30_000;
const RETRY_MS = 5 * 60 * 1000;

let currentPhase: string | null = null;
let currentTz = 'Asia/Kuala_Lumpur';

/** The data layer reports the surau's zone so the daily reload lands on 03:00 of the surau's own clock. */
export function setKioskTz(tz: string): void {
  currentTz = tz;
}

/** The kiosk data layer reports the live phase so the daily reload can wait for 'normal'. */
export function setKioskPhase(phase: string | null): void {
  currentPhase = phase;
}

/** Milliseconds until the next 03:00 on the clock of `tz` (Asia/Kuala_Lumpur by default; strictly in the future). */
export function msUntilNextDailyReload(now: Date, tz: string = 'Asia/Kuala_Lumpur'): number {
  const today = dateOf(now, tz);
  let target = instantOf(today, '03:00', tz).getTime();
  if (target <= now.getTime()) {
    target = instantOf(dateOf(new Date(instantOf(today, '00:00', tz).getTime() + DAY_MS), tz), '03:00', tz).getTime();
  }
  return target - now.getTime();
}

export interface RecoveryDeps {
  reload: () => void;
  win?: Pick<Window, 'addEventListener'>;
  sw?: Pick<ServiceWorkerContainer, 'addEventListener' | 'controller'> | null;
  now?: () => Date;
  getPhase?: () => string | null;
  /** The surau's IANA zone (the data layer's by default). */
  getTz?: () => string;
  log?: (...a: unknown[]) => void;
}

/** Self-healing for a 24/7 TV: reload after an uncaught error, daily at 03:00 KL, and when a new service worker takes over. */
export function installRecovery(deps: RecoveryDeps): () => void {
  const win = deps.win ?? window;
  const now = deps.now ?? (() => new Date());
  const getPhase = deps.getPhase ?? (() => currentPhase);
  const getTz = deps.getTz ?? (() => currentTz);
  const log = deps.log ?? ((...a: unknown[]) => console.error(...a));
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let dailyTimer: ReturnType<typeof setTimeout> | null = null;
  let reloaded = false;
  const doReload = (): void => {
    if (reloaded) return;
    reloaded = true;
    deps.reload();
  };

  const onFault = (what: string, detail: unknown): void => {
    log(`kiosk fault (${what}); reloading in ${ERROR_RELOAD_MS / 1000}s`, detail);
    if (errorTimer !== null) return;
    errorTimer = setTimeout(doReload, ERROR_RELOAD_MS);
  };
  const onError = (ev: Event): void => onFault('error', (ev as ErrorEvent).error ?? (ev as ErrorEvent).message);
  const onRejection = (ev: Event): void => onFault('unhandledrejection', (ev as PromiseRejectionEvent).reason);
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);

  const scheduleDaily = (ms: number, tz: string): void => {
    dailyTimer = setTimeout(() => {
      // The zone may have arrived (or changed) after this timer was set: only 03:00 of the surau's own clock reloads.
      if (getTz() !== tz) {
        scheduleDaily(msUntilNextDailyReload(now(), getTz()), getTz());
        return;
      }
      const phase = getPhase();
      if (phase === null || phase === 'normal') doReload();
      else scheduleDaily(RETRY_MS, tz);
    }, ms);
  };
  scheduleDaily(msUntilNextDailyReload(now(), getTz()), getTz());

  const sw = deps.sw === undefined ? (typeof navigator !== 'undefined' ? navigator.serviceWorker : null) : deps.sw;
  // First install claims the page (no earlier controller): not a new build, so do not reload.
  const hadController = !!sw?.controller;
  const onController = (): void => {
    if (hadController) doReload();
  };
  sw?.addEventListener('controllerchange', onController);

  return () => {
    if (errorTimer !== null) clearTimeout(errorTimer);
    if (dailyTimer !== null) clearTimeout(dailyTimer);
    (win as Window).removeEventListener?.('error', onError);
    (win as Window).removeEventListener?.('unhandledrejection', onRejection);
    (sw as ServiceWorkerContainer | null)?.removeEventListener?.('controllerchange', onController);
  };
}
