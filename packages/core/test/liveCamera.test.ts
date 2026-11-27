import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FEATURES } from '../src/features/registry.ts';
import { resolveSettings, validateFeatureSettings } from '../src/features/settings.ts';
import {
  FEATURE_DESC, FIELD_META, HIDDEN_FEATURES, LIVE_SETTINGS_FEATURES, canWriteSettingsFeatures, fieldMeta, isSystemField,
  patchNeedsSystemWrite,
} from '../src/features/meta.ts';
import { PERMISSIONS, ROLES, can } from '../src/auth/permissions.ts';
import { REACH } from '../../../apps/kiosk-display/test/settingsReach.ts';

const camera = FEATURES.find((f) => f.key === 'liveCamera');

describe('liveCamera feature', () => {
  it('is registered in the live group, off by default, not locked', () => {
    expect(camera).toBeDefined();
    expect(camera!.group).toBe('live');
    expect(camera!.locked).toBe(false);
    expect(camera!.defaultEnabled).toBe(false);
    expect(camera!.labelMs).toBe('Kamera luaran');
  });
  it('defaults: name, automatic transport, no fallback offset', () => {
    expect(camera!.defaults).toEqual({ name: 'Kamera luaran', transport: 'auto', brightness: 'auto', avOffsetMs: { deviceMic: 0, boxInput: 0 } });
    const s = resolveSettings({}).liveCamera;
    expect(s).toEqual({ enabled: false, name: 'Kamera luaran', transport: 'auto', brightness: 'auto', avOffsetMs: { deviceMic: 0, boxInput: 0 } });
  });
  it('holds no address and no password: the address is a sealed record, not a setting', () => {
    expect(Object.keys(camera!.defaults).sort()).toEqual(['avOffsetMs', 'brightness', 'name', 'transport']);
  });
  it('accepts transport auto, tcp and udp only', () => {
    for (const t of ['auto', 'tcp', 'udp']) expect(validateFeatureSettings('liveCamera', { transport: t }).ok, t).toBe(true);
    for (const t of ['http', 'TCP', '', 'sctp']) expect(validateFeatureSettings('liveCamera', { transport: t }).ok, t).toBe(false);
  });
  it('accepts brightness auto, normal, bright and brighter only (B7)', () => {
    for (const b of ['auto', 'normal', 'bright', 'brighter']) expect(validateFeatureSettings('liveCamera', { brightness: b }).ok, b).toBe(true);
    for (const b of ['dark', 'Auto', '', 5]) expect(validateFeatureSettings('liveCamera', { brightness: b }).ok, String(b)).toBe(false);
    expect(fieldMeta('liveCamera', 'brightness')).toMatchObject({ ui: 'segment', choices: ['auto', 'normal', 'bright', 'brighter'] });
    expect(resolveSettings({ liveCamera: { brightness: 'dim' } as never }).liveCamera.brightness).toBe('auto');
    expect(resolveSettings({ liveCamera: { brightness: 'bright' } as never }).liveCamera.brightness).toBe('bright');
  });
  it('accepts the fallback offset 0..2000 in steps of 50 only', () => {
    for (const v of [0, 50, 600, 1950, 2000]) {
      expect(validateFeatureSettings('liveCamera', { avOffsetMs: { deviceMic: v } }).ok, `${v}`).toBe(true);
      expect(validateFeatureSettings('liveCamera', { avOffsetMs: { boxInput: v } }).ok, `${v}`).toBe(true);
    }
    for (const v of [-50, 25, 2050, 2001, 1.5, Number.NaN]) {
      expect(validateFeatureSettings('liveCamera', { avOffsetMs: { deviceMic: v } }).ok, `${v}`).toBe(false);
    }
    expect(validateFeatureSettings('liveCamera', { avOffsetMs: { deviceMic: '100' } }).ok).toBe(false);
    expect(validateFeatureSettings('liveCamera', { avOffsetMs: { camera: 100 } }).ok).toBe(false);
  });
  it('names the camera with plain text of 1..80 characters', () => {
    expect(validateFeatureSettings('liveCamera', { name: 'Kamera dewan utama' }).ok).toBe(true);
    expect(validateFeatureSettings('liveCamera', { name: '' }).ok).toBe(false);
    expect(validateFeatureSettings('liveCamera', { name: 'x'.repeat(81) }).ok).toBe(false);
  });
  it('rejects unknown fields, such as an address or a password', () => {
    expect(validateFeatureSettings('liveCamera', { url: 'rtsp://10.168.1.20/s' }).ok).toBe(false);
    expect(validateFeatureSettings('liveCamera', { password: 'x' }).ok).toBe(false);
  });
  it('ignores a stored bad value and keeps the default', () => {
    const s = resolveSettings({ liveCamera: { transport: 'smtp', avOffsetMs: { deviceMic: 33, boxInput: 100 } } as never }).liveCamera;
    expect(s.transport).toBe('auto');
    expect(s.avOffsetMs).toEqual({ deviceMic: 0, boxInput: 100 });
  });
  it('has a description for the Tetapan search', () => {
    expect(FEATURE_DESC.liveCamera.ms.length).toBeGreaterThan(10);
    expect(FEATURE_DESC.liveCamera.en.length).toBeGreaterThan(10);
  });
  it('has field metadata for transport and each offset, all inside what the rules accept', () => {
    expect(fieldMeta('liveCamera', 'transport')).toMatchObject({ ui: 'segment', choices: ['auto', 'tcp', 'udp'] });
    for (const leaf of ['avOffsetMs.deviceMic', 'avOffsetMs.boxInput']) {
      const m = fieldMeta('liveCamera', leaf)!;
      expect(m).toMatchObject({ ui: 'stepper', min: 0, max: 2000, step: 50 });
      expect(isSystemField('liveCamera', leaf)).toBe(false);
    }
    expect(Object.keys(FIELD_META.liveCamera!).every((p) => ['transport', 'brightness', 'avOffsetMs.deviceMic', 'avOffsetMs.boxInput'].includes(p))).toBe(true);
    expect(patchNeedsSystemWrite('liveCamera', { transport: 'tcp', avOffsetMs: { deviceMic: 50 } })).toBe(false);
  });
  it('is not hidden from Tetapan', () => {
    expect(HIDDEN_FEATURES).not.toContain('liveCamera');
  });
});

describe('LIVE_SETTINGS_FEATURES and the settings write rule', () => {
  it('lists the Siaran Langsung features, camera included', () => {
    expect([...LIVE_SETTINGS_FEATURES].sort()).toEqual(['liveCamera', 'liveOnKiosk', 'liveYoutube', 'recording']);
    const keys = new Set(FEATURES.map((f) => f.key));
    for (const k of LIVE_SETTINGS_FEATURES) expect(keys.has(k), k).toBe(true);
  });
  it('lets Pentadbir write any feature', () => {
    expect(canWriteSettingsFeatures(['admin'], ['prayerBar', 'liveCamera'])).toBe(true);
    expect(canWriteSettingsFeatures(['superadmin'], ['finance'])).toBe(true);
  });
  it('lets Siaran Langsung write the live features only, and only when every touched feature is one of them', () => {
    expect(canWriteSettingsFeatures(['live'], ['liveCamera'])).toBe(true);
    expect(canWriteSettingsFeatures(['live'], ['liveOnKiosk', 'liveYoutube', 'recording', 'liveCamera'])).toBe(true);
    expect(canWriteSettingsFeatures(['live'], ['liveCamera', 'prayerBar'])).toBe(false);
    expect(canWriteSettingsFeatures(['live'], ['finance'])).toBe(false);
    expect(canWriteSettingsFeatures(['live'], ['cloudSync'])).toBe(false);
  });
  it('writes nothing for an empty touch list from a role with neither right', () => {
    expect(canWriteSettingsFeatures(['live'], [])).toBe(true);
    expect(canWriteSettingsFeatures(['media'], [])).toBe(false);
    expect(canWriteSettingsFeatures([], [])).toBe(false);
  });
  it('refuses Media, treasurer, AJK even for the live features (Media lost live settings)', () => {
    for (const r of ['media', 'treasurer', 'ajk'] as const) expect(canWriteSettingsFeatures([r], ['liveCamera']), r).toBe(false);
  });
  it('adds up across roles', () => {
    expect(canWriteSettingsFeatures(['media', 'live'], ['liveYoutube'])).toBe(true);
    expect(canWriteSettingsFeatures(['media', 'live'], ['prayerBar'])).toBe(false);
  });
  it('agrees with the table: only live:settings or settings:write holders can write live features', () => {
    for (const r of ROLES) {
      const expected = can([r], 'settings:write') || (PERMISSIONS[r] as readonly string[]).includes('live:settings');
      expect(canWriteSettingsFeatures([r], ['liveCamera']), r).toBe(expected);
    }
  });
});

describe('settings reach guard covers every new leaf', () => {
  it('has an entry for every leaf of liveCamera and no other', () => {
    const want = ['enabled', ...Object.keys(camera!.defaults)].sort();
    expect(Object.keys(REACH.liveCamera ?? {}).sort()).toEqual(want);
  });
  it('lists every leaf of the whole registry (same rule as the kiosk guard)', () => {
    const want = FEATURES.flatMap((f) => ['enabled', ...Object.keys(f.defaults)].map((l) => `${f.key}.${l}`)).sort();
    const have = Object.entries(REACH).flatMap(([f, ls]) => Object.keys(ls).map((l) => `${f}.${l}`)).sort();
    expect(want.filter((x) => !have.includes(x))).toEqual([]);
    expect(have.filter((x) => !want.includes(x))).toEqual([]);
  });
  it('explains every unread leaf with a reason', () => {
    for (const [leaf, r] of Object.entries(REACH.liveCamera ?? {})) {
      if ('none' in r) expect(r.why.length, leaf).toBeGreaterThan(20);
    }
  });
  it('points each consumer file that exists at a file that names the leaf', () => {
    const root = resolve(__dirname, '../../..');
    for (const [leaf, r] of Object.entries(REACH.liveCamera ?? {})) {
      if (!('by' in r)) continue;
      for (const f of r.by) {
        const text = readFileSync(resolve(root, f), 'utf8');
        expect(text.includes(leaf === 'enabled' ? 'liveCamera' : leaf), `${leaf} in ${f}`).toBe(true);
      }
    }
  });
});
