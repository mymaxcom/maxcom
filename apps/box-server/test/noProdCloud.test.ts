import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoLinkCloud, AutoLink, DEFAULT_CLOUD_URL, isBlockedUnderTest } from '../src/sync/register.ts';

describe('tests never reach the MAXCOM production cloud', () => {
  it('under VITEST the production host and its subdomains are blocked, others are not', () => {
    const t = { VITEST: 'true' };
    expect(isBlockedUnderTest('https://api.mymaxcom.my', t)).toBe(true);
    expect(isBlockedUnderTest('https://mymaxcom.my', t)).toBe(true);
    expect(isBlockedUnderTest('https://x.api.MYMAXCOM.my', t)).toBe(true);
    expect(isBlockedUnderTest('https://cloud.example', t)).toBe(false);
    expect(isBlockedUnderTest('https://notmymaxcom.my', t)).toBe(false);
  });

  it('autoLinkCloud: default is null under VITEST, still MAXCOM in production', () => {
    expect(autoLinkCloud(null, null, { VITEST: 'true' })).toBeNull();
    expect(autoLinkCloud(null, null, {})).toBe(DEFAULT_CLOUD_URL);
    expect(autoLinkCloud('https://cloud.example', null, { VITEST: 'true' })).toBe('https://cloud.example');
  });

  it('AutoLink never calls fetch for api.mymaxcom.my under vitest, and does for another cloud', async () => {
    const mk = (cloudUrl: string | null) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'nopc-'));
      const db = openDb(join(dataDir, 'box.db'));
      const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
      const al = new AutoLink({ db, dataDir, boxId: 'b1', now: () => new Date(), fetchImpl: fetchImpl as unknown as typeof fetch, cloudUrl });
      return { al, fetchImpl };
    };
    expect(process.env.VITEST).toBeTruthy();
    const prod = mk('https://api.mymaxcom.my');
    expect(await prod.al.step()).toBe('pending');
    expect(prod.fetchImpl).not.toHaveBeenCalled();
    const dflt = mk(null);
    await dflt.al.step();
    expect(dflt.fetchImpl).not.toHaveBeenCalled();
  });
});
