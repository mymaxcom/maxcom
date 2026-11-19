import { describe, expect, it } from 'vitest';
import { resolveSettings, validateContent, parseYoutubeId, videoSlotSeconds, VIDEO_LIMITS, ORDERED_FEATURES } from '../src/index.ts';
import type { KioskContent, KioskVideo } from '../src/index.ts';
import { buildRotation } from '../src/content/rotation.ts';

const ASSET = 'a'.repeat(64);
const good = { title: 'Salam', source: 'upload', assetId: ASSET, days: ['umum'], order: 1, durationSec: 90 };
const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'local' };

describe('video schema', () => {
  it('accepts an upload, a YouTube video and a recording clip', () => {
    expect(validateContent('video', good).ok).toBe(true);
    expect(validateContent('video', { title: 'Y', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', days: ['isnin'], order: 2, sound: true }).ok).toBe(true);
    expect(validateContent('video', { title: 'R', source: 'rakaman', youtubeId: 'dQw4w9WgXcQ', startSec: 10, endSec: 70, days: ['umum'], order: 3 }).ok).toBe(true);
  });
  it('keeps sound absent when absent (silent by default)', () => {
    const r = validateContent('video', good);
    expect(r.ok && 'sound' in r.value).toBe(false);
  });
  it('refuses a bad source, a missing or foreign reference and a bad id', () => {
    expect(validateContent('video', { ...good, source: 'tv' }).ok).toBe(false);
    expect(validateContent('video', { ...good, assetId: undefined }).ok).toBe(false);
    expect(validateContent('video', { ...good, assetId: 'xyz' }).ok).toBe(false);
    expect(validateContent('video', { ...good, youtubeId: 'dQw4w9WgXcQ' }).ok).toBe(false);
    expect(validateContent('video', { title: 'Y', source: 'youtube', youtubeId: 'short', days: ['umum'], order: 1 }).ok).toBe(false);
    expect(validateContent('video', { title: 'Y', source: 'youtube', assetId: ASSET, days: ['umum'], order: 1 }).ok).toBe(false);
  });
  it('caps an uploaded video at the length limit and refuses an empty title or a backwards clip', () => {
    expect(validateContent('video', { ...good, durationSec: VIDEO_LIMITS.maxSeconds + 1 }).ok).toBe(false);
    expect(validateContent('video', { ...good, title: '' }).ok).toBe(false);
    expect(validateContent('video', { title: 'R', source: 'rakaman', youtubeId: 'dQw4w9WgXcQ', startSec: 70, endSec: 10, days: ['umum'], order: 3 }).ok).toBe(false);
  });
  it('refuses an unknown field and a non-boolean sound', () => {
    expect(validateContent('video', { ...good, extra: 1 }).ok).toBe(false);
    expect(validateContent('video', { ...good, sound: 'yes' }).ok).toBe(false);
  });
});

describe('parseYoutubeId', () => {
  const id = 'dQw4w9WgXcQ';
  it.each([
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?t=5`,
    `https://m.youtube.com/watch?v=${id}&list=PL1`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `youtube.com/live/${id}?feature=share`,
  ])('reads %s', (input) => expect(parseYoutubeId(input)).toBe(id));
  it.each(['', 'hello', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/playlist?list=PL1', 'javascript:alert(1)', 'https://youtu.be/short'])(
    'refuses %s', (input) => expect(parseYoutubeId(input)).toBeNull(),
  );
});

describe('video rotation', () => {
  const v = (id: string, order: number, extra: Partial<KioskVideo> = {}): KioskVideo => ({
    ...base, id, title: id, source: 'upload', assetId: ASSET, days: ['umum'], order, durationSec: 60, ...extra,
  });
  const content = (videos: KioskVideo[]): KioskContent => ({
    date: '2026-11-03', kuliah: [], pengumuman: [], ticker: [], posters: [], programKhas: [], takwim: [], hadisToday: [], worldTimes: [], tugasan: [],
    ayat: { today: null, tomorrow: null }, zikir: [], tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' }, videos,
  });
  const now = new Date('2026-11-03T04:00:00Z');
  it('gives each visible video a slot as long as the video', () => {
    const slots = buildRotation(content([v('b', 2, { durationSec: 120 }), v('a', 1)]), resolveSettings({}), now);
    expect(slots.filter((s) => s.feature === 'videos').map((s) => [s.itemId, s.durationSeconds])).toEqual([['a', 60], ['b', 120]]);
  });
  it('caps a slot at 10 minutes, cuts a clip, and uses the cap when the length is unknown', () => {
    expect(videoSlotSeconds({ durationSec: 5000 })).toBe(600);
    expect(videoSlotSeconds({})).toBe(600);
    expect(videoSlotSeconds({ startSec: 10, endSec: 70 })).toBe(60);
  });
  it('honours days and dates and the feature switch; an older box (no videos) has none', () => {
    const s0 = resolveSettings({});
    expect(buildRotation(content([v('a', 1, { days: ['sabtu'] })]), s0, now).some((s) => s.feature === 'videos')).toBe(false); // 2026-11-03 is a Tuesday
    expect(buildRotation(content([v('a', 1, { to: '2026-11-02' })]), s0, now).some((s) => s.feature === 'videos')).toBe(false);
    expect(buildRotation(content([v('a', 1)]), resolveSettings({ videos: { enabled: false } }), now).some((s) => s.feature === 'videos')).toBe(false);
    const old = content([]);
    delete (old as { videos?: unknown }).videos;
    expect(buildRotation(old, s0, now).some((s) => s.feature === 'videos')).toBe(false);
  });
  it('is one of the ordered features', () => {
    expect(ORDERED_FEATURES).toContain('videos');
  });
});
