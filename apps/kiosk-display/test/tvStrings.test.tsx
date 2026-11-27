import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { resolveSettings } from '@surau/core';
import { STRINGS } from '../src/i18n.ts';
import { LINK_STRINGS } from '../src/i18n-box.ts';
import { OUTCOME_CODES, PROGRESS_STEPS, UNLINK_STEPS, reasonKeyOf } from '../src/data/linkState.ts';
import { Qr } from '../src/ui/Qr.tsx';
import { SafeScreen } from '../src/ui/SafeBoundary.tsx';
import { days } from './helpers.tsx';
import { srcDir } from './themeCss.ts';

/**
 * R5 (2026.11.15): no TV text is fixed in one language. Every key in the Malay table exists in English and Arabic,
 * every literal key the TV code asks t()/tb() for exists in all three, and the few fixed words that were left
 * (the preview ribbon, the QR code and the safe screen's prayer list labels) follow the TV language.
 */
afterEach(cleanup);

const src = srcDir();
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

/** Every key found in any of the three languages that is missing, or blank, in one of them ('lang.key'). */
function parityGaps(table: Record<'ms' | 'en' | 'ar', Record<string, string>>): string[] {
  const langs = ['ms', 'en', 'ar'] as const;
  const all = new Set(langs.flatMap((l) => Object.keys(table[l])));
  const gaps: string[] = [];
  for (const k of all) for (const l of langs) if (!(table[l][k] ?? '').trim()) gaps.push(`${l}.${k}`);
  return gaps;
}

describe('TV string tables', () => {
  // F31: every table, compared both ways: a key in any language must be in the other two, with text.
  for (const [name, table] of [['STRINGS', STRINGS], ['LINK_STRINGS', LINK_STRINGS]] as const) {
    it(`${name}: the three languages hold the same keys, each with text`, () => {
      expect(parityGaps(table)).toEqual([]);
    });
  }

  it('the parity check sees a key that only English or only Arabic has', () => {
    expect(parityGaps({ ms: { a: 'x' }, en: { a: 'x', b: 'y' }, ar: { a: 'x', c: ' ' } })).toEqual(['ms.b', 'ar.b', 'ms.c', 'en.c', 'ar.c']);
  });

  it('every literal key the TV code looks up exists in all three languages', () => {
    const missing = new Set<string>();
    for (const f of files(src)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\b(?:t|tb|tbx)\(\s*'([A-Za-z0-9_.]+)'/g)) {
        const k = m[1]!;
        for (const lang of ['ms', 'en', 'ar'] as const) if (!(k in STRINGS[lang])) missing.add(`${lang}.${k} (${f.slice(src.length + 1)})`);
      }
      // the link screen's own table (tl/tlx)
      for (const m of text.matchAll(/\b(?:tl|tlx)\(\s*'([A-Za-z0-9_.]+)'/g)) {
        const k = m[1]!;
        for (const lang of ['ms', 'en', 'ar'] as const) if (!(k in LINK_STRINGS[lang])) missing.add(`link ${lang}.${k} (${f.slice(src.length + 1)})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('every link screen key the TV builds from a code exists in all three languages', () => {
    const keys = [
      ...PROGRESS_STEPS.map((p) => `linkStep_${p}`),
      ...UNLINK_STEPS.filter((u) => u !== 'done').map((u) => `unlinkStep_${u.replace('-', '_')}`),
      ...OUTCOME_CODES.map((c) => reasonKeyOf(c)),
      reasonKeyOf(null),
    ];
    const missing = keys.flatMap((k) => (['ms', 'en', 'ar'] as const).filter((l) => !(k in LINK_STRINGS[l])).map((l) => `${l}.${k}`));
    expect(missing).toEqual([]);
  });
});

describe('fixed words follow the TV language', () => {
  it('the QR code is labelled in the box screen language', () => {
    const payload = 'maxcom1:abc';
    expect(render(<Qr text={payload} size={100} />).getByTestId('qr').getAttribute('aria-label')).toBe('Kod QR');
    cleanup();
    expect(render(<Qr text={payload} size={100} lang="en" />).getByTestId('qr').getAttribute('aria-label')).toBe('QR code');
    cleanup();
    expect(render(<Qr text={payload} size={100} lang="ar" />).getByTestId('qr').getAttribute('aria-label')).toBe('رمز QR');
  });

  it('the safe screen names its prayer list in the TV language', () => {
    const today = days.find((d) => d.date === '2026-11-03')!;
    const settings = resolveSettings({});
    const label = (lang: 'ms' | 'en' | 'ar') => {
      const r = render(<SafeScreen today={today} settings={settings} lang={lang} />);
      const v = r.container.querySelector('.safe__times')?.getAttribute('aria-label');
      cleanup();
      return v;
    };
    expect(label('ms')).toBe('Waktu solat');
    expect(label('en')).toBe('Prayer times');
    expect(label('ar')).toBe('مواقيت الصلاة');
  });

  it('the preview ribbon word is in every language', () => {
    expect(STRINGS.ms.previewRibbon).toBe('PRATONTON');
    expect(STRINGS.en.previewRibbon).toBe('PREVIEW');
    expect(STRINGS.ar.previewRibbon).toBe('معاينة');
  });
});
