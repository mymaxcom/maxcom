import { dateOf, formatRm } from '@surau/core';
import type { TabungRow } from '@surau/core';
import { t } from '../../i18n.ts';
import type { Lang } from '../../i18n.ts';
import { assetSrc } from '../assets.ts';
import type { CardProps } from '../ContentLayer.tsx';
import { useFit } from '../paging.ts';

/** Columns readable from 10 m: the card holds at most this many funds, in the order the admin set. */
const MAX_COLUMNS = 4;

/** `RM` and the figure apart, so the figure can be set large and the currency small. */
function split(sen: number): { rm: string; figure: string } {
  const text = formatRm(sen);
  const i = text.indexOf(' ');
  return { rm: text.slice(0, i), figure: text.slice(i + 1) };
}

const pct = (value: number, target: number): number => (target > 0 ? Math.max(0, Math.min(100, Math.floor((value * 100) / target))) : 0);

// The card's measures in rem, as content.css sets them: inner width of a wide card, QR box and its gap, column gap, column side padding.
const CARD_INNER = 90;
const QR_BOX = 14;
const COL_GAP = 1;
const COL_PAD = 2.5;
const FIGURE_MAX = 4.6;
/** Width of the small `RM` and its margin, in ems of the figure. */
const RM_EM = 0.85;

/** Width of a figure in ems of its own size (tabular digits; the comma and the point are narrower). */
const figureEm = (figure: string): number => [...figure].reduce((sum, c) => sum + (c >= '0' && c <= '9' ? 0.6 : 0.32), 0);

/** One size for every figure on the card, the largest at which the longest one still fits its column on one line. */
function figureRem(figures: string[], hasQr: boolean): number {
  const inner = CARD_INNER - (hasQr ? QR_BOX : 0);
  const column = (inner - (figures.length - 1) * COL_GAP) / figures.length - COL_PAD;
  return Math.min(FIGURE_MAX, (column * 0.97) / (Math.max(...figures.map(figureEm)) + RM_EM));
}

/** The KL calendar date as dd/mm/yyyy; a value that is not an instant is shown by its date part. */
function shownDate(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  const ymd = Number.isNaN(ms) ? iso.slice(0, 10) : dateOf(new Date(ms), tz);
  return ymd.split('-').reverse().join('/');
}

/** A fund's name in its two-line box: a long one shrinks until it fits, and the figures below stay level across the columns. */
function FundName({ name, hot, lang }: { name: string; hot: boolean; lang: Lang }) {
  const { ref, fit } = useFit<HTMLSpanElement>(`${name}|${hot}|${lang}`);
  return (
    <span class="tabung__name" ref={ref} style={`--name-fit:${fit}`}>
      <span>
        {name}
        {hot ? <span class="tabung__new">{t('tabungNew', lang)}</span> : null}
      </span>
    </span>
  );
}

/**
 * The donation fund card: one column per public tabung (balance, a small line or a target bar), the DuitNow QR when
 * the surau uploaded one. A tabung changed a moment ago is highlighted (no amount shown); the manual variant lists
 * the rows an admin typed while finance is off.
 */
export function TabungCard({ view, lang, content }: CardProps) {
  const tabung = content.tabung;
  const rows = tabung ? tabung.rows.slice(0, MAX_COLUMNS) : [];
  const nowMs = view.now.getTime();
  const isHot = (r: TabungRow): boolean => r.highlightUntil !== null && Date.parse(r.highlightUntil) > nowMs;
  const { ref, fit } = useFit<HTMLUListElement>(JSON.stringify([rows, lang]));
  if (!tabung || rows.length === 0) return null;
  const qr = assetSrc(tabung.qrAssetId);
  const updated = tabung.updatedAt ? shownDate(tabung.updatedAt, view.tz) : null;
  const figure = tabung.manual ? null : figureRem(rows.map((r) => split(r.valueSen).figure), qr !== null);

  const sub = (r: TabungRow) => {
    if (tabung.manual) return null;
    if (r.targetSen !== null && r.subLabel === null) {
      const p = pct(r.valueSen, r.targetSen);
      const [before, after] = t('tabungTarget', lang).replace('{pct}', String(p)).split('{target}') as [string, string];
      return (
        <span class="tabung__target">
          <span class="tabung__bar" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${p}%` }} />
          </span>
          <small>{before}<span class="tabung__amount">{formatRm(r.targetSen)}</span>{after}</small>
        </span>
      );
    }
    if (r.subLabel !== null && r.subSen !== null) {
      return <small class="tabung__sub">{r.subLabel}: <span class="tabung__amount">{formatRm(r.subSen)}</span></small>;
    }
    return null;
  };

  return (
    <article class={`card glass card--wide card--tabung${tabung.manual ? ' card--tabung-manual' : ''}`} data-card="tabung">
      <div class="tabung__main">
        <header class="tabung__head">
          <span class="card__tag">{tabung.manual ? tabung.title : t('tabungTag', lang)}</span>
          {updated ? <span class="tabung__updated">{t('tabungUpdated', lang).replace('{date}', updated)}</span> : null}
        </header>
        <ul class="tabung__list" ref={ref} style={`--fit:${fit}${figure === null ? '' : `;--figure:${figure.toFixed(2)}rem`}`}>
          {rows.map((r) => {
            const hot = isHot(r);
            const money = split(r.valueSen);
            return (
              <li class={`tabung__col${hot ? ' tabung__col--hot' : ''}`} key={r.id} data-fund={r.id}>
                <FundName name={r.name} hot={hot} lang={lang} />
                <span class="tabung__value">
                  <small>{money.rm}</small>
                  <b class="num">{money.figure}</b>
                </span>
                {tabung.manual ? null : <span class="tabung__foot">{sub(r)}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      {qr ? (
        <figure class="tabung__qr">
          <img src={qr} alt="" />
          <figcaption>{t('tabungQr', lang)}</figcaption>
        </figure>
      ) : null}
    </article>
  );
}
