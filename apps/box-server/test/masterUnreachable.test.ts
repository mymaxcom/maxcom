import { describe, expect, it } from 'vitest';
import { MASTER_UNREACHABLE_MS, masterUnreachableSince } from '../src/follow/kioskHook.ts';
import type { FollowStore } from '../src/follow/store.ts';
import type { Mirror, MirrorState } from '../src/follow/mirror.ts';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const H = 3_600_000;
const iso = (ago: number): string => new Date(NOW.getTime() - ago).toISOString();

const follow = (present: boolean, linkedAt = iso(30 * H)): FollowStore => ({ present: () => present, read: () => (present ? { linkedAt } : null) }) as unknown as FollowStore;
const mirror = (s: Partial<MirrorState>): Mirror =>
  ({ state: () => ({ connected: false, lastOkAt: null, masterVersion: null, needsUpdate: false, removed: false, ...s }) }) as unknown as Mirror;
const since = (f: FollowStore, m: Mirror): string | null => masterUnreachableSince(f, m, () => NOW);

describe('masterUnreachableSince (O23, follower side)', () => {
  it('is 6 hours', () => {
    expect(MASTER_UNREACHABLE_MS).toBe(6 * H);
  });
  it('is null while the master answers, however old the last contact is', () => {
    expect(since(follow(true), mirror({ connected: true, lastOkAt: iso(50 * H) }))).toBeNull();
  });
  it('is null for 5 hours 59 minutes and exactly the last answer after 6 hours', () => {
    expect(since(follow(true), mirror({ lastOkAt: iso(6 * H - 60_000) }))).toBeNull();
    expect(since(follow(true), mirror({ lastOkAt: iso(6 * H) }))).toBe(iso(6 * H));
    expect(since(follow(true), mirror({ lastOkAt: iso(20 * H) }))).toBe(iso(20 * H));
  });
  it('counts from the day of the link when the master never answered', () => {
    expect(since(follow(true, iso(2 * H)), mirror({ lastOkAt: null }))).toBeNull();
    expect(since(follow(true, iso(9 * H)), mirror({ lastOkAt: null }))).toBe(iso(9 * H));
  });
  it('is null on a main box and after the master ordered the box off', () => {
    expect(since(follow(false), mirror({ lastOkAt: iso(20 * H) }))).toBeNull();
    expect(since(follow(true), mirror({ lastOkAt: iso(20 * H), removed: true }))).toBeNull();
  });
  it('is null for an unreadable time', () => {
    expect(since(follow(true), mirror({ lastOkAt: 'nonsense' }))).toBeNull();
  });
});
