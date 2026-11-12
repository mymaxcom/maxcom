import { describe, expect, it } from 'vitest';
import { HIJRI_MONTHS, RECITERS, SURAHS, YOUTUBE_PLACEHOLDERS } from '../src/features/lists.ts';

describe('lists', () => {
  it('has 114 surahs with the right verse counts', () => {
    expect(SURAHS).toHaveLength(114);
    SURAHS.forEach((s, i) => expect(s.n).toBe(i + 1));
    expect(SURAHS[0]!.ayat).toBe(7);
    expect(SURAHS[1]!.ayat).toBe(286);
    expect(SURAHS[17]!.nameMs).toBe('Al-Kahf');
    expect(SURAHS.reduce((n, s) => n + s.ayat, 0)).toBe(6236);
  });
  it('names the twelve Hijri months in BM and EN', () => {
    expect(HIJRI_MONTHS.ms).toHaveLength(12);
    expect(HIJRI_MONTHS.en).toHaveLength(12);
    expect(HIJRI_MONTHS.ms[8]).toBe('Ramadan');
  });
  it('lists the reciters with an other entry last, folders unique and valid', () => {
    expect(RECITERS).toHaveLength(6);
    expect(RECITERS[RECITERS.length - 1]!.folder).toBe('other');
    expect(RECITERS[0]!.folder).toBe('Husary_64kbps');
    expect(new Set(RECITERS.map((r) => r.folder)).size).toBe(RECITERS.length);
    for (const r of RECITERS) expect(r.folder).toMatch(/^[A-Za-z0-9_]{3,64}$/);
  });
  it('lists the placeholders youtubeMeta understands', () => {
    expect(YOUTUBE_PLACEHOLDERS.map((p) => p.key)).toEqual(['label', 'penceramah', 'topic', 'kitab', 'surau', 'date', 'time']);
  });
});
