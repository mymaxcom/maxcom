import { describe, expect, it } from 'vitest';
import { FEATURES, tvLanguage, validateFeatureSettings } from '../src/index.ts';

const s = (enabled: boolean, lang: unknown, country: unknown) => ({ language: { enabled, lang }, location: { country } });

describe('tvLanguage', () => {
  it('auto follows the country', () => {
    expect(tvLanguage(s(true, 'auto', 'MY'))).toBe('ms');
    expect(tvLanguage(s(true, 'auto', 'JO'))).toBe('en');
  });
  it('an explicit choice wins', () => {
    expect(tvLanguage(s(true, 'ms', 'JO'))).toBe('ms');
    expect(tvLanguage(s(true, 'en', 'MY'))).toBe('en');
    expect(tvLanguage(s(true, 'ar', 'MY'))).toBe('ar');
    expect(tvLanguage(s(true, 'ar', 'JO'))).toBe('ar');
  });
  it('switched off means auto', () => {
    expect(tvLanguage(s(false, 'ms', 'JO'))).toBe('en');
    expect(tvLanguage(s(false, 'en', 'MY'))).toBe('ms');
    expect(tvLanguage(s(false, 'ar', 'MY'))).toBe('ms');
    expect(tvLanguage(s(false, 'ar', 'JO'))).toBe('en');
  });
  it('missing country or unknown lang falls back to ms for MY / country rule', () => {
    expect(tvLanguage(s(true, 'auto', undefined))).toBe('ms');
    expect(tvLanguage(s(true, 'xx', 'MY'))).toBe('ms');
  });
});

describe('language setting', () => {
  it('accepts auto, ms, en and ar; refuses anything else', () => {
    for (const lang of ['auto', 'ms', 'en', 'ar']) expect(validateFeatureSettings('language', { lang }).ok).toBe(true);
    for (const lang of ['id', 'AR', 'ar-SA', '', 1]) expect(validateFeatureSettings('language', { lang }).ok).toBe(false);
  });
  it('default is auto, locked, renamed', () => {
    const f = FEATURES.find((x) => x.key === 'language');
    expect(f?.defaults).toEqual({ lang: 'auto' });
    expect(f?.locked).toBe(true);
    expect(f?.labelMs).toBe('Bahasa skrin TV');
    expect(f?.labelEn).toBe('TV screen language');
  });
});
