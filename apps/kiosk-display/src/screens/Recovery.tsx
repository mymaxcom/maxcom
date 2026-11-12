import { surauNameBox, tb, tbx } from '../i18n-box.ts';
import { PrayerBar } from '../ui/PrayerBar.tsx';
import { QrCard } from '../ui/QrCard.tsx';
import { BoxClock, BoxHead, textAttrs } from './BoxChrome.tsx';
import { NetCheckButton } from './Setup.tsx';
import type { BoxScreenProps } from './Setup.tsx';

/** Smaller than the setup code: the prayer bar keeps its place under it. */
const QR_REM = 37;

function stepKeys(damaged: boolean, linked: boolean): string[] {
  const base = `recovery${damaged ? 'Damaged' : ''}${linked ? 'Linked' : 'Unlinked'}`;
  return [`${base}1`, `${base}2`, `${base}3`];
}

/**
 * No Pentadbir can sign in any more, or the database is damaged. Mockup screen 2. A readable database keeps
 * the clock and prayer bar: the jemaah still needs the times. The damaged variant has no QR from the box.
 * The prayer bar belongs to the main program, so it keeps the surau's own language.
 */
export function Recovery({ box, view, lang, surauLang, onLang, focus, onNetCheck }: BoxScreenProps) {
  const { settings, now, state } = view;
  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  const damaged = box.reason === 'db_damaged';
  const surau = box.surauName ?? surauNameBox(settings, lang);
  // An upgraded box may have no recovery code at all: no QR, and a plain word to contact the installer.
  const noCode = !damaged && box.recoveryCodeSet === false;
  const barLang = surauLang ?? (lang === 'ar' ? 'ms' : lang);

  return (
    <div class="screen screen--recovery box-screen" data-screen="recovery" data-reason={box.reason} data-lang={lang}>
      <div class="box-main">
        <BoxHead
          lang={lang}
          onLang={onLang}
          focus={focus}
          title={
            <div class="box-names">
              <div class="box-brand">
                <bdi>{surau}</bdi>
              </div>
              <div class="box-sub">
                <bdi>{box.name}</bdi>
              </div>
            </div>
          }
          end={<BoxClock now={now} timeFormat={timeFormat} showSeconds={false} lang={lang} variant="compact" />}
        />
        <div class="box-body" {...textAttrs(lang)}>
          <div class={`box-pill${damaged ? ' is-bad' : ''}`}>{tb('recoveryPill', lang)}</div>
          <h1 class="box-title">{tb(damaged ? 'recoveryTitleDamaged' : 'recoveryTitleNoAdmin', lang)}</h1>
          <p class="box-lead">{tbx(damaged ? 'recoveryWhyDamaged' : 'recoveryWhyNoAdmin', lang, { surau })}</p>
          {noCode ? (
            <div class="box-how glass" data-role="no-recovery-code">
              <h2>{tb('recoveryNoCodeMade', lang)}</h2>
              <p>{tb('recoveryNoCodeContact', lang)}</p>
            </div>
          ) : (
            <div class="box-how glass">
              <h2>{tb(box.linked ? 'recoveryHowLinked' : 'recoveryHowUnlinked', lang)}</h2>
              <ol class="box-steps">
                {stepKeys(damaged, box.linked).map((k, i) => (
                  <li key={k}>
                    <i aria-hidden="true">{i + 1}</i>
                    {tb(k, lang)}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {/* The damaged-database server has no network check route. */}
          {damaged ? null : (
            <NetCheckButton lang={lang} onNetCheck={onNetCheck} focused={focus === undefined || focus === 'net'} />
          )}
        </div>
      </div>
      {box.qr && !noCode ? (
        <QrCard
          payload={box.qr.payload}
          expiresAt={box.qr.expiresAt}
          caption={tb('recoveryCodeOnce', lang)}
          rem={QR_REM}
          keyFp={box.keyFp}
          lang={lang}
        />
      ) : null}
      {damaged ? (
        <div class="box-noprayer glass" {...textAttrs(lang)}>
          {tb('recoveryNoPrayer', lang)}
        </div>
      ) : (
        <PrayerBar state={state} settings={settings} lang={barLang} now={now} />
      )}
    </div>
  );
}
