import { useEffect, useRef, useState } from 'preact/hooks';
import { BOX_LANGS, LANG_NAMES, tb } from '../i18n-box.ts';
import type { BoxLang } from '../i18n-box.ts';

/** Where the remote's focus is on a box screen: a language on the switch, the screen's own button, or nowhere yet. */
export type BoxFocus = BoxLang | 'net' | null;

export interface LangSwitchProps {
  lang: BoxLang;
  onPick: (lang: BoxLang) => void;
  /** The remote's focus, drawn as the white ring; a mouse click never moves it. */
  focus?: BoxFocus;
  /** 'quiet' is the grey version for the stopped screen. */
  tone?: 'normal' | 'quiet';
}

/**
 * BM / EN / عربي, the same segmented control as mymaxcom.my at TV size. Each choice is written in its own
 * language, so anyone can find theirs. It is driven like the rest of the box screens: a click with a mouse or
 * touch, or the remote's arrows and OK (handled by the screen, never by DOM focus, so OK cannot fire twice).
 * The order never mirrors, so the choices stay put when the screen turns right to left.
 */
export function LangSwitch({ lang, onPick, focus = null, tone = 'normal' }: LangSwitchProps) {
  return (
    <div class="langswitch" data-tone={tone} role="group" aria-label={tb('boxLangLabel', lang)} dir="ltr" data-testid="lang-switch">
      {BOX_LANGS.map((l) => (
        <button
          key={l}
          type="button"
          tabIndex={-1}
          lang={l}
          class={`langswitch__opt${focus === l ? ' is-focused' : ''}`}
          aria-pressed={l === lang ? 'true' : 'false'}
          data-lang={l}
          // A click must not leave DOM focus on the button: OK on the remote is the screen's, not the button's.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(l)}
        >
          {LANG_NAMES[l]}
        </button>
      ))}
    </div>
  );
}

type NavKey = 'left' | 'right' | 'up' | 'down' | 'next' | 'prev';

/** Arrow keys and Tab as remote moves; anything else is not ours. */
export function navKeyOf(ev: { key?: string; shiftKey?: boolean }): NavKey | null {
  switch (ev.key) {
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Tab':
      return ev.shiftKey ? 'prev' : 'next';
    default:
      return null;
  }
}

/**
 * The next focus on a screen with the switch at the top and (when `hasNet`) one button at the bottom.
 * Up, or left/right from the button, goes to the switch at the current language; left/right walk the switch;
 * down returns to the button. Tab walks BM, EN, عربي, then the button, and round again.
 */
export function nextFocus(focus: BoxFocus, key: NavKey, hasNet: boolean, lang: BoxLang): BoxFocus {
  const ring: BoxFocus[] = hasNet ? [...BOX_LANGS, 'net'] : [...BOX_LANGS];
  if (key === 'next' || key === 'prev') {
    const at = focus === null ? (key === 'next' ? -1 : ring.length) : ring.indexOf(focus);
    const step = key === 'next' ? 1 : -1;
    return ring[(at + step + ring.length) % ring.length] ?? null;
  }
  if (focus === null || focus === 'net') {
    if (key === 'down') return hasNet ? 'net' : focus;
    return lang;
  }
  const i = BOX_LANGS.indexOf(focus);
  if (key === 'left') return BOX_LANGS[Math.max(0, i - 1)] ?? focus;
  if (key === 'right') return BOX_LANGS[Math.min(BOX_LANGS.length - 1, i + 1)] ?? focus;
  if (key === 'down') return hasNet ? 'net' : focus;
  return focus;
}

/**
 * The remote's focus on a box screen (setup, recovery, pairing, stopped). Off while the network check is open,
 * which has its own. The screen's button holds the focus to begin with, so a single OK still opens the check.
 */
export function useBoxNav(opts: { enabled: boolean; hasNet: boolean; lang: BoxLang }): BoxFocus {
  const { enabled, hasNet } = opts;
  const [focus, setFocus] = useState<BoxFocus>(hasNet ? 'net' : null);
  const live = useRef(opts);
  live.current = opts;
  useEffect(() => {
    setFocus(hasNet ? 'net' : null);
  }, [enabled, hasNet]);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (ev: KeyboardEvent): void => {
      const k = navKeyOf(ev);
      if (k === null) return;
      if (k === 'next' || k === 'prev') ev.preventDefault();
      setFocus((f) => nextFocus(f, k, live.current.hasNet, live.current.lang));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
  return enabled ? focus : null;
}
