import { describe, expect, it } from 'vitest';
import { FEATURES } from '../src/features/registry.ts';
import { resolveSettings, validateFeatureSettings } from '../src/features/settings.ts';
import {
  FEATURE_DESC, FEATURE_REQUIRES, FIELD_META, HIDDEN_FEATURES, LANJUTAN_ROWS, ORDERED_FEATURES, SYSTEM_FEATURES, fieldMeta, isSystemField,
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
  it('autoTone.override is hidden: the accent has one control, Ubah suai Warna aksen', () => {
    expect(fieldMeta('autoTone', 'override')?.hidden).toBe(true);
    const hidden = Object.entries(FIELD_META).flatMap(([f, t]) => Object.entries(t!).filter(([, m]) => m.hidden).map(([p]) => `${f}.${p}`));
    expect(hidden.sort()).toEqual([
      'autoTone.override', 'liveYoutube.nextLiveOn', 'liveYoutube.relayFrom', 'pengumuman.daysAhead', 'programKhas.daysAhead', 'system.suspendedAt', 'themeStyle.enabled',
    ]);
  });
  it('[K17] settings nothing reads are hidden yet still validate, so old data loads', () => {
    for (const [f, p] of [['system', 'suspendedAt'], ['pengumuman', 'daysAhead'], ['programKhas', 'daysAhead'], ['autoTone', 'override'], ['themeStyle', 'enabled']] as const) {
      expect(fieldMeta(f, p)?.hidden, `${f}.${p}`).toBe(true);
    }
    expect(validateFeatureSettings('system', { suspendedAt: null }).ok).toBe(true);
    expect(validateFeatureSettings('system', { suspendedAt: '2026-11-01T00:00:00.000Z' }).ok).toBe(true);
    expect(validateFeatureSettings('pengumuman', { daysAhead: 7 }).ok).toBe(true);
    expect(validateFeatureSettings('programKhas', { daysAhead: 7 }).ok).toBe(true);
    expect(validateFeatureSettings('autoTone', { override: '#112233' }).ok).toBe(true);
    expect(validateFeatureSettings('themeStyle', { enabled: true }).ok).toBe(true);
  });
  it('[K10] kad tabung manual fields are dimmed while finance is on, the live-only ones while it is off', () => {
    for (const p of ['manualTitle', 'row1Label', 'row1Sen', 'row2Label', 'row2Sen', 'row3Label', 'row3Sen']) {
      expect(fieldMeta('tabungCard', p)?.disabledWhen, p).toMatchObject({ feature: 'finance', field: 'enabled', equals: true });
    }
    for (const p of ['showTarget', 'highlightSeconds']) {
      expect(fieldMeta('tabungCard', p)?.disabledWhen, p).toMatchObject({ feature: 'finance', field: 'enabled', equals: false });
    }
    for (const t of Object.values(FIELD_META.tabungCard ?? {})) {
      if (t.disabledWhen) expect(t.disabledWhen.noteMs && t.disabledWhen.noteEn && t.disabledWhen.noteAr).toBeTruthy();
    }
  });
  it('[L4] live on YouTube needs the broadcast on the TV', () => {
    expect(FEATURE_REQUIRES.liveYoutube).toEqual({ requires: 'liveOnKiosk' });
  });
  it('[K9] the TV texts written in BM start empty and the presets carry English', () => {
    expect(resolveSettings({}).solatScreen.message).toBe('');
    expect(resolveSettings({}).tabungCard.manualTitle).toBe('');
    expect(validateFeatureSettings('solatScreen', { message: '' }).ok).toBe(true);
    const m = fieldMeta('solatScreen', 'message');
    expect(m?.presetsEn?.length).toBe(m?.presets?.length);
  });
  it('hides the dead daysAhead windows, locks the local calculation on and caps the takwim rows at 3', () => {
    // A notice and a special programme show by their own dates: nothing reads the window, so it is not offered.
    expect(fieldMeta('pengumuman', 'daysAhead')?.hidden).toBe(true);
    expect(fieldMeta('programKhas', 'daysAhead')?.hidden).toBe(true);
    // The kuliah and tugasan windows are read, so they stay visible.
    expect(fieldMeta('kuliahCard', 'daysAhead')?.hidden).not.toBe(true);
    // prayerCalc always runs as the fallback: no switch, and a stored `enabled: false` is ignored.
    expect(BY.get('prayerCalc')?.locked).toBe(true);
    expect(resolveSettings({ prayerCalc: { enabled: false } }).prayerCalc.enabled).toBe(true);
    expect(validateFeatureSettings('prayerCalc', { enabled: false }).ok).toBe(false);
    // The card shows three rows at most (TakwimCard MAX_ROWS), so the chips stop there.
    expect(fieldMeta('takwim', 'count')).toMatchObject({ ui: 'chips', choices: [1, 2, 3] });
  });
  it('only names paths that exist in the feature defaults', () => {
    for (const [feature, table] of Object.entries(FIELD_META)) {
      const f = BY.get(feature as FeatureKey);
      expect(f, feature).toBeDefined();
      for (const path of Object.keys(table!)) expect(path === 'enabled' || leafAt(f!.defaults, path), `${feature}.${path}`).toBe(true);
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
        // A card duration slider starts at 5 s because a stored 0 plays 15 s without saying so; the rule still accepts 0.
        if (path === 'durationSeconds') {
          expect(m.min, `${at} min`).toBe(5);
          expect(accepts(0), `${at} keeps a stored 0`).toBe(true);
        } else {
          expect(accepts(m.min! - 1), `${at} below min`).toBe(false);
        }
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
    // the surau's YouTube choice has its own control on the Live screen: not offered in Tetapan, and any live role may change it
    expect(fieldMeta('liveYoutube', 'nextLiveOn')!.hidden).toBe(true);
    expect(isSystemField('liveYoutube', 'nextLiveOn')).toBe(false);
    expect(FIELD_META.liveYoutube!.relayFrom!.disabledChoices).toEqual(['phone']);
  });
  it('picks only inside the allowed range', () => {
    expect(fieldMeta('system', 'noVideoSeconds')).toMatchObject({ min: 5, max: 60 });
    expect(fieldMeta('cloudSync', 'dirtyCheckSeconds')!.choices).toEqual([60, 120, 300, 600, 900]);
  });
  it('offers the theme picker widget; every built-in theme name is valid', () => {
    const m = fieldMeta('kioskTemplate', 'templateId')!;
    expect(m.ui).toBe('theme');
    for (const c of ['default', 'colourful', 'creative', 'oldschool', 'minimal']) expect(validateFeatureSettings('kioskTemplate', { templateId: c }).ok, c).toBe(true);
    expect(isSystemField('kioskTemplate', 'templateId')).toBe(false);
    expect(FEATURE_DESC.kioskTemplate.ms).toContain('Setiap skrin boleh diubah suai');
    expect(HIDDEN_FEATURES).toEqual(['themeStyle', 'orientation', 'quranReader', 'calendarFeed', 'jemaahPage']);
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
    expect(ORDERED_FEATURES).toHaveLength(11);
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
      expect(d.ar.length, f.key).toBeGreaterThan(5);
      expect(f.labelAr.length, f.key).toBeGreaterThan(1);
      for (const text of [d.ms, d.en, d.ar, f.labelAr, ...d.keywords]) {
        expect(text).not.toMatch(/kotak/i);
        expect(text).not.toMatch(/[‒-―←-⇿≈]/);
      }
    }
    expect(Object.keys(FEATURE_DESC)).toHaveLength(FEATURES.length);
  });
});
