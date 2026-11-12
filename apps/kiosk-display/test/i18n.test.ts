import { describe, expect, it } from 'vitest';
import { STRINGS } from '../src/i18n.ts';

// Kiosk language plumbing (operator decision 2026-11-03: plumbing now, more languages later).
// Every language table must carry exactly the same keys, with real text, in plain characters.

const ms = STRINGS.ms;
const en = STRINGS.en;
const FORBIDDEN = /[—–≈→←↔⇒⇐⟶⟵]/u;

/** Placeholders like {prayer}, sorted, so both languages must use the same variables. */
const vars = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('kiosk i18n tables', () => {
  it('every ms key exists in en', () => {
    const missing = Object.keys(ms).filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it('every en key exists in ms', () => {
    const missing = Object.keys(en).filter((k) => !(k in ms));
    expect(missing).toEqual([]);
  });

  it('has no empty values', () => {
    for (const [lang, table] of Object.entries(STRINGS)) {
      const empty = Object.entries(table)
        .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
        .map(([k]) => `${lang}.${k}`);
      expect(empty).toEqual([]);
    }
  });

  it('has no em dash, en dash, approximately sign or arrow characters', () => {
    for (const [lang, table] of Object.entries(STRINGS)) {
      const bad = Object.entries(table)
        .filter(([k, v]) => FORBIDDEN.test(k) || FORBIDDEN.test(v))
        .map(([k]) => `${lang}.${k}`);
      expect(bad).toEqual([]);
    }
  });

  it('uses the same {placeholders} in both languages', () => {
    const differ = Object.keys(ms)
      .filter((k) => k in en && vars(ms[k]!).join(',') !== vars(en[k]!).join(','))
      .map((k) => `${k}: ms ${vars(ms[k]!)} vs en ${vars(en[k]!)}`);
    expect(differ).toEqual([]);
  });
});
