import { describe, expect, it } from 'vitest';
import {
  MAX_TVS, TV_HIDE_KINDS, applyTvProfileToContent, applyTvProfileToLive, applyTvProfileToSettings, kioskSettingsForTv,
  resolveSettings, sanitizeTvProfiles, tvProfileFor, tvProfilesError, validateFeatureSettings,
} from '../src/index.ts';
import type { KioskContent, KioskLive, TvProfile } from '../src/index.ts';

const ok = (tvs: unknown) => tvProfilesError(tvs);
const full: TvProfile = {
  name: 'Dewan solat',
  templateId: 'minimal',
  orientation: 'portrait',
  lang: 'ar',
  live: { show: true, audio: true, volume: 30, fit: 'contain', showStrip: false },
  hideKinds: ['tabung', 'ticker'],
  sounds: { beeps: false, azan: true, tilawah: true },
};

describe('tvProfiles registry entry', () => {
  it('defaults to no TVs, locked on, in the skrin group', () => {
    expect(resolveSettings({}).tvProfiles).toEqual({ tvs: {}, enabled: true });
    expect(resolveSettings({ tvProfiles: { enabled: false } as never }).tvProfiles.enabled).toBe(true);
  });
  it('an unknown feature key in stored settings is still ignored', () => {
    const s = resolveSettings({ futureThing: { a: 1 }, tvProfiles: { tvs: { self: { name: 'A' } } } } as never);
    expect(Object.keys(s)).not.toContain('futureThing');
    expect(s.tvProfiles.tvs).toEqual({ self: { name: 'A' } });
  });
  it('is validated through validateFeatureSettings', () => {
    expect(validateFeatureSettings('tvProfiles', { tvs: { self: full } }).ok).toBe(true);
    expect(validateFeatureSettings('tvProfiles', { tvs: { self: { name: '' } } }).ok).toBe(false);
    expect(validateFeatureSettings('tvProfiles', { other: 1 }).ok).toBe(false);
    expect(validateFeatureSettings('tvProfiles', { enabled: false }).ok).toBe(false);
  });
});

describe('write check', () => {
  it('accepts a full profile, an empty one, and a null removal', () => {
    expect(ok({ self: full, dev_1: {}, 'a-b': { name: 'x' }, gone: null })).toBeNull();
    expect(ok({})).toBeNull();
  });
  it('refuses a bad TV id', () => {
    for (const id of ['', 'a b', 'a/b', 'x'.repeat(65), '__proto__', 'ü']) {
      const o = JSON.parse(`{${JSON.stringify(id)}: {}}`);
      expect(ok(o), id).not.toBeNull();
    }
    expect(ok([])).not.toBeNull();
    expect(ok(null)).not.toBeNull();
    expect(ok({ self: 5 })).not.toBeNull();
  });
  it('refuses unknown fields at every level', () => {
    expect(ok({ a: { zzz: 1 } })).toMatch(/not a known setting/);
    expect(ok({ a: { live: { zzz: 1 } } })).toMatch(/not a known setting/);
    expect(ok({ a: { sounds: { zzz: true } } })).toMatch(/not a known setting/);
  });
  it('checks name', () => {
    expect(ok({ a: { name: 'x'.repeat(40) } })).toBeNull();
    expect(ok({ a: { name: 'x'.repeat(41) } })).not.toBeNull();
    expect(ok({ a: { name: '   ' } })).not.toBeNull();
    expect(ok({ a: { name: 'a\nb' } })).not.toBeNull();
    expect(ok({ a: { name: 'a\u0000b' } })).not.toBeNull();
    expect(ok({ a: { name: 5 } })).not.toBeNull();
  });
  it('checks templateId, orientation and lang', () => {
    expect(ok({ a: { templateId: 'creative' } })).toBeNull();
    expect(ok({ a: { templateId: 'My Theme' } })).not.toBeNull();
    expect(ok({ a: { templateId: 5 } })).not.toBeNull();
    expect(ok({ a: { orientation: 'portrait' } })).toBeNull();
    expect(ok({ a: { orientation: 'sideways' } })).not.toBeNull();
    for (const l of ['auto', 'ms', 'en', 'ar']) expect(ok({ a: { lang: l } }), l).toBeNull();
    expect(ok({ a: { lang: 'fr' } })).not.toBeNull();
  });
  it('checks live', () => {
    expect(ok({ a: { live: { volume: 0 } } })).toBeNull();
    expect(ok({ a: { live: { volume: 100 } } })).toBeNull();
    expect(ok({ a: { live: { volume: 101 } } })).not.toBeNull();
    expect(ok({ a: { live: { volume: 50.5 } } })).not.toBeNull();
    expect(ok({ a: { live: { volume: '5' } } })).not.toBeNull();
    expect(ok({ a: { live: { fit: 'fill' } } })).not.toBeNull();
    expect(ok({ a: { live: { show: 'yes' } } })).not.toBeNull();
    expect(ok({ a: { live: { audio: 1 } } })).not.toBeNull();
    expect(ok({ a: { live: { showStrip: null } } })).not.toBeNull();
    expect(ok({ a: { live: [] } })).not.toBeNull();
  });
  it('checks hideKinds: known kinds only, no duplicates, at most 20', () => {
    expect(ok({ a: { hideKinds: [] } })).toBeNull();
    expect(ok({ a: { hideKinds: [...TV_HIDE_KINDS] } })).toBeNull();
    expect(ok({ a: { hideKinds: ['kuliah', 'kuliah'] } })).toMatch(/repeat/);
    expect(ok({ a: { hideKinds: ['solat'] } })).not.toBeNull();
    expect(ok({ a: { hideKinds: 'kuliah' } })).not.toBeNull();
    expect(ok({ a: { hideKinds: Array.from({ length: 21 }, () => 'kuliah') } })).not.toBeNull();
  });
  it('checks sounds', () => {
    expect(ok({ a: { sounds: { beeps: false } } })).toBeNull();
    expect(ok({ a: { sounds: { beeps: 'no' } } })).not.toBeNull();
  });
  it('holds at most 16 TVs; removals do not count', () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`tv${i}`, {}]));
    expect(ok(many(MAX_TVS))).toBeNull();
    expect(ok(many(MAX_TVS + 1))).toMatch(/at most 16/);
    expect(ok({ ...many(MAX_TVS), old: null })).toBeNull();
  });
});

describe('read side', () => {
  it('drops junk and never throws', () => {
    expect(sanitizeTvProfiles(null)).toEqual({});
    expect(sanitizeTvProfiles([])).toEqual({});
    expect(sanitizeTvProfiles('x')).toEqual({});
    expect(sanitizeTvProfiles({ gone: null, 'bad id': {}, num: 5, arr: [], ok: { name: '  Foyer  ' } })).toEqual({ ok: { name: 'Foyer' } });
    const messy = sanitizeTvProfiles({
      a: {
        name: 5, templateId: 'Bad Name', orientation: 'x', lang: 'fr', zzz: 1,
        live: { show: 'y', volume: 500, fit: 'z', audio: true, extra: 1 },
        hideKinds: ['kuliah', 'kuliah', 'nope', 7, 'ticker'],
        sounds: { beeps: 1, azan: false, extra: true },
      },
    });
    expect(messy).toEqual({ a: { live: { audio: true }, hideKinds: ['kuliah', 'ticker'], sounds: { azan: false } } });
  });
  it('keeps at most 16 TVs', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`tv${i}`, { name: 'x' }]));
    expect(Object.keys(sanitizeTvProfiles(many))).toHaveLength(MAX_TVS);
  });
  it('a stored `__proto__` key is never an entry', () => {
    const raw = JSON.parse('{"__proto__": {"name": "x"}, "self": {"name": "ok"}}');
    const out = sanitizeTvProfiles(raw);
    expect(Object.keys(out)).toEqual(['self']);
  });
  it('resolveSettings sanitises the stored tvs and drops removed ones', () => {
    const s = resolveSettings({ tvProfiles: { tvs: { a: null, b: { name: 'B', zzz: 1 } } } } as never);
    expect(s.tvProfiles.tvs).toEqual({ b: { name: 'B' } });
  });
});

describe('tvProfileFor', () => {
  const s = resolveSettings({ tvProfiles: { tvs: { self: { name: 'Own' }, dev1: { name: 'One' } } } } as never);
  it('finds a TV by id', () => {
    expect(tvProfileFor(s, 'self')).toEqual({ name: 'Own' });
    expect(tvProfileFor(s, 'dev1')).toEqual({ name: 'One' });
  });
  it('undefined for an unknown, empty or unsafe id', () => {
    expect(tvProfileFor(s, 'nobody')).toBeUndefined();
    expect(tvProfileFor(s, null)).toBeUndefined();
    expect(tvProfileFor(s, undefined)).toBeUndefined();
    expect(tvProfileFor(s, '')).toBeUndefined();
    expect(tvProfileFor(s, '__proto__')).toBeUndefined();
    expect(tvProfileFor(s, 'constructor')).toBeUndefined();
    expect(tvProfileFor(s, 'toString')).toBeUndefined();
  });
});

describe('applyTvProfileToSettings', () => {
  const base = resolveSettings({
    kioskTemplate: { templateId: 'default' },
    language: { lang: 'ms', enabled: true },
    liveOnKiosk: { enabled: true, audio: false, volume: 50, showStrip: true, fit: 'cover' },
    tvProfiles: { tvs: { self: full, other: { name: 'Secret' } } },
  } as never);

  it('undefined profile returns the input as is', () => {
    expect(applyTvProfileToSettings(base, undefined)).toBe(base);
  });
  it('overlays every field of a full profile', () => {
    const out = applyTvProfileToSettings(base, full, 'self');
    expect(out.kioskTemplate.templateId).toBe('minimal');
    expect(out.orientation.mode).toBe('portrait');
    expect(out.language).toMatchObject({ lang: 'ar', enabled: true });
    expect(out.liveOnKiosk).toMatchObject({ enabled: true, audio: true, volume: 30, fit: 'contain', showStrip: false });
    expect(out.beeps.enabled).toBe(false);
    expect(out.beeps.volume).toBe(70);
    expect(out.firstAzanSubuh.enabled).toBe(true);
    expect(out.tilawah.enabled).toBe(true);
  });
  it('a missing field follows the surau', () => {
    const out = applyTvProfileToSettings(base, { name: 'x' }, 'self');
    expect(out.kioskTemplate).toEqual(base.kioskTemplate);
    expect(out.orientation).toEqual(base.orientation);
    expect(out.language).toEqual(base.language);
    expect(out.liveOnKiosk).toEqual(base.liveOnKiosk);
    expect(out.beeps).toEqual(base.beeps);
  });
  it('lang auto hands the choice back to the location; a language turns the feature on', () => {
    const en = resolveSettings({ language: { lang: 'en' } } as never);
    expect(applyTvProfileToSettings(en, { lang: 'auto' }).language).toMatchObject({ lang: 'auto' });
    expect(applyTvProfileToSettings(en, { lang: 'ms' }).language).toMatchObject({ lang: 'ms', enabled: true });
  });
  it('live.show:false switches the live feature off for that TV', () => {
    expect(applyTvProfileToSettings(base, { live: { show: false } }).liveOnKiosk.enabled).toBe(false);
  });
  it('never mutates the input', () => {
    const before = JSON.stringify(base);
    applyTvProfileToSettings(base, full, 'self');
    expect(JSON.stringify(base)).toBe(before);
  });
  it('holds no other TV profile: only its own entry, or none', () => {
    const own = applyTvProfileToSettings(base, full, 'self');
    expect(own.tvProfiles.tvs).toEqual({ self: full });
    expect(JSON.stringify(own)).not.toContain('Secret');
    expect(applyTvProfileToSettings(base, full).tvProfiles.tvs).toEqual({});
  });
});

describe('kioskSettingsForTv', () => {
  const base = resolveSettings({ tvProfiles: { tvs: { self: { templateId: 'minimal' }, dev1: { name: 'Secret One' } } } } as never);
  it('a TV with a profile gets it overlaid and nobody else', () => {
    const out = kioskSettingsForTv(base, 'self');
    expect(out.kioskTemplate.templateId).toBe('minimal');
    expect(Object.keys(out.tvProfiles.tvs)).toEqual(['self']);
    expect(JSON.stringify(out)).not.toContain('Secret One');
  });
  it('a TV without a profile gets the surau values and an empty map', () => {
    const out = kioskSettingsForTv(base, 'dev9');
    expect(out.kioskTemplate).toEqual(base.kioskTemplate);
    expect(out.tvProfiles.tvs).toEqual({});
    expect(JSON.stringify(out)).not.toContain('Secret One');
    expect(base.tvProfiles.tvs).toHaveProperty('dev1');
  });
});

describe('applyTvProfileToContent', () => {
  const content = {
    date: '2026-11-22',
    kuliah: [{ id: 'k1' }, { id: 'k2' }], pengumuman: [{ id: 'p1' }], ticker: [{ id: 't1' }], posters: [{ id: 'po1' }],
    videos: [{ id: 'v1' }], programKhas: [{ id: 'pk1' }], takwim: [{ id: 'tw1' }], hadisToday: [{ id: 'h1' }], hadis: null,
    worldTimes: [{ id: 'w1' }], tugasan: [{ id: 'tg1' }], ayat: { today: null, tomorrow: null }, zikir: [{ id: 'z1' }],
    tilawah: { slots: [], available: {} }, credits: { translation: '', font: '', audio: '' }, tabung: { any: 1 },
  } as unknown as KioskContent;

  it('undefined profile or no hideKinds returns the input', () => {
    expect(applyTvProfileToContent(content, undefined)).toBe(content);
    expect(applyTvProfileToContent(content, { hideKinds: [] })).toBe(content);
    expect(applyTvProfileToContent(content, { name: 'x' })).toBe(content);
  });
  it('removes each hidden kind and keeps the order of the rest', () => {
    const out = applyTvProfileToContent(content, { hideKinds: ['tabung', 'poster', 'hadis', 'video', 'worldTime'] });
    expect(out.tabung).toBeNull();
    expect(out.posters).toEqual([]);
    expect(out.hadisToday).toEqual([]);
    expect(out.videos).toEqual([]);
    expect(out.worldTimes).toEqual([]);
    expect(out.kuliah).toEqual(content.kuliah);
    expect(out.zikir).toEqual(content.zikir);
    expect(out.tilawah).toBe(content.tilawah);
  });
  it('maps every hideable kind to a key', () => {
    for (const kind of TV_HIDE_KINDS) {
      const out = applyTvProfileToContent(content, { hideKinds: [kind] });
      expect(out, kind).not.toEqual(content);
    }
  });
  it('does not mutate the input and leaves an absent videos key absent', () => {
    const before = JSON.stringify(content);
    applyTvProfileToContent(content, { hideKinds: [...TV_HIDE_KINDS] });
    expect(JSON.stringify(content)).toBe(before);
    const { videos: _v, ...older } = content;
    expect('videos' in applyTvProfileToContent(older as KioskContent, { hideKinds: ['video'] })).toBe(false);
  });
});

describe('applyTvProfileToLive', () => {
  const live: KioskLive = { live: true, since: '2026-11-22T10:00:00Z', kuliah: null, audio: false, volume: 50, path: 'surau', waiting: true };
  it('no profile or no live part returns the input', () => {
    expect(applyTvProfileToLive(live, undefined)).toBe(live);
    expect(applyTvProfileToLive(live, { name: 'x' })).toBe(live);
  });
  it('show:false is not live; audio and volume still follow the profile', () => {
    const out = applyTvProfileToLive(live, { live: { show: false, audio: true, volume: 20 } });
    expect(out).toMatchObject({ live: false, since: null, audio: true, volume: 20 });
    expect(out.waiting).toBeUndefined();
  });
  it('audio and volume come from the profile when set, else the surau', () => {
    expect(applyTvProfileToLive(live, { live: { audio: true } })).toMatchObject({ live: true, audio: true, volume: 50 });
    expect(applyTvProfileToLive({ ...live, audio: true }, { live: { audio: false, volume: 10 } })).toMatchObject({ audio: false, volume: 10 });
  });
});
