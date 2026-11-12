import { describe, expect, it } from 'vitest';
import { resolveSettings, validateFeatureSettings, youtubeMetaFor } from '../src/index.ts';
import type { Kitab, Kuliah, Penceramah } from '../src/index.ts';

const base = { updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'u1' };
const kuliah: Kuliah = {
  ...base, id: 'k1', date: '2026-11-05', slot: 'maghrib', time: '19:45', label: 'Kuliah Maghrib',
  penceramahId: 'p1', kitabId: 'b1', topic: 'Bab Solat', status: 'aktif',
};
const penceramah: Penceramah = { ...base, id: 'p1', name: 'Ustaz Ahmad Fauzi' };
const kitab: Kitab = { ...base, id: 'b1', title: 'Riyadhus Salihin' };
const settings = resolveSettings({}).liveYoutube;
const now = new Date('2026-11-05T10:00:00Z');
const surauName = 'Surau D\'Waqaf';
const run = (over: Partial<Parameters<typeof youtubeMetaFor>[0]> = {}) =>
  youtubeMetaFor({ kuliah, penceramah, kitab, surauName, settings, now, ...over });

describe('youtubeMetaFor', () => {
  it('fills the default templates', () => {
    const m = run();
    expect(m.title).toBe('Kuliah Maghrib: Ustaz Ahmad Fauzi');
    expect(m.description).toBe('Bab Solat\nKitab: Riyadhus Salihin\nSurau D\'Waqaf, 5 November 2026');
    expect(m.privacy).toBe('unlisted');
  });
  it('drops the kitab line without a kitab', () => {
    expect(run({ kitab: null }).description).toBe('Bab Solat\nSurau D\'Waqaf, 5 November 2026');
  });
  it('drops the first line without a topic and keeps a sensible title', () => {
    const k = { ...kuliah, topic: undefined };
    expect(run({ kuliah: k }).description).toBe('Kitab: Riyadhus Salihin\nSurau D\'Waqaf, 5 November 2026');
    const t = run({ kuliah: k, settings: { ...settings, titleTemplate: '{label}: {topic}' } });
    expect(t.title).toBe('Kuliah Maghrib');
  });
  it('cuts a 140 character label to 100', () => {
    const k = { ...kuliah, label: 'a'.repeat(140) };
    expect(run({ kuliah: k, settings: { ...settings, titleTemplate: '{label}' } }).title).toHaveLength(100);
  });
  it('strips angle brackets', () => {
    const k = { ...kuliah, label: '<b>Kuliah</b>' };
    const m = run({ kuliah: k });
    expect(m.title).not.toMatch(/[<>]/);
    expect(m.title).toContain('bKuliah/b');
  });
  it('follows the privacy setting', () => {
    expect(run({ settings: { ...settings, privacy: 'unlisted' } }).privacy).toBe('unlisted');
    expect(run({ settings: { ...settings, privacy: 'private' } }).privacy).toBe('private');
  });
  it('never emits an em dash, en dash or arrow', () => {
    const m = run({ settings: { ...settings, titleTemplate: '{label} \u2014 {penceramah} \u2192 x', descriptionTemplate: 'a \u2013 b' } });
    expect(m.title + m.description).not.toMatch(/[\u2013\u2014\u2192\u2190]/);
  });
  it('an empty title becomes Kuliah <surau>', () => {
    const m = run({ settings: { ...settings, titleTemplate: '{topic}{kitab}' }, kuliah: { ...kuliah, topic: undefined }, kitab: null });
    expect(m.title).toBe('Kuliah Surau D\'Waqaf');
  });
  it('caps the description at 5000 characters', () => {
    const m = run({ settings: { ...settings, descriptionTemplate: 'x'.repeat(500) } });
    expect(m.description.length).toBeLessThanOrEqual(5000);
  });
  it('fills {time}', () => {
    expect(run({ settings: { ...settings, titleTemplate: '{time}' } }).title).toBe('19:45');
  });
});

describe('live settings rules', () => {
  const v = (k: 'liveOnKiosk' | 'liveYoutube' | 'recording', p: unknown) => validateFeatureSettings(k, p).ok;
  it('has the planned defaults', () => {
    const s = resolveSettings({});
    expect(s.liveOnKiosk).toMatchObject({ audio: false, volume: 50, showStrip: true, fit: 'cover' });
    expect(s.liveYoutube).toMatchObject({ privacy: 'unlisted', relayVideo: 'copy', maxBitrateKbps: 2500 });
    expect(s.recording).toMatchObject({ segmentMinutes: 15, keepOnDevice: true });
  });
  it('liveYoutube', () => {
    expect(v('liveYoutube', { privacy: 'secret' })).toBe(false);
    expect(v('liveYoutube', { privacy: 'unlisted' })).toBe(true);
    expect(v('liveYoutube', { maxBitrateKbps: 100 })).toBe(false);
    expect(v('liveYoutube', { maxBitrateKbps: 6001 })).toBe(false);
    expect(v('liveYoutube', { maxBitrateKbps: 500 })).toBe(true);
    expect(v('liveYoutube', { relayVideo: 'reencode' })).toBe(true);
    expect(v('liveYoutube', { relayVideo: 'x' })).toBe(false);
    expect(v('liveYoutube', { titleTemplate: '' })).toBe(false);
    expect(v('liveYoutube', { titleTemplate: 'a'.repeat(501) })).toBe(false);
    expect(v('liveYoutube', { descriptionTemplate: '' })).toBe(true);
  });
  it('recording and liveOnKiosk', () => {
    expect(v('recording', { segmentMinutes: 4 })).toBe(false);
    expect(v('recording', { segmentMinutes: 61 })).toBe(false);
    expect(v('recording', { segmentMinutes: 15 })).toBe(true);
    expect(v('liveOnKiosk', { volume: 101 })).toBe(false);
    expect(v('liveOnKiosk', { fit: 'stretch' })).toBe(false);
    expect(v('liveOnKiosk', { fit: 'contain' })).toBe(true);
  });
});
