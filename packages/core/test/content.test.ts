import { describe, expect, it } from 'vitest';
import { validateContent, newId, isContentKind, CONTENT_KINDS } from '../src/content/schema.ts';
import type { ContentKind } from '../src/content/types.ts';

describe('CONTENT_KINDS', () => {
  it('lists every content kind', () => {
    expect(new Set(CONTENT_KINDS).size).toBe(CONTENT_KINDS.length);
    expect(CONTENT_KINDS).toContain('penceramah');
    expect(CONTENT_KINDS).toContain('kitab');
    expect(CONTENT_KINDS).toContain('kuliah');
    expect(CONTENT_KINDS).toContain('pengumuman');
    expect(CONTENT_KINDS).toContain('ticker');
    expect(CONTENT_KINDS).toContain('poster');
    expect(CONTENT_KINDS).toContain('programKhas');
    expect(CONTENT_KINDS).toContain('takwim');
    expect(CONTENT_KINDS).toContain('hadis');
    expect(CONTENT_KINDS).toContain('worldTime');
    expect(CONTENT_KINDS).toContain('petugas');
    expect(CONTENT_KINDS).toContain('tugasan');
    expect(CONTENT_KINDS).toContain('zikir');
    expect(CONTENT_KINDS).toContain('tilawahSlot');
  });

  it('isContentKind guards kinds', () => {
    expect(isContentKind('kuliah')).toBe(true);
    expect(isContentKind('nosuch')).toBe(false);
  });
});

describe('validateContent', () => {
  it('accepts a valid kuliah', () => {
    expect(validateContent('kuliah', { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: 'p1', status: 'aktif' }).ok).toBe(true);
  });

  it('rejects bad dates', () => {
    expect(validateContent('kuliah', { date: '2026-13-05', slot: 'maghrib', time: '19:15', label: 'x', penceramahId: 'p1', status: 'aktif' })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/date/)],
    });
  });

  it('rejects from after to', () => {
    expect(validateContent('pengumuman', { title: 'Gotong-royong', body: 'Sabtu ini', from: '2026-11-10', to: '2026-11-01', priority: 2 })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/from.*to/)],
    });
  });

  it('accepts a poster with umum and a weekday', () => {
    expect(validateContent('poster', { title: 'Poster Maulidur Rasul', assetId: 'a'.repeat(64), days: ['umum', 'jumaat'], order: 1 }).ok).toBe(true);
  });

  it('rejects poster with invalid day key', () => {
    expect(validateContent('poster', { title: 'Poster 1', assetId: 'a'.repeat(64), days: ['monday'], order: 1 }).ok).toBe(false);
  });

  it('requires a poster title of 1..80 characters (trimmed)', () => {
    const base = { assetId: 'a'.repeat(64), days: ['umum'], order: 1 };
    expect(validateContent('poster', base).ok).toBe(false);
    expect(validateContent('poster', { ...base, title: '' }).ok).toBe(false);
    expect(validateContent('poster', { ...base, title: '   ' }).ok).toBe(false);
    expect(validateContent('poster', { ...base, title: 5 }).ok).toBe(false);
    expect(validateContent('poster', { ...base, title: 'x'.repeat(81) }).ok).toBe(false);
    expect(validateContent('poster', { ...base, title: 'x'.repeat(80) }).ok).toBe(true);
    const r = validateContent('poster', { ...base, title: '  Poster Jumaat  ' });
    expect(r.ok && (r.value as { title: string }).title).toBe('Poster Jumaat');
    const missing = validateContent('poster', base);
    expect(!missing.ok && missing.errors.some((e) => e.startsWith('title'))).toBe(true);
  });

  it('accepts a valid world time', () => {
    expect(validateContent('worldTime', { city: 'Makkah', tz: 'Asia/Riyadh', order: 1 }).ok).toBe(true);
  });

  it('rejects a hostile timezone', () => {
    expect(validateContent('worldTime', { city: 'Makkah', tz: '../etc', order: 1 }).ok).toBe(false);
    for (const tz of ['America/Argentina/Buenos_Aires', 'America/Indiana/Indianapolis', 'Etc/GMT+5', 'UTC']) {
      expect(validateContent('worldTime', { city: 'X', tz, order: 1 }).ok, tz).toBe(true);
    }
    for (const tz of ['A/B/C/D', 'Asia//Riyadh', 'Asia/Riyadh/', '/Asia/Riyadh', 'Nowhere/Land', 'a/../b', 'Asia/Riy adh', '']) {
      expect(validateContent('worldTime', { city: 'X', tz, order: 1 }).ok, tz).toBe(false);
    }
  });

  it('accepts a valid tilawah slot', () => {
    expect(validateContent('tilawahSlot', { days: ['jumaat'], before: 'subuh', minutesBefore: 15, surah: 18, enabled: true }).ok).toBe(true);
  });

  it('rejects surah out of range', () => {
    expect(validateContent('tilawahSlot', { days: ['daily'], before: 'subuh', minutesBefore: 15, surah: 115, enabled: true }).ok).toBe(false);
  });

  it('limits text fields to 2000 characters', () => {
    expect(validateContent('hadis', { textMs: 'x'.repeat(2001), source: 'Riwayat Muslim' }).ok).toBe(false);
    expect(validateContent('hadis', { textMs: 'x'.repeat(2000), source: 'Riwayat Muslim' }).ok).toBe(true);
  });

  it('limits ticker text to 300 characters', () => {
    expect(validateContent('ticker', { text: 'x'.repeat(301), from: '2026-11-01', to: '2026-11-30' }).ok).toBe(false);
    expect(validateContent('ticker', { text: 'x'.repeat(300), from: '2026-11-01', to: '2026-11-30' }).ok).toBe(true);
  });

  it('rejects unknown kinds', () => {
    expect(validateContent('nosuch', {})).toMatchObject({ ok: false });
  });

  it('rejects unknown keys', () => {
    const valid = { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: 'p1', status: 'aktif' };
    expect(validateContent('kuliah', { ...valid, extra: 1 }).ok).toBe(false);
  });

  it('trims text fields', () => {
    const r = validateContent('pengumuman', { title: '  Hello  ', body: 'Body', from: '2026-11-01', to: '2026-11-30', priority: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.title).toBe('Hello');
  });

  it('accepts id/updatedAt/updatedBy if present', () => {
    expect(validateContent('penceramah', { id: 'p1', updatedAt: '2026-11-03T10:00:00Z', updatedBy: 'u1', name: 'Ustaz Ahmad' }).ok).toBe(true);
  });

  it('validates every kind with minimal valid data', () => {
    const cases: [ContentKind, object][] = [
      ['penceramah', { name: 'Ustaz Ahmad' }],
      ['kitab', { title: 'Riyad us-Salihin' }],
      ['kuliah', { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: 'p1', status: 'aktif' }],
      ['pengumuman', { title: 'A', body: 'B', from: '2026-11-01', to: '2026-11-30', priority: 1 }],
      ['ticker', { text: 'A', from: '2026-11-01', to: '2026-11-30' }],
      ['poster', { title: 'Poster 1', assetId: 'a'.repeat(64), days: ['umum'], order: 1 }],
      ['programKhas', { title: 'A', at: '2026-11-05T20:30', showFrom: '2026-11-01', showTo: '2026-11-30', status: 'aktif' }],
      ['takwim', { date: '2026-11-05', title: 'A' }],
      ['hadis', { textMs: 'A', source: 'B' }],
      ['worldTime', { city: 'Makkah', tz: 'Asia/Riyadh', order: 1 }],
      ['petugas', { name: 'A' }],
      ['tugasan', { date: '2026-11-05', role: 'imam', petugasId: 'p1' }],
      ['zikir', { order: 1, textAr: 'A', textMs: 'B' }],
      ['tilawahSlot', { days: ['daily'], before: 'subuh', minutesBefore: 15, surah: 1, enabled: true }],
    ];
    for (const [kind, data] of cases) {
      const r = validateContent(kind, data);
      expect(r.ok, `${kind} should be valid: ${!r.ok ? (r as any).errors.join(', ') : ''}`).toBe(true);
    }
  });

  it('rejects invalid enums and ranges', () => {
    expect(validateContent('kuliah', { date: '2026-11-05', slot: 'duha', time: '19:15', label: 'x', penceramahId: 'p1', status: 'aktif' }).ok).toBe(false);
    expect(validateContent('kuliah', { date: '2026-11-05', slot: 'maghrib', time: '25:00', label: 'x', penceramahId: 'p1', status: 'aktif' }).ok).toBe(false);
    expect(validateContent('pengumuman', { title: 'A', body: 'B', from: '2026-11-01', to: '2026-11-30', priority: 4 }).ok).toBe(false);
    expect(validateContent('programKhas', { title: 'A', at: '2026-11-05T20:30', showFrom: '2026-11-01', showTo: '2026-11-30', status: 'tunda' }).ok).toBe(false);
    expect(validateContent('tugasan', { date: '2026-11-05', role: 'pembersih', petugasId: 'p1' }).ok).toBe(false);
    expect(validateContent('tilawahSlot', { days: ['daily'], before: 'zohor', minutesBefore: 0, surah: 1, enabled: true }).ok).toBe(false);
    expect(validateContent('tilawahSlot', { days: ['daily'], before: 'zohor', minutesBefore: 121, surah: 1, enabled: true }).ok).toBe(false);
  });
});

describe('newId', () => {
  it('returns a uuid', () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
