import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { KioskContent } from '@surau/core';
import { makeView } from './helpers.tsx';
import { HadisCard, planHadisPages } from '../src/content/cards/HadisCard.tsx';
import { paginateAyat } from '../src/content/cards/AyatCard.tsx';
import { splitForPages } from '../src/content/paging.ts';

/**
 * Larger text sizes page, they never cut: the pure splitting and the paging decision at the XL factor (1.3), with the
 * layout stubbed (jsdom has none): text "overflows" its box while its characters times the fit times the text-size
 * factor exceed what the box holds.
 */

const WORDS = (s: string): string[] => s.split(/\s+/).filter((w) => w !== '');

const SENTENCES = Array.from({ length: 12 }, (_, i) => `Ini ialah ayat nombor ${i + 1} yang agak panjang untuk dibaca.`).join(' ');

describe('splitForPages', () => {
  it('keeps every word, in order, over at most n balanced pages', () => {
    for (const n of [1, 2, 3, 5, 12]) {
      const pages = splitForPages(SENTENCES, n);
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.length).toBeLessThanOrEqual(n);
      expect(WORDS(pages.join(' '))).toEqual(WORDS(SENTENCES));
      expect(pages.every((p) => p.trim() !== '')).toBe(true);
    }
    const three = splitForPages(SENTENCES, 3).map((p) => p.length);
    expect(Math.max(...three) - Math.min(...three)).toBeLessThan(SENTENCES.length / 3 / 2);
  });

  it('cuts at a sentence end when one is near the even share', () => {
    const [a, b] = splitForPages(SENTENCES, 2);
    expect(a!.endsWith('.')).toBe(true);
    expect(b!.startsWith('Ini ialah')).toBe(true);
  });

  it('keeps line breaks, never makes an empty page, and gives words back when there are fewer than pages', () => {
    expect(splitForPages('satu\ndua tiga empat', 2).join(' ')).toContain('satu\ndua');
    expect(splitForPages('', 3)).toEqual([]);
    expect(splitForPages('a b', 5)).toEqual(['a', 'b']);
  });
});

describe('planHadisPages', () => {
  const AR = 'الْمُسْلِمُ أَخُو الْمُسْلِمِ لَا يَظْلِمُهُ وَلَا يُسْلِمُهُ مَنْ كَانَ فِي حَاجَةِ أَخِيهِ كَانَ اللَّهُ فِي حَاجَتِهِ';

  it('is one page with everything while it fits', () => {
    expect(planHadisPages(AR, SENTENCES, 1)).toEqual([{ ar: AR, ms: SENTENCES }]);
  });

  it('over several pages shows the Arabic first and the Malay after, losing no word of either', () => {
    const plan = planHadisPages(AR, SENTENCES, 4);
    expect(plan).toHaveLength(4);
    expect(WORDS(plan.map((p) => p.ar ?? '').join(' '))).toEqual(WORDS(AR));
    expect(WORDS(plan.map((p) => p.ms).join(' '))).toEqual(WORDS(SENTENCES));
    const firstMs = plan.findIndex((p) => p.ms !== '');
    expect(plan.slice(0, firstMs).every((p) => p.ar !== null && p.ms === '')).toBe(true);
    expect(plan.slice(firstMs).every((p) => p.ar === null)).toBe(true);
  });
});

describe('paginateAyat at the XL factor (1.3)', () => {
  const sentence = (n: number): string => `Ayat ${n}: ${'kata '.repeat(28)}`.trim();
  const card = {
    arabic: Array.from({ length: 4 }, () => 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ '.repeat(3).trim()),
    malay: Array.from({ length: 4 }, (_, i) => sentence(i + 1)),
  };
  const opts = { showTranslation: true, textSize: 'm' as const };

  it('needs more pages than at size S, and every ayat is still on some page', () => {
    const s = paginateAyat(card, opts);
    const xl = paginateAyat(card, { ...opts, scale: 1.3 });
    expect(xl.length).toBeGreaterThan(s.length);
    for (const pages of [s, xl]) {
      const seen = new Set<number>();
      for (const p of pages) for (let i = p.from; i <= p.to; i++) seen.add(i);
      expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    }
  });

  it('is unchanged by a factor of 1 and by none', () => {
    expect(paginateAyat(card, { ...opts, scale: 1 })).toEqual(paginateAyat(card, opts));
  });
});

describe('HadisCard pages a long hadis instead of cutting it (layout stubbed)', () => {
  const CAPACITY = 400; // characters one card holds at the usual size
  let scale = 1;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stub = (prop: 'clientHeight' | 'scrollHeight', get: (el: HTMLElement) => number): void => {
    descriptors.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return get(this);
      },
    });
  };
  const isBody = (el: HTMLElement): boolean => el.classList.contains('hadis__body');

  beforeEach(() => {
    stub('clientHeight', (el) => (isBody(el) ? 100 : 0));
    stub('scrollHeight', (el) => {
      if (!isBody(el)) return 0;
      const fit = Number(/--fit:\s*([\d.]+)/.exec(el.getAttribute('style') ?? '')?.[1] ?? '1');
      const chars = (el.textContent ?? '').length;
      return chars * fit * scale > CAPACITY ? 150 : 100;
    });
  });
  afterEach(() => {
    cleanup();
    for (const [prop, d] of descriptors) {
      if (d) Object.defineProperty(HTMLElement.prototype, prop, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
    descriptors.clear();
  });

  // A long hadis of about 450 characters: more than the 400 the card holds, but at size S a smaller fit (0.85) is enough.
  const BODY = Array.from({ length: 11 }, (_, i) => `Kalimah nombor ${i + 1} dalam hadis ini dibaca.`).join(' ');
  const hadis = { id: 'h1', textMs: BODY, shown: true, updatedAt: '2026-11-01T00:00:00Z', updatedBy: 't' };
  const content = { hadisToday: [hadis] } as unknown as KioskContent;
  const started = new Date('2026-11-03T08:00:00Z');
  const textAt = (secondsIn: number): string => {
    const view = makeView('2026-11-03', '16:00', { at: new Date(started.getTime() + secondsIn * 1000) });
    const r = render(<HadisCard view={view} lang="ms" content={content} itemId="h1" startedAt={started} durationSeconds={20} />);
    const card = r.container.querySelector('[data-card="hadis"]')!;
    const out = {
      text: card.querySelector('.hadis__ms')?.textContent ?? '',
      sub: card.querySelector('.hadis__sub')?.textContent ?? null,
    };
    r.unmount();
    return JSON.stringify(out);
  };

  it('at size S the hadis fits one page: no page counter, the whole text', () => {
    scale = 1;
    const o = JSON.parse(textAt(1)) as { text: string; sub: string | null };
    expect(o.sub).toBeNull();
    expect(WORDS(o.text)).toEqual(WORDS(BODY));
  });

  it('at XL (1.3) it takes pages, each for an equal share of the slot, and no word is lost across them', () => {
    scale = 1.3;
    const first = JSON.parse(textAt(1)) as { text: string; sub: string | null };
    expect(first.sub).toMatch(/^1 \/ \d+$/);
    const n = Number(first.sub!.split('/')[1]);
    expect(n).toBeGreaterThan(1);
    const seen: string[] = [];
    for (let i = 0; i < n; i++) {
      const o = JSON.parse(textAt(1 + (i * 20) / n + 0.01)) as { text: string; sub: string | null };
      expect(o.sub).toBe(`${i + 1} / ${n}`);
      seen.push(o.text);
    }
    expect(WORDS(seen.join(' '))).toEqual(WORDS(BODY));
  });
});
