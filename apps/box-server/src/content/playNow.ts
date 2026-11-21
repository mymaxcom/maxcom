import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { computeKioskState, dateOf, hijriForDisplay, tzOf } from '@surau/core';
import type { Phase } from '@surau/core';
import type { ChangeBus } from '../events.ts';
import { addDays as addCalendarDays, resolveDays } from '../prayer/resolve.ts';
import { getSettings } from '../settingsStore.ts';
import { getItem } from './store.ts';

/** The phases where the TV belongs to the prayer: azan, iqamah, solat, khutbah and tarawih. */
export const PLAY_NOW_REFUSED_PHASES: readonly Phase[] = ['azanCountdown', 'masukWaktu', 'iqamah', 'solat', 'khutbah', 'tarawih'];

export interface PlayNowDeps {
  db: DatabaseSync;
  bus: ChangeBus;
  now: () => Date;
  /** True while a live is on the TV. */
  liveOnTv: () => boolean;
  surauOf: (request: FastifyRequest) => string;
  /** A test pins the phase; the box computes it from the surau's prayer times. */
  phaseOf?: (surauId: string, at: Date) => Phase;
}

/** The phase the TV is in now (the same function the kiosk runs on the same days and settings). */
export function phaseNow(db: DatabaseSync, surauId: string, at: Date): Phase {
  const settings = getSettings(db, surauId);
  const tz = tzOf(settings);
  const today = dateOf(at, tz);
  const days = resolveDays(db, settings, addCalendarDays(today, -1), addCalendarDays(today, 2), surauId);
  // the Islamic day starts at Maghrib (tarawih belongs to the new month), as the kiosk reads it
  const month = hijriForDisplay(at, days, settings.hijriDate.adjustDays, 'maghrib', tz)?.m;
  return computeKioskState(at, days, settings, month).phase;
}

/**
 * `POST /api/content/video/<id>/play-now` (role: content:write). The TV shows that video item at once, then goes back to
 * the rotation. Refused 409 `prayer_phase` in an azan, iqamah, solat, khutbah or tarawih phase and 409 `live_running`
 * while a live is on the TV; 404 for an unknown item; 200 `{ startsAt }`. The box tells the kiosk with the `play-now`
 * event (`{ itemId }`); a second press replaces the first on the TV.
 */
export function registerPlayNowRoute(app: FastifyInstance, deps: PlayNowDeps): void {
  const { db, bus } = deps;
  app.post('/api/content/video/:id/play-now', async (request, reply) => {
    const { id } = request.params as { id: string };
    const surauId = deps.surauOf(request);
    if (getItem(db, 'video', id, surauId) === null) return reply.code(404).send({ errors: [`video ${id} not found`] });
    const at = deps.now();
    // a phase that cannot be worked out (no prayer data) is not a prayer phase: the TV is in its rotation
    let phase: Phase = 'normal';
    try {
      phase = (deps.phaseOf ?? ((s, t) => phaseNow(db, s, t)))(surauId, at);
    } catch {
      phase = 'normal';
    }
    if (PLAY_NOW_REFUSED_PHASES.includes(phase)) {
      return reply.code(409).send({ errors: ['the TV is in a prayer phase'], code: 'prayer_phase' });
    }
    if (deps.liveOnTv()) return reply.code(409).send({ errors: ['a live is on the TV'], code: 'live_running' });
    bus.emitPlayNow(id, surauId);
    return { startsAt: at.toISOString() };
  });
}
