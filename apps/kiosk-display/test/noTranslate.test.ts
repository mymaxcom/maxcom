import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('kiosk page: no browser translate prompt', () => {
  const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  it('marks the page translate="no" and asks the browser not to offer translation, keeping lang', () => {
    expect(html).toMatch(/<html[^>]*\blang="ms"/);
    expect(html).toMatch(/<html[^>]*\btranslate="no"/);
    expect(html).toMatch(/<meta name="google" content="notranslate"\s*\/>/);
  });
});
