import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { MAX_CLOCK_OFFSET_MS, SettingsError, correctedStamp, getSettings, putFeature, putFeatureIn } from '../src/settingsStore.ts';

/**
 * 2026.11.15 Siaran langsung revamp, the YouTube lane's share of the settings store:
 *  - G3: the stamp of a device's signed edit is corrected by the device's clock offset before the per-field compare,
 *    so a save from a phone whose clock is behind is not dropped silently.
 *  - G8: a replicated entry that carries a setting this version does not know lands without that setting, instead
 *    of being refused whole.
 */

const SURAU = 'sdm';
const MIN = 60_000;
const T0 = Date.parse('2026-11-23T12:00:00.000Z');

let db: DatabaseSync;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

/** A signed op from the phone as `sync/apply.ts` hands it to the store: the stamp is the PHONE's clock. */
function phoneOp(patch: Record<string, unknown>, phoneClockMs: number, clockOffsetMs?: number) {
  const editedAt = new Date(phoneClockMs).toISOString();
  const meta = { deviceId: 'dev-phone', origin: 'device', opId: `op-${phoneClockMs}`, editedAt, rev: `${editedAt}|dev-phone`, syncedAt: new Date().toISOString() };
  return putFeatureIn(db, 'liveYoutube', patch, 'user:u1', 'dev-phone', meta, clockOffsetMs === undefined ? undefined : { clockOffsetMs }, SURAU);
}
const nextLiveOn = (): boolean => getSettings(db, SURAU).liveYoutube.nextLiveOn;

describe('G3: a settings stamp is corrected by the device clock offset', () => {
  it('an op from a phone 5 minutes behind still wins over an older stored value', () => {
    // 12:00 box time: another admin sets the choice on the box
    putFeature(db, 'liveYoutube', { nextLiveOn: true }, 'user:u2', 'dev-other', SURAU);
    // 12:02 box time: the phone, whose clock reads 11:57, switches it off
    vi.setSystemTime(new Date(T0 + 2 * MIN));
    const put = phoneOp({ nextLiveOn: false }, T0 + 2 * MIN - 5 * MIN, 5 * MIN);
    expect(put).toEqual({ applied: true, skipped: [] });
    expect(nextLiveOn()).toBe(false);
  });

  it('without the offset the same op is dropped (the old behaviour, kept for an older app)', () => {
    putFeature(db, 'liveYoutube', { nextLiveOn: true }, 'user:u2', 'dev-other', SURAU);
    vi.setSystemTime(new Date(T0 + 2 * MIN));
    const put = phoneOp({ nextLiveOn: false }, T0 + 2 * MIN - 5 * MIN);
    expect(put).toEqual({ applied: false, skipped: ['nextLiveOn'] });
    expect(nextLiveOn()).toBe(true);
  });

  it('a truly older op still loses, offset or not', () => {
    // the phone made its edit at 11:58 real time (its clock read 11:53) and sent it late
    putFeature(db, 'liveYoutube', { nextLiveOn: true }, 'user:u2', 'dev-other', SURAU);
    vi.setSystemTime(new Date(T0 + 10 * MIN));
    const put = phoneOp({ nextLiveOn: false }, T0 - 2 * MIN - 5 * MIN, 5 * MIN);
    expect(put).toEqual({ applied: false, skipped: ['nextLiveOn'] });
    expect(nextLiveOn()).toBe(true);
  });

  it('a phone whose clock is ahead is corrected back: its old edit does not beat a newer one', () => {
    // the phone (10 minutes ahead) edited at 11:55 real time; its stamp says 12:05
    putFeature(db, 'liveYoutube', { nextLiveOn: true }, 'user:u2', 'dev-other', SURAU);
    vi.setSystemTime(new Date(T0 + MIN));
    const put = phoneOp({ nextLiveOn: false }, T0 - 5 * MIN + 10 * MIN, -10 * MIN);
    expect(put.applied).toBe(false);
    expect(nextLiveOn()).toBe(true);
  });

  it('the corrected stamp is bounded and never passes the box clock', () => {
    const now = new Date(T0);
    const at = (ms: number): string => new Date(ms).toISOString();
    expect(correctedStamp(at(T0 - 10 * MIN), 5 * MIN, now)).toBe(at(T0 - 5 * MIN));
    // a lying offset cannot reach the future: capped at now
    expect(correctedStamp(at(T0 - MIN), 60 * MIN, now)).toBe(at(T0));
    // and is cut to 24 hours
    expect(correctedStamp(at(T0 - 72 * 3_600_000), 1e12, now)).toBe(at(T0 - 72 * 3_600_000 + MAX_CLOCK_OFFSET_MS));
    expect(correctedStamp(at(T0), -1e12, now)).toBe(at(T0 - MAX_CLOCK_OFFSET_MS));
    // not a whole number, or nothing: the stamp is left as it is
    for (const bad of [undefined, null, '300000', 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0]) expect(correctedStamp(at(T0 - MIN), bad, now)).toBe(at(T0 - MIN));
    expect(correctedStamp('not a time', 5 * MIN, now)).toBe('not a time');
  });

  it('a local write is never touched by an offset', () => {
    putFeatureIn(db, 'liveYoutube', { nextLiveOn: false }, 'user:u1', 'dev-phone', undefined, { clockOffsetMs: 5 * MIN }, SURAU);
    expect(nextLiveOn()).toBe(false);
    const row = db.prepare("SELECT edited_at FROM settings WHERE feature = 'liveYoutube'").get()!;
    expect(row.edited_at).toBe(new Date(T0).toISOString());
  });
});

describe('G8: a replicated entry with a setting this version does not know', () => {
  const feed = (patch: Record<string, unknown>, trusted: boolean) => {
    const editedAt = new Date().toISOString();
    return putFeatureIn(db, 'liveYoutube', patch, 'user:u9', 'dev-box-two', { deviceId: 'dev-box-two', origin: 'feed', editedAt, rev: `${editedAt}|dev-box-two`, syncedAt: editedAt, ...(trusted ? { trusted: true } : {}) }, undefined, SURAU);
  };

  it('lands without the unknown setting instead of being refused whole', () => {
    const put = feed({ nextLiveOn: false, privacy: 'private', settingOfALaterVersion: 5 }, true);
    expect(put.applied).toBe(true);
    const s = getSettings(db, SURAU).liveYoutube as unknown as Record<string, unknown>;
    expect(s).toMatchObject({ nextLiveOn: false, privacy: 'private' });
    expect(s.settingOfALaterVersion).toBeUndefined();
    expect(String(db.prepare("SELECT json FROM settings WHERE feature = 'liveYoutube'").get()!.json)).not.toContain('settingOfALaterVersion');
  });

  it('a known setting with a bad value is still refused, replicated or not', () => {
    expect(() => feed({ privacy: 'everyone', settingOfALaterVersion: 5 }, true)).toThrow(SettingsError);
  });

  it("a device's own edit and a local route keep the strict refusal of an unknown setting", () => {
    expect(() => feed({ nextLiveOn: false, settingOfALaterVersion: 5 }, false)).toThrow(SettingsError);
    expect(() => putFeature(db, 'liveYoutube', { settingOfALaterVersion: 5 }, 'user:u1', 'dev-phone', SURAU)).toThrow(SettingsError);
  });
});
