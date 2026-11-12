import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installPreviewListener,
  preparePreviewAssets,
  previewAssetUrl,
  resetPreviewForTest,
} from '../src/data/preview.ts';

const POSTER = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const TOKEN = 'tok_ABC-123';

let created: string[];
let revoked: string[];
let fetches: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  fetches = [];
  window.history.replaceState(null, '', '/?preview=1');
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: () => {
      const u = `blob:p-${created.length + 1}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => {
      revoked.push(u);
    },
  }));
  installPreviewListener();
  const send = (data: unknown): void => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin, source: window }));
  };
  send({ type: 'surau-preview', token: TOKEN });
  send({ type: 'surau-preview-poster', assetId: POSTER, title: 'Kempen' });
});

afterEach(() => {
  resetPreviewForTest();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const fakeFetch = (async (input: RequestInfo | URL) => {
  fetches.push(String(input));
  await new Promise((r) => setTimeout(r, 5));
  return new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 });
}) as typeof fetch;

describe('preview picture cache', () => {
  it('a reload of the content (which does not list the poster) keeps the poster URL', async () => {
    await preparePreviewAssets([POSTER, OTHER], fakeFetch);
    const url = previewAssetUrl(POSTER);
    expect(url).not.toBeNull();
    await preparePreviewAssets([OTHER], fakeFetch);
    expect(previewAssetUrl(POSTER)).toBe(url);
    expect(revoked).not.toContain(url);
  });

  it('two overlapping prepares for the same id create one object URL', async () => {
    await Promise.all([preparePreviewAssets([OTHER], fakeFetch), preparePreviewAssets([OTHER], fakeFetch)]);
    const live = [previewAssetUrl(OTHER), previewAssetUrl(POSTER)];
    for (const u of created) expect(live.includes(u) || revoked.includes(u)).toBe(true);
    expect(fetches.filter((f) => f === `/assets/${OTHER}`)).toHaveLength(1);
  });
});
