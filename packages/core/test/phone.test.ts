import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatPhone, normalisePhone } from '../src/auth/phone.ts';

// The same vectors the Dart twin reads (apps/surau-app test, task A1).
const vectors = JSON.parse(readFileSync(new URL('../../../apps/box-server/test/fixtures/phone-vectors.json', import.meta.url), 'utf8')) as {
  normalise: Array<{ raw: string; e164: string | null }>;
  format: Array<{ e164: string; text: string }>;
};

describe('[PP-S10] phone normalisation', () => {
  it('[PP-S10] normalisePhone follows the vectors', () => {
    for (const v of vectors.normalise) expect(normalisePhone(v.raw), JSON.stringify(v.raw)).toBe(v.e164);
  });

  it('[PP-S10] the spec examples hold: four Malaysian forms give one number, +65 keeps its own code, junk is null', () => {
    for (const raw of ['012-000 0001', '+60 12-000 0001', '60120000001', '0060 12 000 0001']) expect(normalisePhone(raw)).toBe('+60120000001');
    expect(normalisePhone('+65 8123 4567')).toBe('+6581234567');
    // a 0 right after the +60 country code is refused (built from parts: the tree holds no other +60 number)
    for (const raw of ['12345', '+0123456789', 'abc', `+${'60'}012000001`]) expect(normalisePhone(raw)).toBeNull();
  });

  it('[PP-S10] a long or odd input is refused, never thrown on', () => {
    for (const raw of ['+'.repeat(5), '1'.repeat(80), '\u0000012345678', '012-000 0001 ext 5', 'a'.repeat(41)]) expect(normalisePhone(raw)).toBeNull();
    expect(normalisePhone(undefined as unknown as string)).toBeNull();
  });

  it('[PP-S10] formatPhone follows the vectors and a normalised number formats back to itself', () => {
    for (const v of vectors.format) {
      expect(formatPhone(v.e164)).toBe(v.text);
      expect(normalisePhone(v.text)).toBe(v.e164);
    }
  });
});
