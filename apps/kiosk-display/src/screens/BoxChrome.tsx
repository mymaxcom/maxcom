import type { ComponentChildren } from 'preact';
import logoUrl from '../assets/brand/maxcom-logo.svg';
import { fmtAt, fmtClock } from '../format.ts';
import { dirOf } from '../i18n-box.ts';
import type { BoxLang } from '../i18n-box.ts';
import { Clock } from '../ui/Clock.tsx';
import type { ClockProps } from '../ui/Clock.tsx';
import { LangSwitch } from '../ui/LangSwitch.tsx';
import type { BoxFocus } from '../ui/LangSwitch.tsx';
// After styles.css (imported first by app.tsx), so these rules win for the box screens.
import './box-screens.css';

/** Arabic morning and evening marks for a 12-hour time. */
const AR_AMPM: Record<string, string> = { AM: 'ص', PM: 'م' };

/** Language props every box screen takes. Without `onLang` the switch is not drawn (tests, the admin preview). */
export interface BoxLangProps {
  lang: BoxLang;
  onLang?: (lang: BoxLang) => void;
  focus?: BoxFocus;
}

/** `lang` and `dir` for a block of box-screen text. */
export function textAttrs(lang: BoxLang): { lang: string; dir: 'rtl' | 'ltr' } {
  return { lang, dir: dirOf(lang) };
}

/** An instant as clock text: the kiosk's own words in Malay and English, ص / م in Arabic. */
export function fmtAtBox(iso: string | null, timeFormat: '12h' | '24h', lang: BoxLang): string | null {
  if (lang !== 'ar') return fmtAt(iso, timeFormat, lang);
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const c = fmtClock(d, timeFormat, false, 'en');
  return c.ampm ? `${c.hm} ${AR_AMPM[c.ampm] ?? c.ampm}` : c.hm;
}

/**
 * The kiosk clock in a box screen's language. Malay and English are the kiosk's own Clock; Arabic draws the same
 * markup with ص / م, so Clock.tsx (shared with the main program) does not learn a third language.
 */
export function BoxClock(props: Omit<ClockProps, 'lang'> & { lang: BoxLang }) {
  const { lang, ...rest } = props;
  if (lang !== 'ar') return <Clock {...rest} lang={lang} />;
  const { now, timeFormat, showSeconds, variant = 'hero', tz } = rest;
  const c = fmtClock(now, timeFormat, showSeconds, 'en', tz);
  const ampm = c.ampm ? (AR_AMPM[c.ampm] ?? c.ampm) : '';
  if (variant === 'compact') {
    return (
      <div class="phase__clock" role="timer" data-role="clock" dir="ltr">
        <span class="num">{c.hm}</span>
        {showSeconds ? <small class="num">{c.s}</small> : null}
        {ampm ? <small lang="ar">{ampm}</small> : null}
      </div>
    );
  }
  const aside = showSeconds || ampm;
  return (
    <div class="clock" role="timer" data-role="clock" dir="ltr">
      <span class="clock__hm num">{c.hm}</span>
      {aside ? (
        <span class="clock__aside">
          {showSeconds ? <span class="num">{c.s}</span> : null}
          {ampm ? <span lang="ar">{ampm}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/** The MAXCOM wordmark (dome and letters), sized by height in the CSS. */
export function BoxLogo({ class: cls }: { class?: string }) {
  return <img class={`box-logo${cls ? ` ${cls}` : ''}`} src={logoUrl} alt="MAXCOM" data-role="maxcom-logo" />;
}

/**
 * The top row of a box screen: the MAXCOM wordmark and what this screen is (or, in recovery, the surau and the
 * box), then the language switch and the clock. The row itself stays left to right in every language: the brand
 * keeps its place and the switch never jumps away from the pointer that just clicked it.
 */
export function BoxHead({
  lang,
  onLang,
  focus,
  title,
  end,
}: BoxLangProps & { title: ComponentChildren; end?: ComponentChildren }) {
  return (
    <header class="box-head box-head--brand" dir="ltr">
      <div class="box-brandrow">
        <BoxLogo />
        <span class="box-brandrow__rule" aria-hidden="true" />
        <div class="box-brandrow__title" {...textAttrs(lang)}>
          {title}
        </div>
      </div>
      <div class="box-head__end">
        {onLang ? <LangSwitch lang={lang} onPick={onLang} focus={focus} /> : null}
        {end}
      </div>
    </header>
  );
}
