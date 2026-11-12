import { fingerprintGroups } from '@surau/core';
import { tb, tbx } from '../i18n-box.ts';
import { LangSwitch } from '../ui/LangSwitch.tsx';
import { BoxLogo, textAttrs } from './BoxChrome.tsx';
import type { BoxLangProps } from './BoxChrome.tsx';

/**
 * A stopped box: grey text on black, nothing of the surau. The id is the one the Pentadbir MAXCOM looks up.
 * The MAXCOM mark (dimmed) says whose service stopped; the language switch is grey and out of the way.
 */
export function Locked({ boxId, lang, onLang, focus }: { boxId: string } & BoxLangProps) {
  return (
    <div class="screen screen--locked box-screen" data-screen="locked" data-lang={lang}>
      {onLang ? (
        <div class="box-corner" dir="ltr">
          <LangSwitch lang={lang} onPick={onLang} focus={focus} tone="quiet" />
        </div>
      ) : null}
      <BoxLogo class="locked__logo" />
      <div class="locked__text" {...textAttrs(lang)}>
        <h1 class="locked__title">{tb('lockedTitle', lang)}</h1>
        <p class="locked__body">{tb('lockedBody', lang)}</p>
        <p class="locked__id num">{tbx('lockedId', lang, { id: fingerprintGroups(boxId) })}</p>
      </div>
    </div>
  );
}
