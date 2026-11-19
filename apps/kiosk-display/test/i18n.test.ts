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

// W14: Arabic is a full third TV language. Every key of every language is in every other language.
describe('kiosk i18n tables: every language has every key', () => {
  const langs = Object.keys(STRINGS) as (keyof typeof STRINGS)[];

  it('the TV languages are ms, en and ar', () => {
    expect([...langs].sort()).toEqual(['ar', 'en', 'ms']);
  });

  it('no key is missing in any language', () => {
    const all = new Set(langs.flatMap((l) => Object.keys(STRINGS[l])));
    const missing = langs.flatMap((l) => [...all].filter((k) => !(k in STRINGS[l])).map((k) => `${l}.${k}`));
    expect(missing).toEqual([]);
  });

  it('Arabic uses the same {placeholders} (the pairing line names the menu path as a value)', () => {
    const ar = STRINGS.ar;
    const differ = Object.keys(ms)
      .filter((k) => k !== 'pairInstruction' && vars(ms[k]!).join(',') !== vars(ar[k]!).join(','))
      .map((k) => `${k}: ms ${vars(ms[k]!)} vs ar ${vars(ar[k]!)}`);
    expect(differ).toEqual([]);
    expect(vars(ar.pairInstruction!)).toEqual(['path']);
  });

  it('Arabic text is Arabic: every string has Arabic letters except product names and codes', () => {
    const LATIN_OK = new Set(['tabungQrName', 'netEthernet', 'netWifi']);
    const notArabic = Object.entries(STRINGS.ar)
      .filter(([k, v]) => !LATIN_OK.has(k) && !/[\u0600-\u06FF]/.test(v))
      .map(([k]) => k);
    expect(notArabic).toEqual([]);
  });
});
