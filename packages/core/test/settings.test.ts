import { describe, expect, it } from 'vitest';
import { DAY_KEYS, FEATURES, minutesFor, resolveSettings, validateFeatureSettings } from '../src/index.ts';
import type { FeatureKey } from '../src/index.ts';

describe('resolveSettings', () => {
  it('gives defaults', () => {
    const s = resolveSettings({});
    expect(s.iqamahCountdown.minutes.jumaat.subuh).toBe(12);
    expect(s.iqamahCountdown.minutes.isnin.asar).toBe(10);
    expect(s.finance.enabled).toBe(false);
    expect(s.tilawah.enabled).toBe(false);
    expect(s.solatScreen.minutes.sabtu.isyak).toBe(15);
  });
  it('locked features stay enabled', () => {
    expect(resolveSettings({ prayerBar: { enabled: false } }).prayerBar.enabled).toBe(true);
  });
  it('merges WeekTable per day per prayer', () => {
    const s = resolveSettings({ iqamahCountdown: { minutes: { isnin: { subuh: 15 } } } });
    expect(s.iqamahCountdown.minutes.isnin.asar).toBe(10);
    expect(s.iqamahCountdown.minutes.isnin.subuh).toBe(15);
  });
  it('drops unknown features and keys', () => {
    expect(resolveSettings({ bogus: { enabled: true } } as any)).not.toHaveProperty('bogus');
    const s = resolveSettings({ clock: { nope: 1 } as any });
    expect(s.clock).not.toHaveProperty('nope');
  });
  it('wrong-typed stored value falls back to default', () => {
    expect(resolveSettings({ masukWaktu: { screenSeconds: 'x' as any } }).masukWaktu.screenSeconds).toBe(60);
    expect(resolveSettings('garbage' as any).clock.enabled).toBe(true);
    expect(resolveSettings({ clock: 5 as any }).clock.showSeconds).toBe(false);
  });
  it('does not share nested objects between calls', () => {
    const a = resolveSettings({});
    const b = resolveSettings({});
    a.iqamahCountdown.minutes.isnin.asar = 99;
    expect(b.iqamahCountdown.minutes.isnin.asar).toBe(10);
  });
});

describe('validateFeatureSettings', () => {
  it('rejects bad values', () => {
    const r = validateFeatureSettings('iqamahCountdown', { minutes: { isnin: { asar: -3 } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('minutes.isnin.asar must be an integer 0..120');
    expect(validateFeatureSettings('clock', { enabled: false }).ok).toBe(false);
    expect(validateFeatureSettings('clock', { bogus: 1 }).ok).toBe(false);
    expect(validateFeatureSettings('clock', 'x').ok).toBe(false);
    expect(validateFeatureSettings('clock', [1]).ok).toBe(false);
    expect(validateFeatureSettings('iqamahCountdown', { minutes: { funday: {} } }).ok).toBe(false);
    expect(validateFeatureSettings('iqamahCountdown', { minutes: { isnin: { duha: 1 } } }).ok).toBe(false);
    expect(validateFeatureSettings('hijriDate', { adjustDays: 3 }).ok).toBe(false);
    expect(validateFeatureSettings('hijriDate', { switchAt: 'noon' }).ok).toBe(false);
    expect(validateFeatureSettings('language', { lang: 'id' }).ok).toBe(false);
    expect(validateFeatureSettings('zone', { zone: 'sgr1' }).ok).toBe(false);
    expect(validateFeatureSettings('zone', { autoFetch: 'yes' }).ok).toBe(false);
    expect(validateFeatureSettings('zone', { autoFetch: 1 }).ok).toBe(false);
    expect(validateFeatureSettings('zone', { autoFetch: false }).ok).toBe(true);
    expect(validateFeatureSettings('zone', { autoFetch: true, zone: 'JHR01' }).ok).toBe(true);
    expect(validateFeatureSettings('zone', { autofetch: true }).ok).toBe(false);
    expect(validateFeatureSettings('tarawih', { hijriMonth: 13 }).ok).toBe(false);
    expect(validateFeatureSettings('beeps', { volume: 101 }).ok).toBe(false);
    expect(validateFeatureSettings('masukWaktu', { screenSeconds: 601 }).ok).toBe(false);
    expect(validateFeatureSettings('masukWaktu', { beep: 'yes' }).ok).toBe(false);
    expect(validateFeatureSettings('ticker', { enabled: 1 }).ok).toBe(false);
  });
  it('accepts good patches unchanged', () => {
    expect(validateFeatureSettings('hijriDate', { adjustDays: 1 })).toEqual({ ok: true, value: { adjustDays: 1 } });
    expect(validateFeatureSettings('ticker', { enabled: false })).toEqual({ ok: true, value: { enabled: false } });
    expect(validateFeatureSettings('azanCountdown', { minutesBefore: { subuh: 0 } }).ok).toBe(true);
    expect(validateFeatureSettings('tarawih', { minutes: 45 }).ok).toBe(true);
  });
});

describe('registry', () => {
  it('has labels and unique keys', () => {
    expect(FEATURES.every((f) => f.labelMs && f.labelEn)).toBe(true);
    const keys = FEATURES.map((f) => f.key as FeatureKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(53);
    expect(new Set(FEATURES.map((f) => f.group)).size).toBe(11);
    expect(FEATURES.filter((f) => f.locked)).toHaveLength(9);
  });
  it('DAY_KEYS and minutesFor', () => {
    expect(DAY_KEYS[5]).toBe('jumaat');
    expect(DAY_KEYS[0]).toBe('ahad');
    expect(minutesFor({ isnin: { asar: 7 } } as any, 'isnin', 'asar', 10)).toBe(7);
    expect(minutesFor({ isnin: {} } as any, 'isnin', 'asar', 10)).toBe(10);
    expect(minutesFor({} as any, 'isnin', 'asar', 10)).toBe(10);
  });
});

describe('content feature defaults', () => {
  it('gives the Plan 2 rotation defaults', () => {
    const s = resolveSettings({});
    expect(s.kuliahCard).toMatchObject({ durationSeconds: 15, order: 1, daysAhead: 7 });
    expect(s.penceramahPhoto).toMatchObject({ shape: 'round' });
    expect(s.pengumuman).toMatchObject({ durationSeconds: 15, order: 2, daysAhead: 7, maxItems: 5 });
    expect(s.posters).toMatchObject({ durationSeconds: 15, order: 3 });
    expect(s.programKhas).toMatchObject({ durationSeconds: 15, order: 4, daysAhead: 7, hideAfterMinutes: 5 });
    expect(s.takwim).toMatchObject({ durationSeconds: 15, order: 5, count: 3 });
    expect(s.hadis).toMatchObject({ durationSeconds: 20, order: 6, source: 'both', mix: 'list', changeEvery: 'day', perDay: 3 });
    expect(s.worldTimes).toMatchObject({ durationSeconds: 15, order: 7 });
    expect(s.tugasan).toMatchObject({ durationSeconds: 15, order: 8, daysAhead: 14 });
  });
  it('gives the Islamic content defaults', () => {
    const s = resolveSettings({});
    expect(s.ayatCard).toMatchObject({
      enabled: true, durationSeconds: 20, order: 9, pick: 'daily',
      surah: 2, ayatFrom: 255, ayatTo: 255, showTranslation: true, textSize: 'm',
    });
    expect(s.zikirSelepasSolat).toMatchObject({ durationSeconds: 20, minutesAfterSolat: 10 });
    expect(s.tilawah).toMatchObject({ enabled: false, reciter: 'Husary_64kbps', volume: 60, cacheMaxMb: 300 });
    expect(s.beeps).toMatchObject({ volume: 70 });
  });
  it('falls back to defaults for bad stored values', () => {
    expect(resolveSettings({ kuliahCard: { order: 'first' } } as any).kuliahCard.order).toBe(1);
    expect(resolveSettings({ ayatCard: { surah: 115 } } as any).ayatCard.surah).toBe(2);
    expect(resolveSettings({ tilawah: { cacheMaxMb: 10 } } as any).tilawah.cacheMaxMb).toBe(300);
  });
});

describe('content feature rules', () => {
  it('rejects out-of-range and unknown values', () => {
    expect(validateFeatureSettings('hadis', { mix: 'weekly' }).ok).toBe(false);
    expect(validateFeatureSettings('ayatCard', { surah: 115 }).ok).toBe(false);
    expect(validateFeatureSettings('ayatCard', { ayatFrom: 287 }).ok).toBe(false);
    expect(validateFeatureSettings('tilawah', { reciter: '../x' }).ok).toBe(false);
    expect(validateFeatureSettings('programKhas', { hideAfterMinutes: 200 }).ok).toBe(false);
    expect(validateFeatureSettings('kuliahCard', { order: 100 }).ok).toBe(false);
    expect(validateFeatureSettings('kuliahCard', { daysAhead: 0 }).ok).toBe(false);
    expect(validateFeatureSettings('pengumuman', { maxItems: 21 }).ok).toBe(false);
    expect(validateFeatureSettings('takwim', { count: 11 }).ok).toBe(false);
    expect(validateFeatureSettings('tilawah', { cacheMaxMb: 49 }).ok).toBe(false);
    expect(validateFeatureSettings('ticker', { speed: 'fastest' }).ok).toBe(false);
    expect(validateFeatureSettings('penceramahPhoto', { shape: 'oval' }).ok).toBe(false);
    expect(validateFeatureSettings('ayatCard', { textSize: 'xl' }).ok).toBe(false);
    expect(validateFeatureSettings('ayatCard', { pick: 'sometimes' }).ok).toBe(false);
  });
  it('accepts the allowed values unchanged', () => {
    expect(validateFeatureSettings('posters', { order: 3, durationSeconds: 30 })).toEqual({ ok: true, value: { order: 3, durationSeconds: 30 } });
    expect(validateFeatureSettings('hadis', { mix: 'random' }).ok).toBe(true);
    expect(validateFeatureSettings('ayatCard', { surah: 114, ayatFrom: 1, ayatTo: 286 }).ok).toBe(true);
    expect(validateFeatureSettings('tilawah', { reciter: 'Husary_64kbps', cacheMaxMb: 2000 }).ok).toBe(true);
    expect(validateFeatureSettings('ticker', { speed: 'slow' }).ok).toBe(true);
    expect(validateFeatureSettings('penceramahPhoto', { shape: 'square' }).ok).toBe(true);
    expect(validateFeatureSettings('ayatCard', { textSize: 'l', showTranslation: false }).ok).toBe(true);
  });
});

describe('backgrounds.images safety', () => {
  const ok = (images: unknown) => validateFeatureSettings('backgrounds', { images }).ok;
  it('accepts built-in names and uploads', () => {
    expect(ok(['default-1', '/uploads/a_b-1.jpg'])).toBe(true);
    expect(ok([])).toBe(true);
  });
  it('accepts a box asset id (64 lower-case hex) and nothing near it', () => {
    expect(ok(['a1b2c3d4'.repeat(8), 'default-1'])).toBe(true);
    expect(ok(['a1b2c3d4'.repeat(8) + '0'])).toBe(false);
    expect(ok(['a1b2c3d4'.repeat(7) + 'a1b2c3d'])).toBe(false);
    expect(ok(['A1B2C3D4'.repeat(8)])).toBe(false);
    expect(ok(['/assets/' + 'a1b2c3d4'.repeat(8)])).toBe(false);
  });
  it('rejects hostile or malformed entries', () => {
    for (const bad of ['//evil.example/x.png', 'http://x/y.png', '/uploads/../etc', '/uploads/..', 'a\\b', '\\evil','../x', 'UPPER', '/uploads/a/b', '/other/x.png', '']) {
      expect(ok([bad])).toBe(false);
    }
    expect(ok(Array.from({ length: 21 }, (_, i) => `bg-${i}`))).toBe(false);
    expect(ok(Array.from({ length: 20 }, (_, i) => `bg-${i}`))).toBe(true);
  });
  it('limits text leaves to 500 characters', () => {
    expect(validateFeatureSettings('surauInfo', { shortAddress: 'x'.repeat(501) }).ok).toBe(false);
    expect(validateFeatureSettings('liveYoutube', { descriptionTemplate: 'x'.repeat(501) }).ok).toBe(false);
    expect(validateFeatureSettings('liveYoutube', { descriptionTemplate: 'x'.repeat(500) }).ok).toBe(true);
  });
  it('resolveSettings drops invalid stored entries, falls back when none remain', () => {
    const s = resolveSettings({ backgrounds: { images: ['good-1', '//evil/x', 'http://x', '/uploads/ok.png'] } });
    expect(s.backgrounds.images).toEqual(['good-1', '/uploads/ok.png']);
    const none = resolveSettings({ backgrounds: { images: ['//evil/x'] } });
    expect(none.backgrounds.images).toEqual(['default-1', 'default-2']);
  });
});

describe('appLock', () => {
  it('is an unlocked keselamatan feature, off by default', () => {
    const f = FEATURES.find((x) => x.key === 'appLock')!;
    expect(f.group).toBe('keselamatan');
    expect(f.locked).toBe(false);
    expect(f.defaultEnabled).toBe(false);
    expect(f.labelMs).toBe('Kunci aplikasi');
    expect(f.labelEn).toBe('App lock');
    expect(resolveSettings({}).appLock.enabled).toBe(false);
  });
  it('accepts only enabled', () => {
    expect(validateFeatureSettings('appLock', { enabled: true }).ok).toBe(true);
    expect(validateFeatureSettings('appLock', { foo: 1 }).ok).toBe(false);
  });
});

describe('surauInfo', () => {
  it('is a locked skrin feature with the contract defaults', () => {
    const f = FEATURES.find((x) => x.key === 'surauInfo')!;
    expect(f.group).toBe('skrin');
    expect(f.locked).toBe(true);
    expect(f.labelMs).toBe('Maklumat surau');
    expect(f.labelEn).toBe('Surau details');
    expect(resolveSettings({}).surauInfo).toEqual({
      enabled: true, name: 'Surau', kind: 'surau', shortAddress: '', helpName: '', helpPhone: '', helpEmail: '', logo: '', showName: true,
    });
    expect(resolveSettings({ surauInfo: { enabled: false } }).surauInfo.enabled).toBe(true);
  });
  it('falls back to defaults for bad stored values', () => {
    const s = resolveSettings({ surauInfo: { name: '   ', kind: 'dewan', helpPhone: 'abc' } } as any).surauInfo;
    expect(s.name).toBe('Surau');
    expect(s.kind).toBe('surau');
    expect(s.helpPhone).toBe('');
  });
  it('accepts good values', () => {
    const good = {
      name: 'Masjid Al-Falah', kind: 'masjid', shortAddress: 'Taman Seri, Shah Alam',
      helpName: 'Encik Ahmad (Setiausaha)', helpPhone: '012-345 6789', helpEmail: 'ahmad@example.my',
    };
    expect(validateFeatureSettings('surauInfo', good)).toEqual({ ok: true, value: good });
    expect(validateFeatureSettings('surauInfo', { helpPhone: '+60123456789', helpEmail: '', helpName: '' }).ok).toBe(true);
    expect(validateFeatureSettings('surauInfo', { name: 'x'.repeat(80) }).ok).toBe(true);
  });
  it('logo is an asset id or empty text', () => {
    const ok = (p: Record<string, unknown>) => validateFeatureSettings('surauInfo', p).ok;
    expect(ok({ logo: '' })).toBe(true);
    expect(ok({ logo: 'a'.repeat(64) })).toBe(true);
    expect(ok({ logo: 'A'.repeat(64) })).toBe(false);
    expect(ok({ logo: 'a'.repeat(63) })).toBe(false);
    expect(ok({ logo: '/uploads/logo.png' })).toBe(false);
    expect(ok({ logo: '../x' })).toBe(false);
    expect(ok({ logo: null })).toBe(false);
    expect(ok({ logo: 5 })).toBe(false);
    // A bad stored logo falls back to none.
    expect(resolveSettings({ surauInfo: { logo: 'nope' } } as any).surauInfo.logo).toBe('');
    expect(resolveSettings({ surauInfo: { logo: 'b'.repeat(64) } }).surauInfo.logo).toBe('b'.repeat(64));
  });
  it('rejects bad values', () => {
    const bad = (p: Record<string, unknown>) => validateFeatureSettings('surauInfo', p).ok;
    expect(bad({ name: '' })).toBe(false);
    expect(bad({ name: '   ' })).toBe(false);
    expect(bad({ name: 'x'.repeat(81) })).toBe(false);
    expect(bad({ kind: 'dewan' })).toBe(false);
    expect(bad({ shortAddress: 'x'.repeat(121) })).toBe(false);
    expect(bad({ helpName: 'x'.repeat(61) })).toBe(false);
    expect(bad({ helpPhone: '12345' })).toBe(false);
    expect(bad({ helpPhone: 'call me' })).toBe(false);
    expect(bad({ helpPhone: '0123456789012345678901' })).toBe(false);
    expect(bad({ helpEmail: 'nope' })).toBe(false);
    expect(bad({ helpEmail: 'a@b' })).toBe(false);
    expect(bad({ helpEmail: `${'a'.repeat(120)}@example.my` })).toBe(false);
    expect(bad({ enabled: false })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
  });
});

describe('Plan 12 rules', () => {
  const ok = (k: FeatureKey, p: unknown, cur?: Record<string, unknown>) => validateFeatureSettings(k, p, cur).ok;
  const err = (k: FeatureKey, p: unknown, cur?: Record<string, unknown>) => {
    const r = validateFeatureSettings(k, p, cur);
    return r.ok ? '' : r.errors.join('; ');
  };
  it('system feature is locked, always on, with its defaults', () => {
    const f = FEATURES.find((x) => x.key === 'system')!;
    expect(f.locked && f.defaultEnabled && f.group === 'lanjutan').toBe(true);
    expect(resolveSettings({}).system).toMatchObject({ noVideoSeconds: 12, cloudWakeSeconds: 20, syncHistoryDays: 180, suspendedAt: null });
    expect(ok('system', { enabled: false })).toBe(false);
  });
  it('system values', () => {
    expect(ok('system', { syncHistoryDays: 90 })).toBe(false);
    expect(ok('system', { syncHistoryDays: 180 })).toBe(true);
    expect(ok('system', { syncHistoryDays: 365 })).toBe(true);
    expect(ok('system', { noVideoSeconds: 4 })).toBe(false);
    expect(ok('system', { noVideoSeconds: 5 })).toBe(true);
    expect(ok('system', { noVideoSeconds: 61 })).toBe(false);
    expect(ok('system', { cloudWakeSeconds: 60 })).toBe(true);
    expect(ok('system', { cloudWakeSeconds: 9 })).toBe(false);
    expect(ok('system', { suspendedAt: 'x' })).toBe(false);
    expect(ok('system', { suspendedAt: null })).toBe(true);
    expect(ok('system', { suspendedAt: '2026-11-09T10:00:00Z' })).toBe(true);
  });
  it('relayFrom, templates and messages', () => {
    expect(ok('liveYoutube', { relayFrom: 'tablet' })).toBe(false);
    expect(ok('liveYoutube', { relayFrom: 'phone' })).toBe(true);
    expect(ok('liveYoutube', { titleTemplate: 'a'.repeat(101) })).toBe(false);
    expect(ok('liveYoutube', { titleTemplate: 'a'.repeat(100) })).toBe(true);
    expect(ok('liveYoutube', { descriptionTemplate: 'a'.repeat(500) })).toBe(true);
    expect(ok('solatScreen', { message: 'a'.repeat(101) })).toBe(false);
    expect(ok('solatScreen', { message: 'a'.repeat(100) })).toBe(true);
  });
  it('colour and audio id', () => {
    expect(ok('autoTone', { override: '#12ab' })).toBe(false);
    expect(ok('autoTone', { override: '#12AB34' })).toBe(true);
    expect(ok('autoTone', { override: null })).toBe(true);
    expect(ok('firstAzanSubuh', { audioFile: 'x' })).toBe(false);
    expect(ok('firstAzanSubuh', { audioFile: 'a'.repeat(64) })).toBe(true);
    expect(ok('firstAzanSubuh', { audioFile: 'A'.repeat(64) })).toBe(false);
    expect(ok('firstAzanSubuh', { audioFile: null })).toBe(true);
  });
  it('ayat range: at most 5 verses, inside the surah', () => {
    expect(err('ayatCard', { ayatFrom: 10, ayatTo: 20 }, { surah: 2 })).toMatch(/at most 5/);
    expect(ok('ayatCard', { ayatFrom: 255, ayatTo: 256 }, { surah: 2 })).toBe(true);
    expect(ok('ayatCard', { ayatFrom: 252, ayatTo: 256 }, { surah: 2 })).toBe(true);
    expect(ok('ayatCard', { ayatFrom: 251, ayatTo: 256 }, { surah: 2 })).toBe(false);
    expect(err('ayatCard', { surah: 1, ayatTo: 8 }, { ayatFrom: 1 })).toMatch(/Al-Fatihah has 7/);
    expect(ok('ayatCard', { surah: 1, ayatFrom: 3, ayatTo: 7 }, {})).toBe(true);
    expect(err('ayatCard', { ayatFrom: 5, ayatTo: 3 }, { surah: 2 })).toMatch(/not be after/);
    // the cross-field rule reads the verse fields only: a patch that leaves them alone passes an old stored range
    expect(ok('ayatCard', { showTranslation: false }, { surah: 2, ayatFrom: 10, ayatTo: 20 })).toBe(true);
    expect(ok('ayatCard', { ayatFrom: 11 }, { surah: 2, ayatFrom: 10, ayatTo: 20 })).toBe(false);
    // without the stored copy the cross-field rule is skipped (single-field rules still apply)
    expect(ok('ayatCard', { ayatFrom: 10, ayatTo: 20 })).toBe(true);
  });
  it('moved features keep their rules', () => {
    expect(ok('cloudSync', { dirtyCheckSeconds: 59 })).toBe(false);
    expect(ok('dataSources', { esolat: { url: 'http://x.my' } })).toBe(false);
  });
});

describe('kioskTemplate', () => {
  const IDS = ['default', 'colourful', 'creative', 'oldschool', 'minimal'];
  it('is a skrin feature, on, defaulting to the current look', () => {
    const f = FEATURES.find((x) => x.key === 'kioskTemplate')!;
    expect(f.group).toBe('skrin');
    expect(f.locked).toBe(false);
    expect(f.defaults).toEqual({ templateId: 'default' });
    expect(f.labelMs).toBe('Templat paparan');
    expect(resolveSettings({}).kioskTemplate.templateId).toBe('default');
  });
  it('accepts every template id and keeps a stored one', () => {
    for (const id of IDS) {
      expect(validateFeatureSettings('kioskTemplate', { templateId: id }), id).toEqual({ ok: true, value: { templateId: id } });
      expect(resolveSettings({ kioskTemplate: { templateId: id } }).kioskTemplate.templateId).toBe(id);
    }
  });
  it('refuses an unknown, empty or non-text id, and a stored bad one reads as default', () => {
    for (const bad of ['Default', 'neon', '', 5, null, ['default']]) {
      expect(validateFeatureSettings('kioskTemplate', { templateId: bad }).ok, String(bad)).toBe(false);
      expect(resolveSettings({ kioskTemplate: { templateId: bad as any } }).kioskTemplate.templateId).toBe('default');
    }
    expect(validateFeatureSettings('kioskTemplate', { id: 'colourful' }).ok).toBe(false);
  });
});
