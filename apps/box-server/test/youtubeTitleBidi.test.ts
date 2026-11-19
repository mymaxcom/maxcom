import { describe, expect, it } from 'vitest';
import { cleanTitle } from '../src/sync/youtubeBoxCloud.ts';

describe('the YouTube channel title the flag carries', () => {
  it('loses format characters (direction overrides and isolates, zero-width) like a worker registration text, and keeps Arabic', () => {
    expect(cleanTitle('\u202ESurau \u2066Bayu\u2069 \u200BContoh')).toBe('Surau Bayu Contoh');
    expect(cleanTitle('\u2068قناة المسجد\u2069')).toBe('قناة المسجد');
    expect(cleanTitle('Surau Contoh')).toBe('Surau Contoh');
    expect(cleanTitle('\u202E\u2069')).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    // a control character is still refused, not cleaned
    expect(cleanTitle('a\u0007b')).toBe('bad');
  });
});
