import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/preact';
import { Hk } from '../src/ui/Hk.tsx';
import { harakatOn, styleVars } from '../src/themes/styleVars.ts';

function src(file: string): string {
  const hit = [file, `apps/kiosk-display/${file}`].map((p) => resolve(process.cwd(), p)).find(existsSync);
  if (!hit) throw new Error(`${file} not found from ${process.cwd()}`);
  return hit;
}
const contract = readFileSync(src('src/themes/contract.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The body of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(^|\\n|\\})\\s*${esc} \\{([^}]*)\\}`));
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[2]!;
}

describe('harakat colour', () => {
  it('the three marks fonts exist, are WOFF, and are not the QPC file', () => {
    for (const f of ['mx-harakat-quran.woff', 'mx-harakat-naskh-400.woff', 'mx-harakat-naskh-700.woff']) {
      const b = readFileSync(src(`src/assets/fonts/marks/${f}`));
      expect(b.subarray(0, 4).toString('ascii')).toBe('wOFF');
      expect(b.length).toBeGreaterThan(2000);
    }
    const qpc = readFileSync(src('src/assets/fonts/qpc-hafs/KFGQPC-Hafs-V30.ttf'));
    expect(qpc.length).toBe(301356); // byte for byte the file the licence page describes: never modified
    for (const f of ['mx-harakat-quran.woff', 'mx-harakat-naskh-400.woff']) {
      expect(readFileSync(src(`src/assets/fonts/marks/${f}`)).equals(qpc)).toBe(false);
    }
  });

  it('Hk draws the text twice, the top layer hidden from readers', () => {
    const r = render(<Hk text="سُبْحَانَ اللَّهِ" class="zk-ar" />);
    expect(r.container.querySelector('p.hk.zk-ar.arab[dir="rtl"] > .hk-b')!.textContent).toBe('سُبْحَانَ اللَّهِ');
    expect(r.container.querySelector('.hk-t[aria-hidden="true"]')!.textContent).toBe('سُبْحَانَ اللَّهِ');
    const q = render(<Hk text="ٱلْحَمْدُ" quran />);
    expect(q.container.querySelector('p.hk.quran[lang="ar"]')).toBeTruthy();
  });

  it('harakat is on only with Amiri or Amiri Quran', () => {
    expect(harakatOn({ harakat: '#d9b25f', arFont: 'amiri-quran' })).toBe(true);
    expect(harakatOn({ harakat: '#d9b25f', arFont: 'amiri' })).toBe(true);
    expect(harakatOn({ harakat: '#d9b25f', arFont: 'hafs' })).toBe(false);
    expect(harakatOn({ harakat: '#d9b25f' })).toBe(false);
    expect(harakatOn({ arFont: 'amiri' })).toBe(false);
  });

  it('the stage variables carry the colour and the face; Hafs keeps the colour dormant', () => {
    const on = styleVars({ harakat: '#d9b25f', arFont: 'amiri-quran', arScale: 120, arLineHeight: 19 }, () => null);
    expect(on.vars['--harakat']).toBe('#d9b25f');
    expect(on.vars['--ar-scale']).toBe('1.2');
    expect(on.vars['--ar-lh']).toBe('1.9');
    expect(on.attrs['data-arfont']).toBe('amiri-quran');
    const dormant = styleVars({ harakat: '#d9b25f', arFont: 'hafs' }, () => null);
    expect(dormant.vars['--harakat']).toBe('#d9b25f'); // stored colour is kept
    expect(harakatOn({ harakat: '#d9b25f', arFont: 'hafs' })).toBe(false); // but not drawn
  });

  it('the top layer is positioned over the bottom one and inherits its metrics', () => {
    const t = rule(contract, '.hk-t');
    expect(t).toMatch(/position:\s*absolute/);
    expect(t).toMatch(/inset:\s*0/);
    expect(t).not.toMatch(/font-size|line-height|letter-spacing|width|word-spacing|padding|margin/);
  });

  it('the marks layer is hidden unless data-harakat is on', () => {
    expect(rule(contract, '.hk-t')).toMatch(/display:\s*none/);
    expect(contract).toContain(".stage[data-harakat='on'] .hk-t");
  });

  it('the marks layer changes only the family, and only for Amiri and Amiri Quran', () => {
    for (const sel of [".stage[data-harakat='on'][data-arfont='amiri-quran'] .hk .hk-t", ".stage[data-harakat='on'][data-arfont='amiri'] .hk .hk-t"]) {
      const body = rule(contract, sel);
      expect(body).toMatch(/^\s*font-family:\s*'MX Harakat (Quran|Naskh)';\s*$/);
    }
    expect(contract).not.toMatch(/data-arfont='hafs'\][^{]*hk-t/);
  });

  it('every Quranic font face the surau can choose is set on the Arabic classes', () => {
    expect(rule(contract, ".stage[data-arfont='hafs'] .quran")).toContain("'QPC Hafs'");
    expect(contract).toMatch(/\.stage\[data-arfont='amiri-quran'\] \.arab \{[^}]*'Amiri Quran'/);
    expect(contract).toMatch(/\.stage\[data-arfont='amiri'\] \.arab \{[^}]*'Amiri'/);
  });

  it('content.css: the size and the line height of the old cards follow Arabic size and line distance', () => {
    const css = readFileSync(src('src/content/content.css'), 'utf8');
    expect((css.match(/var\(--ar-fs[^;]*var\(--ar-scale, 1\)\)/g) ?? []).length).toBe(3);
    expect(css).toContain('line-height: var(--ar-lh, 1.85)');
    expect(css).toContain('line-height: var(--ar-lh, 1.65)');
  });
});
