export type TvLang = 'ms' | 'en' | 'ar';

/**
 * The language of the TV screen. An explicit `ms`, `en` or `ar` wins while the feature is on; `auto` (the default,
 * an unknown value, or the feature switched off) follows the surau location: BM in Malaysia, English elsewhere.
 * `ar` is accepted by the settings validation from 2026.11.13: the cloud must run that build before a box or the app
 * can store it. An older cloud answers a direct save (PUT) with 400 and a box's sync push with 200 `refused: invalid`
 * (that entry is parked on the box and sent again once the cloud is upgraded).
 */
export function tvLanguage(settings: {
  language: { enabled: boolean; lang?: unknown };
  location: { country?: unknown };
}): TvLang {
  const { enabled, lang } = settings.language;
  if (enabled && (lang === 'ms' || lang === 'en' || lang === 'ar')) return lang;
  const country = settings.location.country;
  return typeof country === 'string' && country !== '' && country !== 'MY' ? 'en' : 'ms';
}
