/*
 * 2026.11.11 merged into plan-14: a notice picture (`pengumuman.pictureAssetId`) on a cloud with two suraus.
 * A picture pushed by A's box is held by A alone (`surau_assets`), the notice that names it is accepted for A,
 * and B cannot name A's picture: not from a phone (signed op), not through the API, not to analyze it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import type { OpResult } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { sha256hex } from '../src/auth/crypto.ts';
import { loginAs, TEST_PIN } from './authHelpers.ts';
import { jpeg } from './support/jpeg.ts';
import { signOp } from './support/signOp.ts';
import { insertSite } from './support/sites.ts';
import type { TestSite } from './support/sites.ts';

const A = 'surau-a';
const B = 'surau-b';
const AT = klInstant('2026-11-16', '12:00');
const EDITED = '2026-11-16T03:00:00.000Z';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noNetwork = (async () => { throw new TypeError('network disabled in tests'); }) as unknown as typeof fetch;

function rig(): { app: FastifyInstance; sa: TestSite; sb: TestSite } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-pictenant-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'c.db'), { dataDir: dir, role: 'cloud', now: () => AT, fetchImpl: noNetwork });
  apps.push(app);
  const ins = app.surau.db.prepare('INSERT INTO suraus (id, name, created_at, created_by) VALUES (?, ?, ?, ?)');
  ins.run(A, 'Surau A', AT.toISOString(), 'test');
  ins.run(B, 'Surau B', AT.toISOString(), 'test');
  return { app, sa: insertSite(app.surau.db, { surauId: A, boxId: 'a1a1a1a1a1a1a1a1' }), sb: insertSite(app.surau.db, { surauId: B, boxId: 'b2b2b2b2b2b2b2b2' }) };
}

const notice = (pictureAssetId: string, title = 'Gotong-royong') => ({
  title, body: 'Sabtu ini selepas Subuh.', from: '2026-11-16', to: '2026-11-30', priority: 2, pictureAssetId,
});

const held = (app: FastifyInstance, assetId: string): string[] =>
  app.surau.db.prepare('SELECT surau_id FROM surau_assets WHERE asset_id = ? ORDER BY surau_id').all(assetId).map((r) => String(r.surau_id));
const noticeOf = (app: FastifyInstance, surau: string, id: string): Record<string, unknown> | undefined => {
  const row = app.surau.db.prepare("SELECT json FROM content_items WHERE surau_id = ? AND kind = 'pengumuman' AND id = ? AND deleted_at IS NULL").get(surau, id);
  return row === undefined ? undefined : (JSON.parse(String(row.json)) as Record<string, unknown>);
};

/** A's box sends the picture bytes, then the notice through its feed (the agent's order: entries, then assets). */
async function seedFromBoxA(app: FastifyInstance, sa: TestSite): Promise<string> {
  const bytes = jpeg(4321);
  const id = sha256hex(bytes);
  const pushed = await app.inject({
    method: 'POST', url: '/api/sync/ops', headers: sa.headers,
    payload: { entries: [{
      seq: 1, entity: 'content:pengumuman', entityId: 'n-a', rev: `${EDITED}|local`, editedAt: EDITED, syncedAt: EDITED,
      actor: 'local', deviceId: null, origin: 'local', opId: null, after: { id: 'n-a', ...notice(id) },
    }] },
  });
  expect(pushed.statusCode).toBe(200);
  expect(pushed.json()).toMatchObject({ applied: 1, refused: 0 });
  const up = await app.inject({ method: 'PUT', url: `/api/sync/assets/${id}`, headers: { ...sa.headers, 'content-type': 'image/jpeg' }, payload: bytes });
  expect(up.statusCode).toBe(201);
  return id;
}

describe('pengumuman.pictureAssetId on a multi-surau cloud', () => {
  it('a notice with a picture synced from A\'s box is accepted for A, and the picture is held by A only', async () => {
    const { app, sa } = rig();
    const id = await seedFromBoxA(app, sa);
    expect(noticeOf(app, A, 'n-a')?.pictureAssetId).toBe(id);
    expect(noticeOf(app, B, 'n-a')).toBeUndefined();
    expect(held(app, id)).toEqual([A]);

    // A's own admin may edit the notice and keep naming the picture (positive control for the held check)
    const adminA = await loginAs(app, 'admin', TEST_PIN, A);
    const put = await app.inject({ method: 'PUT', url: '/api/content/pengumuman/n-a2', headers: adminA.headers, payload: notice(id, 'Notis A') });
    expect(put.statusCode).toBe(201);
    expect(put.json().item.pictureAssetId).toBe(id);
    const analyzeA = await app.inject({ method: 'GET', url: `/api/assets/${id}/analyze`, headers: adminA.headers });
    expect(analyzeA.statusCode).not.toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/assets', headers: adminA.headers })).body).toContain(id);
  });

  it('B cannot name A\'s picture: API 409, signed phone op refused, analyze 404, not in B\'s list, nothing written in B', async () => {
    const { app, sa } = rig();
    const id = await seedFromBoxA(app, sa);
    const adminB = await loginAs(app, 'admin', TEST_PIN, B);

    const put = await app.inject({ method: 'PUT', url: '/api/content/pengumuman/n-b', headers: adminB.headers, payload: notice(id, 'Curi') });
    expect(put.statusCode).toBe(409);
    expect(JSON.stringify(put.json())).toContain('pictureAssetId');

    const op = await signOp(adminB, app.surau.boxId, { kind: 'content.put', entity: 'content:pengumuman', entityId: 'n-b2', payload: notice(id, 'Curi 2'), surauId: B });
    const sent = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: adminB.headers, payload: { ops: [op] } });
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { results: OpResult[] }).results[0]!.status).toBe('refused');

    expect(noticeOf(app, B, 'n-b')).toBeUndefined();
    expect(noticeOf(app, B, 'n-b2')).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: `/api/assets/${id}/analyze`, headers: adminB.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/assets', headers: adminB.headers })).body).not.toContain(id);
    expect(held(app, id)).toEqual([A]);

    // once B holds the same bytes itself (its own upload, counted for B), B may name them
    const own = await app.inject({ method: 'POST', url: '/api/assets', headers: { ...adminB.headers, 'content-type': 'image/jpeg' }, payload: jpeg(4321) });
    expect([200, 201]).toContain(own.statusCode);
    expect(held(app, id)).toEqual([A, B]);
    const again = await app.inject({ method: 'PUT', url: '/api/content/pengumuman/n-b', headers: adminB.headers, payload: notice(id, 'Milik B') });
    expect(again.statusCode).toBe(201);
  });
});
