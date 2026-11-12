import { describe, expect, it } from 'vitest';
import { FEATURES } from '../src/features/registry.ts';
import { validateFeatureSettings } from '../src/features/settings.ts';
import {
  FEATURE_DESC, FIELD_META, LANJUTAN_ROWS, ORDERED_FEATURES, SYSTEM_FEATURES, fieldMeta, isSystemField,
  patchNeedsSystemWrite,
} from '../src/features/meta.ts';
import type { FeatureKey } from '../src/features/registry.ts';

const BY = new Map(FEATURES.map((f) => [f.key, f]));
const leafAt = (o: unknown, path: string): boolean => {
  let cur: unknown = o;
  for (const k of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(k in cur)) return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  return true;
};

describe('field metadata', () => {
  it('only names paths that exist in the feature defaults', () => {
    for (const [feature, table] of Object.entries(FIELD_META)) {
      const f = BY.get(feature as FeatureKey);
      expect(f, feature).toBeDefined();
      for (const path of Object.keys(table!)) expect(leafAt(f!.defaults, path), `${feature}.${path}`).toBe(true);
    }
  });
  it('every slider spans exactly the range its rule accepts, so an old stored value is shown and kept', () => {
    let n = 0;
    for (const [feature, table] of Object.entries(FIELD_META)) {
      for (const [path, m] of Object.entries(table!)) {
        if (m.ui !== 'slider') continue;
        n += 1;
        const accepts = (v: number): boolean => validateFeatureSettings(feature as FeatureKey, { [path]: v }).ok;
        const at = `${feature}.${path}`;
        expect(accepts(m.min!), `${at} min`).toBe(true);
        expect(accepts(m.max!), `${at} max`).toBe(true);
        expect(accepts(m.min! - 1), `${at} below min`).toBe(false);
        expect(accepts(m.max! + 1), `${at} above max`).toBe(false);
        expect((m.max! - m.min!) % m.step!, `${at} step`).toBe(0);
      }
    }
    expect(n).toBeGreaterThan(10);
  });
  it('marks the Lanjutan fields as system scope', () => {
    expect(FIELD_META.liveYoutube!.maxBitrateKbps!.scope).toBe('system');
    expect(fieldMeta('tilawah', 'cacheMaxMb')!.scope).toBe('system');
    expect(fieldMeta('liveYoutube', 'privacy')).toBeUndefined();
    expect(FIELD_META.liveYoutube!.relayFrom!.disabledChoices).toEqual(['phone']);
  });
  it('picks only inside the allowed range', () => {
    expect(fieldMeta('system', 'noVideoSeconds')).toMatchObject({ min: 5, max: 60 });
    expect(fieldMeta('cloudSync', 'dirtyCheckSeconds')!.choices).toEqual([60, 120, 300, 600, 900]);
  });
  it('offers the five kiosk templates as a dropdown, every choice valid and nothing else', () => {
    const m = fieldMeta('kioskTemplate', 'templateId')!;
    expect(m.ui).toBe('dropdown');
    expect(m.choices).toEqual(['default', 'colourful', 'creative', 'oldschool', 'minimal']);
    for (const c of m.choices!) expect(validateFeatureSettings('kioskTemplate', { templateId: c }).ok, String(c)).toBe(true);
    expect(isSystemField('kioskTemplate', 'templateId')).toBe(false);
    expect(FEATURE_DESC.kioskTemplate.ms).toContain('Satu Warna (Lalai)');
  });
});

describe('system scope', () => {
  it('knows the system features and fields', () => {
    expect([...SYSTEM_FEATURES]).toEqual(['dataSources', 'cloudSync', 'system']);
    expect(isSystemField('system', 'noVideoSeconds')).toBe(true);
    expect(isSystemField('liveYoutube', 'relayVideo')).toBe(true);
    expect(isSystemField('liveYoutube', 'privacy')).toBe(false);
  });
  it('says when a patch needs system:write', () => {
    expect(patchNeedsSystemWrite('liveYoutube', { privacy: 'public' })).toBe(false);
    expect(patchNeedsSystemWrite('liveYoutube', { relayVideo: 'copy' })).toBe(true);
    expect(patchNeedsSystemWrite('liveYoutube', { privacy: 'public', maxBitrateKbps: 2000 })).toBe(true);
    expect(patchNeedsSystemWrite('cloudSync', { enabled: false })).toBe(true);
    expect(patchNeedsSystemWrite('system', {})).toBe(true);
    expect(patchNeedsSystemWrite('dataSources', { esolat: { url: 'https://x.my' } })).toBe(true);
    expect(patchNeedsSystemWrite('tilawah', { volume: 50 })).toBe(false);
    expect(patchNeedsSystemWrite('tilawah', { cacheMaxMb: 500 })).toBe(true);
    expect(patchNeedsSystemWrite('tilawah', null)).toBe(false);
  });
  it('lists the Lanjutan deep links and the ordered features', () => {
    expect(LANJUTAN_ROWS.map((r) => r.feature)).toEqual(['liveYoutube', 'tilawah']);
    expect(ORDERED_FEATURES).toHaveLength(10);
    for (const k of ORDERED_FEATURES) expect(BY.get(k)!.defaults).toHaveProperty('order');
    for (const f of FEATURES) if ('order' in f.defaults) expect(ORDERED_FEATURES).toContain(f.key);
  });
});

describe('feature descriptions', () => {
  it('has a clean BM and EN sentence for every feature', () => {
    for (const f of FEATURES) {
      const d = FEATURE_DESC[f.key];
      expect(d, f.key).toBeDefined();
      expect(d.ms.length, f.key).toBeGreaterThan(5);
      expect(d.en.length, f.key).toBeGreaterThan(5);
      for (const text of [d.ms, d.en, ...d.keywords]) {
        expect(text).not.toMatch(/kotak/i);
        expect(text).not.toMatch(/[‒-―←-⇿≈]/);
      }
    }
    expect(Object.keys(FEATURE_DESC)).toHaveLength(FEATURES.length);
  });
});
