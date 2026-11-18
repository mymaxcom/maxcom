import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { KioskContent, Settings, SlotFeature } from '@surau/core';
import type { ContentView } from '../data/content.ts';
import type { KioskView } from '../data/kiosk.ts';
import { hadisPlan } from '@surau/core';
import type { HadisSettings } from '@surau/core';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import { num } from './assets.ts';
import { AyatCard } from './cards/AyatCard.tsx';
import { HadisCard } from './cards/HadisCard.tsx';
import { PengumumanCard } from './cards/PengumumanCard.tsx';
import { ProgramKhasCard } from './cards/ProgramKhasCard.tsx';
import { TabungCard } from './cards/TabungCard.tsx';
import { TakwimCard } from './cards/TakwimCard.tsx';
import { TugasanCard } from './cards/TugasanCard.tsx';
import { WorldTimesCard } from './cards/WorldTimesCard.tsx';
import { screenBodyFor } from '../screens/content/index.ts';
import { ArabAyatScreen } from '../screens/content/ArabAyatScreen.tsx';
import { ArabHadisScreen } from '../screens/content/ArabHadisScreen.tsx';
import { arabLookFor } from '../screens/content/arabLook.ts';
import type { ArabBase } from '../screens/content/arabLook.ts';
import { useArabEnv } from '../themes/arabContext.ts';
import type { ArabEnv } from '../themes/arabContext.ts';
import './content.css';

export interface ContentLayerProps {
  view: KioskView;
  lang: Lang;
  content: ContentView;
  /**
   * Which feature's card is on screen right now (null when none, or when the card dropped itself because its
   * picture could not be loaded). Main uses it to lay the screen out. `arab` names the Arabic-led look the card is
   * shown in (ayat or hadis), else null.
   */
  onShown?: (feature: SlotFeature | null, arab?: ArabBase | null) => void;
}

/** What every card receives: the kiosk view (time, settings), the language and the content snapshot. */
export interface CardProps {
  view: KioskView;
  lang: Lang;
  content: KioskContent;
  /** The rotation's item for list features (pengumuman, posters, programKhas); null for single-card features. */
  itemId: string | null;
  /** When the slot comes from the rotation: its start instant (paged cards count their pages from it); else null. */
  startedAt: Date | null;
  /** The slot's length in seconds (the feature's `durationSeconds` under the `?card=` override). */
  durationSeconds: number;
  /** Which part of a long hadis this slot shows (0-based); a windowed tabung screen's showing number; else undefined. */
  page?: number;
  /**
   * A card whose whole content is one picture (posters) reports whether it is really on screen: false while
   * the picture is not available or has failed, true once it shows. The layout follows that, not the slot.
   */
  onRendered?: (rendered: boolean) => void;
}

export interface Pick {
  feature: SlotFeature;
  itemId: string | null;
  startedAt: Date | null;
  durationSeconds: number;
  page?: number;
}

const FADE_MS = 400;
const DEFAULT_SECONDS = 15;

/** First item of a feature outside the rotation (for the `?card=` override): undefined when it has nothing to show. */
function firstItemId(content: KioskContent, feature: SlotFeature): string | null | undefined {
  switch (feature) {
    case 'kuliahCard': return content.kuliah.length > 0 ? null : undefined;
    case 'pengumuman': return content.pengumuman[0]?.id;
    case 'posters': return content.posters[0]?.id;
    case 'programKhas': return content.programKhas[0]?.id;
    case 'takwim': return content.takwim.length > 0 ? null : undefined;
    case 'hadis': return content.hadisToday[0]?.id;
    case 'worldTimes': return content.worldTimes.length > 0 ? null : undefined;
    case 'tugasan': return content.tugasan.length > 0 ? null : undefined;
    case 'ayatCard': return content.ayat.today ? null : undefined;
    case 'tabungCard': return content.tabung && content.tabung.rows.length > 0 ? null : undefined;
  }
}

/** The feature's `durationSeconds` setting, as the rotation reads it. */
function featureSeconds(settings: Settings | undefined, feature: SlotFeature): number {
  const f = (settings as unknown as Record<string, { durationSeconds?: unknown } | undefined> | undefined)?.[feature];
  const n = num(f?.durationSeconds, DEFAULT_SECONDS);
  return n > 0 ? n : DEFAULT_SECONDS;
}

/** The card to show: the `?card=` override when its feature has something to show, else the rotation's current slot. */
export function pickSlot(cv: ContentView, settings?: Settings): Pick | null {
  const { content, rotation, current, override } = cv;
  if (!content) return null;
  // A forced preview screen never falls back to the rotation: no card of its own means the notice.
  if (cv.forced && !override) return null;
  if (override) {
    // The hadis proof aid shows the first hadis of the day, first part (the rotation's own hadis changes by cycle).
    const inRotation = override === 'hadis' ? undefined : rotation.find((s) => s.feature === override);
    if (inRotation) {
      const live = current && current.slot.feature === override ? current.startedAt : null;
      // A tabung screen of many pages shows this showing's run of pages (Slot.page), as the rotation would.
      const page = live && override === 'tabungCard' ? inRotation.page : undefined;
      return { feature: override, itemId: inRotation.itemId, startedAt: live, durationSeconds: inRotation.durationSeconds, ...(page !== undefined ? { page } : {}) };
    }
    const itemId = firstItemId(content, override);
    return itemId === undefined
      ? null
      : { feature: override, itemId, startedAt: null, durationSeconds: featureSeconds(settings, override) };
  }
  return current
    ? {
        feature: current.slot.feature, itemId: current.slot.itemId, startedAt: current.startedAt,
        durationSeconds: current.slot.durationSeconds, ...(current.slot.page !== undefined ? { page: current.slot.page } : {}),
      }
    : null;
}

/**
 * The Arabic-led look this card is shown in, or null for the normal look: the theme turns it on (or the preview forces
 * it), the item has Arabic, Tetapan lets Arabic show, and a hadis in parts never takes it (spec 6.8).
 */
export function arabBaseOf(feature: SlotFeature, props: CardProps, env: ArabEnv): ArabBase | null {
  const { content, itemId, view } = props;
  if (feature === 'ayatCard') {
    const a = content.ayat.today;
    const on = arabLookFor('ayat', env.looks, { arabic: !!a && a.arabic.length > 0, tetapanArabic: true });
    return on || (env.forced === 'arab-ayat' && !!a && a.arabic.length > 0) ? 'ayat' : null;
  }
  if (feature === 'hadis') {
    const h = (itemId === null ? content.hadisToday[0] : content.hadisToday.find((x) => x.id === itemId)) ?? null;
    if (!h) return null;
    const settings = (view.settings?.hadis ?? {}) as Partial<HadisSettings>;
    const plan = hadisPlan(h, settings);
    const arabic = plan.mode === 'single' && plan.showAr && !!h.textAr;
    const tetapanArabic = settings.showArabic !== false;
    const on = arabLookFor('hadis', env.looks, { arabic, tetapanArabic });
    return on || (env.forced === 'arab-hadis' && arabic && tetapanArabic) ? 'hadis' : null;
  }
  return null;
}

function renderCard(feature: SlotFeature, props: CardProps, env: ArabEnv): ComponentChildren {
  const arab = arabBaseOf(feature, props, env);
  if (arab === 'ayat') return <ArabAyatScreen {...props} />;
  if (arab === 'hadis') return <ArabHadisScreen {...props} />;
  // A card with a full-stage design of its own (poster, kuliah, hadis) renders that body instead of its card.
  const Body = screenBodyFor(feature);
  if (Body) return <Body {...props} />;
  switch (feature) {
    case 'pengumuman': return <PengumumanCard {...props} />;
    case 'programKhas': return <ProgramKhasCard {...props} />;
    case 'takwim': return <TakwimCard {...props} />;
    case 'hadis': return <HadisCard {...props} />;
    case 'worldTimes': return <WorldTimesCard {...props} />;
    case 'tugasan': return <TugasanCard {...props} />;
    case 'ayatCard': return <AyatCard {...props} />;
    case 'tabungCard': return <TabungCard {...props} />;
  }
}

interface Shown extends Pick {
  key: string;
  content: KioskContent;
}

/**
 * The rotating card region of the main screen. Renders the picked slot's card and cross-fades (400 ms) when the
 * slot changes; the outgoing card is kept from its own content snapshot so a deleted item still fades out cleanly.
 * Lives only inside Main, so no prayer phase can show it.
 */
export function ContentLayer({ view, lang, content: cv, onShown }: ContentLayerProps) {
  const env = useArabEnv();
  const pick = pickSlot(cv, view.settings);
  const shown: Shown | null = pick && cv.content
    ? { ...pick, key: `${pick.feature}|${pick.itemId ?? ''}|${pick.page ?? ''}`, content: cv.content }
    : null;
  const key = shown?.key ?? '';

  const lastRef = useRef<Shown | null>(null);
  const [leaving, setLeaving] = useState<Shown | null>(null);
  // The key of a card that told us it has nothing to show (picture failed): reported as no card on screen.
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    const last = lastRef.current;
    lastRef.current = shown;
    if (!last || last.key === key) return undefined;
    setLeaving(last);
    const timer = setTimeout(() => setLeaving(null), FADE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const shownFeature = shown && unavailable !== key ? shown.feature : null;
  // Before paint: Main lays the screen out by it (poster takeover, idle header), so the first frame is right.
  const props = (s: Shown, live: boolean): CardProps => ({
    view, lang, content: s.content, itemId: s.itemId, startedAt: s.startedAt, durationSeconds: s.durationSeconds,
    ...(s.page !== undefined ? { page: s.page } : {}),
    onRendered: live ? (ok) => setUnavailable((cur) => (ok ? (cur === s.key ? null : cur) : s.key)) : undefined,
  });
  const shownArab = shown && shownFeature ? arabBaseOf(shown.feature, props(shown, false), env) : null;
  useLayoutEffect(() => {
    onShown?.(shownFeature, shownArab);
    return () => onShown?.(null, null);
  }, [shownFeature, shownArab, onShown]);
  const slots: ComponentChildren[] = [];
  if (leaving && leaving.key !== key) {
    const node = renderCard(leaving.feature, props(leaving, false), env);
    if (node) slots.push(<div class="card-slot is-leaving" key={leaving.key} aria-hidden="true">{node}</div>);
  }
  if (shown) {
    const node = renderCard(shown.feature, props(shown, true), env);
    if (node) slots.push(<div class="card-slot" key={shown.key}>{node}</div>);
  }

  return (
    <section class="content region-main" data-layer="content">
      {slots}
      {cv.forced && slots.length === 0 ? <div class="preview-nocontent" data-testid="preview-nocontent">{t('previewNoContent', lang)}</div> : null}
    </section>
  );
}
