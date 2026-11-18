import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatGlobalRef, formatRef, parseRef } from '../src/auth/ref.ts';
import type { RefKind, RefSrc } from '../src/auth/ref.ts';

// The same vectors the Dart twin reads (apps/surau-app test, task A1).
const vectors = JSON.parse(readFileSync(new URL('../../../apps/box-server/test/fixtures/ref-vectors.json', import.meta.url), 'utf8')) as {
  format: Array<{ kind: RefKind; src: RefSrc; no: number; short: string; global: string }>;
  parse: Array<{ text: string; null?: boolean; surauId?: string | null; kind?: RefKind | null; src?: RefSrc; no?: number }>;
};

describe('[PP-S8] ref format and parse', () => {
  it('[PP-S8] formatRef and formatGlobalRef follow the vectors', () => {
    for (const v of vectors.format) {
      expect(formatRef(v.kind, v.src, v.no)).toBe(v.short);
      expect(formatGlobalRef('surau-contoh', v.kind, v.src, v.no)).toBe(v.global);
    }
    expect(formatRef('user', 'b', 1)).toBe('U-0001');
    expect(formatRef('device', 'c', 12)).toBe('D-C0012');
    expect(formatRef('user', 'b', 12345)).toBe('U-12345');
  });

  it('[PP-S8] formatRef refuses a number below 1 or not an integer', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => formatRef('user', 'b', n)).toThrow();
  });

  it('[PP-S8] parseRef follows the vectors', () => {
    for (const v of vectors.parse) {
      const got = parseRef(v.text);
      if (v.null === true) expect(got, JSON.stringify(v.text)).toBeNull();
      else expect(got, JSON.stringify(v.text)).toEqual({ surauId: v.surauId, kind: v.kind, src: v.src, no: v.no });
    }
  });

  it('[PP-S8] a formatted ref parses back to its parts', () => {
    for (const v of vectors.format) {
      expect(parseRef(v.short)).toEqual({ surauId: null, kind: v.kind, src: v.src, no: v.no });
      expect(parseRef(v.global)).toEqual({ surauId: 'surau-contoh', kind: v.kind, src: v.src, no: v.no });
    }
  });
});
