export type TvLang = 'ms' | 'en';

/**
 * The language of the TV screen. An explicit `ms` or `en` wins while the feature is on; `auto` (the default, an
 * unknown value, or the feature switched off) follows the surau location: BM in Malaysia, English elsewhere.
 */
export function tvLanguage(settings: {
  language: { enabled: boolean; lang?: unknown };
  location: { country?: unknown };
}): TvLang {
  const { enabled, lang } = settings.language;
  if (enabled && (lang === 'ms' || lang === 'en')) return lang;
  const country = settings.location.country;
  return typeof country === 'string' && country !== '' && country !== 'MY' ? 'en' : 'ms';
}
