import { createContext } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, RefObject } from 'preact';
import { dateOf, formatRm, TABUNG_SHOWING_MAX_PAGES, tabungFeatured, tabungHot, tabungPages, tabungShownPage, tabungWindowPage } from '@surau/core';
import type { Settings, TabungPage, TabungRow } from '@surau/core';
import { t } from '../../i18n.ts';
import type { Lang } from '../../i18n.ts';
import { assetSrc, num } from '../assets.ts';
import type { CardProps } from '../ContentLayer.tsx';
import { pageAt, useFit } from '../paging.ts';

const DEFAULT_SECONDS = 15;

/** `RM` and the figure apart, so the figure can be set large and the currency small. */
function split(sen: number): { rm: string; figure: string } {
  const text = formatRm(sen);
  const i = text.indexOf(' ');
  return { rm: text.slice(0, i), figure: text.slice(i + 1) };
}

const pct = (value: number, target: number): number => (target > 0 ? Math.max(0, Math.min(100, Math.floor((value * 100) / target))) : 0);

/** A fund with a target bar: the server leaves the target out when Tetapan showTarget is off, and a Jumaat fund keeps its small line. */
const withTarget = (r: TabungRow): r is TabungRow & { targetSen: number } => r.targetSen !== null && r.targetSen > 0 && r.subLabel === null;

/** The time of one page: Tetapan tabungCard.durationSeconds, as the rotation reads it (it gives the card pages x this). */
function pageSeconds(settings: Settings | undefined): number {
  const card = (settings as unknown as Record<string, { durationSeconds?: unknown } | undefined> | undefined)?.tabungCard;
  const n = num(card?.durationSeconds, DEFAULT_SECONDS);
  return n > 0 ? n : DEFAULT_SECONDS;
}

/** The KL calendar date as dd/mm/yyyy; a value that is not an instant is shown by its date part. */
function shownDate(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  const ymd = Number.isNaN(ms) ? iso.slice(0, 10) : dateOf(new Date(ms), tz);
  return ymd.split('-').reverse().join('/');
}

/** Fills a `{a}` template with nodes, so an amount inside a sentence can be set apart (bold, never wrapped). */
function fill(template: string, parts: Record<string, ComponentChildren>): ComponentChildren[] {
  return template.split(/(\{\w+\})/).filter((s) => s !== '').map((s) => {
    const m = /^\{(\w+)\}$/.exec(s);
    return m && m[1]! in parts ? parts[m[1]!] : s;
  });
}

/** The smallest figure size a group is set to: a figure that would need less is cut by its box, never drawn at size 0. */
export const FIGURE_FIT_MIN = 0.2;

/**
 * The size factor (`--k`) of a figure group set at `cur` whose figures measure `need` px in boxes `w` px wide: the
 * largest at which every figure fits, at most 1, at least FIGURE_FIT_MIN; null when nothing was measured.
 */
export function figureFitFactor(cur: number, sizes: readonly { w: number; need: number }[]): number | null {
  let k = Infinity;
  for (const { w, need } of sizes) if (w > 0 && need > 0) k = Math.min(k, (w * cur) / need);
  if (k === Infinity) return null;
  return k >= 1 ? 1 : Math.max(FIGURE_FIT_MIN, Math.floor(k * 0.98 * 1000) / 1000);
}

/**
 * Every figure stays on one line (RM 1,248,900.00 included): when the page (`key`: the page, its hot funds, the
 * language and the font-load count) or the body's fit changes, the figures of a group are measured against their boxes
 * and the group gets one size, the largest at which its longest figure fits (`--k`). Not on every render: the clock
 * ticks every second and the figures do not change with it. No-op where nothing is laid out (jsdom).
 */
function useFigureFit(key: string, fit: number): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const groups = [...root.querySelectorAll<HTMLElement>('[data-fig-group]')];
    for (const g of groups) {
      const cur = Number(g.style.getPropertyValue('--k')) || 1;
      const sizes = [...g.querySelectorAll<HTMLElement>('.tabung__value')].map((v) => ({ w: v.parentElement ? v.parentElement.clientWidth : 0, need: v.offsetWidth }));
      const next = figureFitFactor(cur, sizes);
      if (next !== null && Math.abs(next - cur) > 0.004) g.style.setProperty('--k', String(next));
    }
  }, [key, fit]);
  return ref;
}

/**
 * Counts the web font loads that finish while the card is up. A weight or face the browser first fetches when the
 * card draws it (the bold figures, Amiri in Old School) lands after the first fit; the count is part of every fit key,
 * so the names and figures are measured again in the real font.
 */
function useFontEpoch(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || typeof fonts.addEventListener !== 'function') return undefined;
    const bump = (): void => setN((x) => x + 1);
    fonts.addEventListener('loadingdone', bump);
    return () => fonts.removeEventListener('loadingdone', bump);
  }, []);
  return n;
}
const FontEpoch = createContext(0);

/** A fund's name, at most two lines: a long one shrinks until it fits (useFit). */
function FundName({ name, hot, lang }: { name: string; hot: boolean; lang: Lang }) {
  const epoch = useContext(FontEpoch);
  const { ref, fit } = useFit<HTMLSpanElement>(`${name}|${hot}|${lang}|${epoch}`);
  return (
    <span class="tabung__name" ref={ref} style={`--name-fit:${fit}`}>
      <span>
        {name}
        {hot ? <span class="tabung__new">{t('tabungNew', lang)}</span> : null}
      </span>
    </span>
  );
}

function Money({ sen }: { sen: number }) {
  const m = split(sen);
  return (
    <span class="tabung__fig">
      <span class="tabung__value"><small>{m.rm}</small><b class="num">{m.figure}</b></span>
    </span>
  );
}

/** The gold eight-point star of the "Baru" moment. */
function Rosette() {
  return (
    <svg class="tabung__rosette" viewBox="0 0 100 100" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="4">
        <rect x="22" y="22" width="56" height="56" />
        <rect x="22" y="22" width="56" height="56" transform="rotate(45 50 50)" />
      </g>
      <circle cx="50" cy="50" r="11" fill="currentColor" />
    </svg>
  );
}

function Thanks({ lang }: { lang: Lang }) {
  return (
    <span class="tabung__thanks">
      <b>{t('tabungNewTitle', lang)}</b>
      <span>{t('tabungThanks', lang)}</span>
    </span>
  );
}

function Bar({ p }: { p: number }) {
  return (
    <span class="tabung__bar" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${p}%` }} />
    </span>
  );
}

/** Under a fund: big percent, thick bar and the target (or "Sasaran tercapai"); else its small line; else nothing. */
function Progress({ r, lang, targetText = true }: { r: TabungRow; lang: Lang; targetText?: boolean }) {
  if (withTarget(r)) {
    const p = pct(r.valueSen, r.targetSen);
    const done = r.valueSen >= r.targetSen;
    return (
      <span class="tabung__prog">
        <b class="tabung__pct num">{p}%</b>
        <Bar p={p} />
        {!targetText ? null : done ? (
          <span class="tabung__done">{t('tabungDone', lang)}</span>
        ) : (
          <span class="tabung__tgt">{fill(t('tabungOfTarget', lang), { target: <b class="tabung__amount">{formatRm(r.targetSen)}</b> })}</span>
        )}
      </span>
    );
  }
  if (r.subLabel !== null && r.subSen !== null) {
    return (
      <span class="tabung__prog">
        <span class="tabung__sub">{r.subLabel}: <b class="tabung__amount">{formatRm(r.subSen)}</b></span>
      </span>
    );
  }
  return null;
}

/** The progress ring of a single or featured fund, the percent in its middle. */
function Ring({ r, lang }: { r: TabungRow & { targetSen: number }; lang: Lang }) {
  const p = pct(r.valueSen, r.targetSen);
  const done = r.valueSen >= r.targetSen;
  const c = 2 * Math.PI * 84;
  return (
    <span class="tabung__ring" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="84" class="tabung__ring-track" />
        <circle
          cx="100" cy="100" r="84" class="tabung__ring-fill"
          stroke-dasharray={`${((c * p) / 100).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 100 100)"
        />
      </svg>
      <span class="tabung__ring-c">
        <b class="num">{p}%</b>
        <span>{done ? t('tabungDone', lang) : t('tabungReached', lang)}</span>
      </span>
    </span>
  );
}

function FundRow({ r, hot, lang, manual }: { r: TabungRow; hot: boolean; lang: Lang; manual: boolean }) {
  if (hot) {
    return (
      <li class="tabung__row is-hot" data-fund={r.id}>
        <span class="tabung__hotname"><Rosette /><FundName name={r.name} hot lang={lang} /></span>
        <Thanks lang={lang} />
      </li>
    );
  }
  const done = withTarget(r) && r.valueSen >= r.targetSen;
  return (
    <li class={`tabung__row${done ? ' is-done' : ''}`} data-fund={r.id}>
      <FundName name={r.name} hot={false} lang={lang} />
      <Money sen={r.valueSen} />
      {manual ? null : <Progress r={r} lang={lang} />}
    </li>
  );
}

/** The large fund (one fund only, or the featured one): ring when it has a target, very large amount, target and what is left. */
function HeroInfo({ r, hot, lang, compact }: { r: TabungRow; hot: boolean; lang: Lang; compact: boolean }) {
  if (hot) {
    return (
      <span class="tabung__hinfo">
        <span class="tabung__hotname"><Rosette /><FundName name={r.name} hot lang={lang} /></span>
        <Thanks lang={lang} />
      </span>
    );
  }
  let foot: ComponentChildren = null;
  if (withTarget(r)) {
    const left = Math.max(0, r.targetSen - r.valueSen);
    const target = <b class="tabung__amount">{formatRm(r.targetSen)}</b>;
    if (r.valueSen >= r.targetSen) foot = <span class="tabung__done">{t('tabungDone', lang)}</span>;
    else if (compact) foot = <span class="tabung__tgt">{fill(t('tabungOfTargetLeft', lang), { target, left: <b class="tabung__amount">{formatRm(left)}</b> })}</span>;
    else {
      foot = (
        <>
          <span class="tabung__tgt">{fill(t('tabungOfTarget', lang), { target })}</span>
          <span class="tabung__needed">{t('tabungNeeded', lang).replace('{amount}', formatRm(left))}</span>
        </>
      );
    }
  } else if (r.subLabel !== null && r.subSen !== null) {
    foot = <span class="tabung__sub">{r.subLabel}: <b class="tabung__amount">{formatRm(r.subSen)}</b></span>;
  }
  return (
    <span class="tabung__hinfo" data-fig-group>
      <FundName name={r.name} hot={false} lang={lang} />
      <Money sen={r.valueSen} />
      {foot}
    </span>
  );
}

/** Dots past this many pages would crowd the header: the page number alone then. */
const MAX_DOTS = 12;

function Dots({ at, of, lang }: { at: number; of: number; lang: Lang }) {
  if (of < 2) return null;
  return (
    <span class="tabung__dots" aria-label={`${t('tabungPages', lang)} ${at + 1}/${of}`}>
      {of > MAX_DOTS ? null : Array.from({ length: of }, (_, i) => <i key={i} class={i === at ? 'is-on' : ''} />)}
      <span class="num">{at + 1}/{of}</span>
    </span>
  );
}

function PageBody({ page, lang, manual, nowMs, dots }: { page: TabungPage; lang: Lang; manual: boolean; nowMs: number; dots: ComponentChildren }) {
  switch (page.kind) {
    case 'rows':
      return (
        <ul class={`tabung__rows n-${Math.max(2, page.rows.length)}`} data-fig-group>
          {page.rows.map((r) => <FundRow key={r.id} r={r} hot={tabungHot(r, nowMs)} lang={lang} manual={manual} />)}
        </ul>
      );
    case 'single': {
      const r = page.row;
      const hot = tabungHot(r, nowMs);
      return (
        <div class={`tabung__single${withTarget(r) && !hot ? ' has-ring' : ''}`} data-fund={r.id}>
          {withTarget(r) && !hot ? <Ring r={r} lang={lang} /> : null}
          <HeroInfo r={r} hot={hot} lang={lang} compact={false} />
        </div>
      );
    }
    case 'featured': {
      const h = page.hero;
      const hot = tabungHot(h, nowMs);
      return (
        <div class="tabung__feat">
          <div class={`tabung__fhero${withTarget(h) && !hot ? ' has-ring' : ''}`} data-fund={h.id}>
            {withTarget(h) && !hot ? <Ring r={h} lang={lang} /> : null}
            <HeroInfo r={h} hot={hot} lang={lang} compact />
          </div>
          <span class="tabung__fsub"><span>{t('tabungOthers', lang)}</span>{dots}</span>
          <ul class="tabung__minis" data-fig-group>
            {page.minis.map((r) => {
              const mh = tabungHot(r, nowMs);
              return (
                <li key={r.id} class={`tabung__mini${mh ? ' is-hot' : ''}`} data-fund={r.id}>
                  <FundName name={r.name} hot={mh} lang={lang} />
                  {mh ? <span class="tabung__thanks"><b>{t('tabungNewTitle', lang)}</b></span> : <Money sen={r.valueSen} />}
                  {mh ? null : <Progress r={r} lang={lang} targetText={false} />}
                </li>
              );
            })}
          </ul>
        </div>
      );
    }
    // Never on screen while a fund is hot (tabungShownPage shows the hot fund's own page), so no "Baru" here.
    case 'summary': {
      const half = Math.ceil(page.rows.length / 2);
      const col = (list: TabungRow[]) => (
        <ul class="tabung__scol">
          {list.map((r) => {
            const m = split(r.valueSen);
            return (
              <li key={r.id} class="tabung__srow" data-fund={r.id}>
                <span class="tabung__sname">{r.name}</span>
                <span class="tabung__samt num"><small>{m.rm}</small>{m.figure}</span>
              </li>
            );
          })}
        </ul>
      );
      return (
        <div class="tabung__summary">
          <div class="tabung__sgrid">{col(page.rows.slice(0, half))}{col(page.rows.slice(half))}</div>
          {page.totalSen === null ? null : (
            <div class="tabung__total" data-fig-group>
              <span>{t('tabungTotal', lang)}</span>
              <Money sen={page.totalSen} />
            </div>
          )}
        </div>
      );
    }
  }
}

/**
 * The donation screen: the public funds in the admin's order as large rows (at most 4 a page, balanced), the DuitNow QR
 * on the right when the surau uploaded one; one fund as a ring, the featured fund (Tetapan) large above small tiles, and
 * a summary page with the total when the funds take two pages or more. A fund changed a moment ago is highlighted with
 * no amount or percent ("Baru"), its page first. The manual variant (finance off) lists the typed rows the same way.
 */
/** The funds on a page. */
function rowsOf(page: TabungPage): TabungRow[] {
  switch (page.kind) {
    case 'single': return [page.row];
    case 'featured': return [page.hero, ...page.minis];
    default: return page.rows;
  }
}

export function TabungCard({ view, lang, content, startedAt, page: showing }: CardProps) {
  const tabung = content.tabung;
  const nowMs = view.now.getTime();
  const pages = tabungPages(tabung, tabungFeatured(view.settings));
  // A showing from the rotation turns through at most TABUNG_SHOWING_MAX_PAGES pages, the run of this showing
  // (`showing`, Slot.page); the `?card=` aid with no slot (startedAt null) turns through them all by the KL clock.
  const run = startedAt ? Math.min(pages.length, TABUNG_SHOWING_MAX_PAGES) : pages.length;
  const clock = run > 1 ? pageAt(view.now, startedAt, pageSeconds(view.settings), run, view.tz) : 0;
  const at = tabungShownPage(pages, nowMs, startedAt ? tabungWindowPage(pages.length, showing ?? 0, clock) : clock);
  const page = pages[at];
  const epoch = useFontEpoch();
  // The hot funds are part of the key: a "Baru" row is laid out differently, so its start and its end fit the page again.
  const hotIds = page ? rowsOf(page).filter((r) => tabungHot(r, nowMs)).map((r) => r.id) : [];
  const pageKey = page ? JSON.stringify([page, hotIds, lang, epoch]) : '';
  const { ref: fitRef, fit } = useFit<HTMLDivElement>(pageKey);
  const figRef = useFigureFit(pageKey, fit);
  if (!tabung || !page) return null;
  const qr = page.kind === 'summary' ? null : assetSrc(tabung.qrAssetId);
  const updated = tabung.updatedAt ? shownDate(tabung.updatedAt, view.tz) : null;
  const dots = <Dots at={at} of={pages.length} lang={lang} />;
  const title = tabung.manual ? tabung.title : page.kind === 'summary' ? t('tabungAll', lang).replace('{n}', String(page.count)) : t('tabungTitle', lang);

  return (
    <article
      class={`tabung card--tabung${tabung.manual ? ' card--tabung-manual' : ''}${qr ? ' has-qr' : ' no-qr'}`}
      data-card="tabung" data-page-kind={page.kind} ref={figRef}
    >
      <section class="tabung__panel glass">
        <header class="tabung__head">
          <h2 class="tabung__title">{title}</h2>
          {updated ? <span class="tabung__updated">{t('tabungUpdated', lang).replace('{date}', updated)}</span> : null}
          {page.kind === 'featured' ? null : dots}
        </header>
        <div class="tabung__body" ref={fitRef} style={`--fit:${fit}`}>
          <FontEpoch.Provider value={epoch}>
            <PageBody page={page} lang={lang} manual={tabung.manual} nowMs={nowMs} dots={page.kind === 'featured' ? dots : null} />
          </FontEpoch.Provider>
        </div>
      </section>
      {qr ? (
        <aside class="tabung__qr glass">
          <span class="tabung__qrbox"><img src={qr} alt={t('tabungQrName', lang)} /></span>
          <b class="tabung__qrtitle">{t('tabungQrTitle', lang)}</b>
          <span class="tabung__qrname">{t('tabungQrName', lang)}</span>
          <span class="tabung__qrhint">{t('tabungQrHint', lang)}</span>
        </aside>
      ) : null}
    </article>
  );
}
