// What one TV sees: the surau settings with that TV's own choices laid over them. Pure functions, no I/O.

import type { FeatureSettings, Settings } from '../features/registry.ts';
import { isTvId } from '../features/tvProfiles.ts';
import type { TvHideKind, TvProfile } from '../features/tvProfiles.ts';
import type { KioskContent } from '../content/types.ts';
import type { KioskLive } from '../live/types.ts';

/** The profile of one TV, or undefined when the id is not a TV id or the TV has no profile (it follows the surau). */
export function tvProfileFor(settings: Pick<Settings, 'tvProfiles'>, tvId: string | null | undefined): TvProfile | undefined {
  if (!isTvId(tvId)) return undefined;
  const tvs = settings.tvProfiles?.tvs;
  if (typeof tvs !== 'object' || tvs === null || !Object.prototype.hasOwnProperty.call(tvs, tvId)) return undefined;
  const p = tvs[tvId];
  return typeof p === 'object' && p !== null ? p : undefined;
}

type FeatureOf = (s: Settings, key: keyof Settings, patch: Partial<FeatureSettings>) => FeatureSettings;
/** A copy of one feature with `patch` laid over it (the input feature object is not touched). */
const overlay: FeatureOf = (s, key, patch) => ({ ...(s[key] as FeatureSettings), ...patch });

/**
 * A NEW settings object with the profile's values over the surau's. Input is never mutated; `undefined` returns the input
 * as is. Overlaid settings: `kioskTemplate.templateId`, `orientation.mode`, `language.lang` (and `language.enabled` when
 * a language is chosen), `liveOnKiosk.{enabled, audio, volume, fit, showStrip}`, `beeps.enabled` (warning beeps),
 * `firstAzanSubuh.enabled` (the azan sound) and `tilawah.enabled`. The result holds no other TV's profile: with a `tvId`
 * `tvProfiles.tvs` is that TV's own entry, else empty.
 */
export function applyTvProfileToSettings(settings: Settings, profile: TvProfile | undefined, tvId?: string): Settings {
  if (profile === undefined) return settings;
  const out: Settings = { ...settings };
  const set = (key: keyof Settings, patch: Partial<FeatureSettings>): void => {
    (out as unknown as Record<string, FeatureSettings>)[key] = overlay(out, key, patch);
  };
  if (profile.templateId !== undefined) set('kioskTemplate', { templateId: profile.templateId });
  if (profile.orientation !== undefined) set('orientation', { mode: profile.orientation });
  if (profile.lang !== undefined) set('language', profile.lang === 'auto' ? { lang: 'auto' } : { lang: profile.lang, enabled: true });
  const l = profile.live;
  if (l !== undefined) {
    const patch: Partial<FeatureSettings> = {};
    if (l.show !== undefined) patch.enabled = l.show;
    if (l.audio !== undefined) patch.audio = l.audio;
    if (l.volume !== undefined) patch.volume = l.volume;
    if (l.fit !== undefined) patch.fit = l.fit;
    if (l.showStrip !== undefined) patch.showStrip = l.showStrip;
    set('liveOnKiosk', patch);
  }
  const s = profile.sounds;
  if (s !== undefined) {
    if (s.beeps !== undefined) set('beeps', { enabled: s.beeps });
    if (s.azan !== undefined) set('firstAzanSubuh', { enabled: s.azan });
    if (s.tilawah !== undefined) set('tilawah', { enabled: s.tilawah });
  }
  set('tvProfiles', { tvs: tvId !== undefined && isTvId(tvId) ? { [tvId]: profile } : {} });
  return out;
}

/**
 * The settings a kiosk TV is served: its own profile laid over the surau values, and never another TV's profile. A TV with
 * no profile gets the surau values with an empty `tvProfiles.tvs`.
 */
export function kioskSettingsForTv(settings: Settings, tvId: string | null | undefined): Settings {
  const profile = tvProfileFor(settings, tvId);
  if (profile !== undefined) return applyTvProfileToSettings(settings, profile, tvId as string);
  return { ...settings, tvProfiles: { ...settings.tvProfiles, tvs: {} } };
}

/** Which key of the kiosk content each hideable kind removes. `null` means the key is cleared instead of emptied. */
const KIND_KEY: Record<TvHideKind, { key: keyof KioskContent; empty: unknown }> = {
  kuliah: { key: 'kuliah', empty: [] },
  pengumuman: { key: 'pengumuman', empty: [] },
  ticker: { key: 'ticker', empty: [] },
  poster: { key: 'posters', empty: [] },
  video: { key: 'videos', empty: [] },
  programKhas: { key: 'programKhas', empty: [] },
  takwim: { key: 'takwim', empty: [] },
  hadis: { key: 'hadisToday', empty: [] },
  worldTime: { key: 'worldTimes', empty: [] },
  tugasan: { key: 'tugasan', empty: [] },
  zikir: { key: 'zikir', empty: [] },
  tabung: { key: 'tabung', empty: null },
};

/** A NEW content object without the items of the profile's `hideKinds`; order of what stays is kept. `undefined` returns the input. */
export function applyTvProfileToContent<C extends KioskContent>(content: C, profile: TvProfile | undefined): C {
  const hide = profile?.hideKinds;
  if (hide === undefined || hide.length === 0) return content;
  const out: C = { ...content };
  for (const kind of hide) {
    const e = KIND_KEY[kind];
    if (e === undefined) continue;
    // videos is absent from a box older than the video kind: leave an absent key absent
    if (e.key === 'videos' && out.videos === undefined) continue;
    (out as unknown as Record<string, unknown>)[e.key] = Array.isArray(e.empty) ? [] : e.empty;
  }
  return out;
}

/**
 * The live state one TV is told. `live.show === false` makes the TV see no live; `audio` and `volume` come from the
 * profile when set. No profile (or no live part) returns the input as is.
 */
export function applyTvProfileToLive(live: KioskLive, profile: TvProfile | undefined): KioskLive {
  const l = profile?.live;
  if (l === undefined) return live;
  const audio = l.audio ?? live.audio;
  const volume = l.volume ?? live.volume;
  if (l.show === false) {
    const { waiting: _waiting, ...rest } = live;
    return { ...rest, live: false, since: null, audio, volume };
  }
  return { ...live, audio, volume };
}
