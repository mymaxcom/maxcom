import { describe, expect, it } from 'vitest';
import { getRegistration, listRegistrations } from '../src/sync/workerRegs.ts';

const BOX = '0123456789abcdef';
const HASH = 'a'.repeat(64);

const config = (reg: Record<string, unknown>) => ({
  url: 'https://worker.test',
  token: 't',
  fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
    const list = String(input).endsWith('/_admin/reg');
    return new Response(JSON.stringify(list ? { regs: [{ boxId: BOX, ...reg }] } : reg), { status: 200 });
  }) as typeof fetch,
});

describe('Worker registrations carry the box fields', () => {
  it('lists box name, platform and version', async () => {
    const [r] = await listRegistrations(config({ claimHash: HASH, name: 'Surau', at: 'x', boxName: 'Kotak A', platform: 'android', version: '2026.11.4' }));
    expect(r).toMatchObject({ boxId: BOX, boxName: 'Kotak A', platform: 'android', version: '2026.11.4' });
    expect(await getRegistration(config({ claimHash: HASH, name: 'S', at: 'x', boxName: 'Kotak A', platform: 'windows', version: '2026.11.4' }), BOX)).toMatchObject({ platform: 'windows', boxName: 'Kotak A' });
  });

  it('an old entry has none of them, and a bad value is dropped and cleaned', async () => {
    const [old] = await listRegistrations(config({ claimHash: HASH, name: 'Surau', at: 'x' }));
    expect(Object.keys(old!).sort()).toEqual(['at', 'boxId', 'claimHash', 'name']);
    const [bad] = await listRegistrations(config({ claimHash: HASH, name: 'S', at: 'x', boxName: 'Ko‮tak\u0007' + 'z'.repeat(80), platform: 'ios', version: '2026.11' }));
    expect(bad!.boxName).toBe('Kotak' + 'z'.repeat(55));
    expect(bad).not.toHaveProperty('platform');
    expect(bad).not.toHaveProperty('version');
  });
});
