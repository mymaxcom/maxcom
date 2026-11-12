import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { SurauLogo } from '../src/ui/Logo.tsx';

afterEach(() => cleanup());

/** Pretend the picture decoded at w x h pixels and fire `load`. */
async function loaded(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
  img.dispatchEvent(new Event('load'));
  await new Promise((res) => setTimeout(res, 0));
}

describe('SurauLogo sizing hints', () => {
  it('reports a wide wordmark (aspect > 2) and caps the height at twice its bitmap', async () => {
    const r = render(<SurauLogo src="/surau-logo?v=1" class="ident__logo" />);
    const img = r.container.querySelector('img[data-role="logo"]') as HTMLImageElement;
    expect(img.getAttribute('data-shape')).toBeNull();
    expect(img.style.getPropertyValue('--logo-cap')).toBe('');
    await loaded(img, 500, 126);
    expect(img.getAttribute('data-shape')).toBe('wide');
    expect(img.style.getPropertyValue('--logo-cap')).toBe('252px');
  });

  it('reports a compact (square) logo', async () => {
    const r = render(<SurauLogo src="/surau-logo?v=2" class="ident__logo" />);
    const img = r.container.querySelector('img[data-role="logo"]') as HTMLImageElement;
    await loaded(img, 96, 96);
    expect(img.getAttribute('data-shape')).toBe('compact');
    expect(img.style.getPropertyValue('--logo-cap')).toBe('192px');
  });

  it('forgets the hints when the URL changes and sets none for a picture without pixel size', async () => {
    const r = render(<SurauLogo src="/surau-logo?v=3" class="ident__logo" />);
    const img = r.container.querySelector('img[data-role="logo"]') as HTMLImageElement;
    await loaded(img, 500, 126);
    expect(img.getAttribute('data-shape')).toBe('wide');
    r.rerender(<SurauLogo src="/surau-logo?v=4" class="ident__logo" />);
    const img2 = r.container.querySelector('img[data-role="logo"]') as HTMLImageElement;
    expect(img2.getAttribute('src')).toBe('/surau-logo?v=4');
    expect(img2.getAttribute('data-shape')).toBeNull();
    expect(img2.style.getPropertyValue('--logo-cap')).toBe('');
    await loaded(img2, 0, 0);
    expect(img2.getAttribute('data-shape')).toBeNull();
    expect(img2.style.getPropertyValue('--logo-cap')).toBe('');
  });
});

describe('SurauLogo plate', () => {
  it('sets no plate when canvas analysis is unavailable (jsdom)', async () => {
    const r = render(<SurauLogo src="/surau-logo?v=9" class="ident__logo" />);
    const img = r.container.querySelector('img[data-role="logo"]') as HTMLImageElement;
    await loaded(img, 500, 126);
    expect(img.getAttribute('data-plate')).toBeNull();
  });
});
