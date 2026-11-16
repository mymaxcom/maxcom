import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { srcDir } from './themeCss.ts';

// Theme round 2 (operator 2026-11-16): the layer under text over a background picture, and the gold outline.
const contract = readFileSync(resolve(srcDir(), 'themes/contract.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...contract.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));

describe('a picture under the text', () => {
  it('the scrim, the plates and the glow apply only while a picture is on (no theme changes without one)', () => {
    const picture = rules.filter((r) => /scrim-rgb|--glow|text-shadow: var\(--glow\)/.test(r.body) && !/--outline-gold/.test(r.body));
    expect(picture.length).toBeGreaterThan(3);
    for (const r of picture) for (const s of r.sel.split(',')) expect(s, s).toContain('[data-picture]');
    expect(rules.find((r) => r.sel === '.bg__scrim')!.body).toMatch(/display:\s*none/);
  });
  it('the glow is cheap: at most two shadows, no blur over 0.6rem', () => {
    for (const m of contract.matchAll(/--glow:\s*([^;]+);/g)) {
      const shadows = m[1]!.split(/,(?![^(]*\))/);
      expect(shadows.length).toBeLessThanOrEqual(2);
      for (const sh of shadows) {
        const blur = sh.trim().split(/\s+/)[2] ?? '0';
        expect(parseFloat(blur)).toBeLessThanOrEqual(0.6);
      }
    }
  });
});

describe('the gold outline ("Garis emas pada tajuk")', () => {
  const gold = rules.filter((r) => /var\(--outline-gold\)/.test(r.body));
  it('is drawn by Default, Old School and Arabic Art only, and switched off by data-gold="off"', () => {
    expect(gold.length).toBe(1);
    const sel = gold[0]!.sel;
    expect(sel).toContain(":not([data-gold='off'])");
    for (const t of ['default', 'oldschool', 'arabic']) expect(sel).toContain(`[data-template='${t}']`);
    for (const t of ['colourful', 'creative', 'minimal']) expect(sel).not.toContain(`[data-template='${t}']`);
  });
  it('reaches only large Latin text, never body, Arabic or small text, and never uses text-stroke', () => {
    const sel = gold[0]!.sel;
    for (const big of ['.clock__hm', '.phase__big', '.ident__name', '.brand-name', '.kul-name']) expect(sel).toContain(big);
    for (const no of ['.arab', '.hadis', '.kul-topic', '.kul-facts', 'pcell', 'chip', 'ticker', 'shell-date']) expect(sel).not.toContain(no);
    expect(contract).not.toMatch(/text-stroke/);
  });
});
