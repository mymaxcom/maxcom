import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEntry } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { applyFeedEntry } from '../src/sync/apply.ts';
import { getSettings } from '../src/settingsStore.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { signOp } from './support/signOp.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeApp(): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-ssr-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir });
  apps.push(app);
  return app;
}

const put = (app: FastifyInstance, login: Login, feature: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/api/settings/${feature}`, headers: login.headers, payload: payload as object });

const send = async (app: FastifyInstance, login: Login, entityId: string, payload: unknown, editedAt = new Date().toISOString()) => {
  const op = await signOp(login, app.surau.boxId, { kind: 'settings.put', entity: 'settings', entityId, payload, editedAt });
  const r = await app.inject({ method: 'POST', url: '/api/sync/ops', headers: login.headers, payload: { ops: [op] } });
  return r.json().results[0] as { status: string; reason: string | null };
};

/** An old stored row, written the way an earlier version allowed it. */
function seed(db: DatabaseSync, feature: string, json: unknown): void {
  const at = '2026-01-01T00:00:00.000Z';
  db.prepare(
    'INSERT INTO settings (feature, json, updated_at, updated_by, rev, edited_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(feature) DO UPDATE SET json = excluded.json',
  ).run(feature, JSON.stringify(json), at, 'old', `${at}|local`, at, 'local');
}

const entry = (feature: string, after: Record<string, unknown>, at: string): FeedEntry => ({
  seq: 1, entity: 'settings', entityId: feature, rev: `${at}|dev-x`, editedAt: at, syncedAt: at, actor: 'user:x', deviceId: null, origin: 'cloud', opId: null, after,
});
const ctx = (dir: string) => ({ now: new Date(), origin: 'cloud', actor: 'user:x', dataDir: dir });

const stored = (db: DatabaseSync, feature: string): Record<string, unknown> =>
  JSON.parse(String(db.prepare('SELECT json FROM settings WHERE feature = ?').get(feature)?.json)) as Record<string, unknown>;

const OLD_TITLE = 'T'.repeat(120);

describe('the ayatCard cross-field rule runs on the server', () => {
  it('a local route refuses a range the surah does not have or longer than 5 verses, and accepts a good one', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    // default surah is Al-Baqarah (286 verses); 10..20 is 11 verses
    const bad = await put(app, admin, 'ayatCard', { ayatFrom: 10, ayatTo: 20 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors.join(' ')).toMatch(/at most 5/);
    expect((await put(app, admin, 'ayatCard', { surah: 1, ayatFrom: 1, ayatTo: 8 })).statusCode).toBe(400); // Al-Fatihah has 7
    const ok = await put(app, admin, 'ayatCard', { ayatFrom: 255, ayatTo: 256 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(getSettings(app.surau.db).ayatCard).toMatchObject({ ayatFrom: 255, ayatTo: 256 });
    // a patch against the stored copy: moving only ayatTo past the 5-verse limit is refused
    expect((await put(app, admin, 'ayatCard', { ayatTo: 270 })).statusCode).toBe(400);
  });

  it('a signed op is held to it too', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    expect(await send(app, admin, 'ayatCard', { ayatFrom: 10, ayatTo: 20 })).toMatchObject({ status: 'refused', reason: 'invalid' });
    expect((await send(app, admin, 'ayatCard', { ayatFrom: 255, ayatTo: 256 })).status).toBe('applied');
  });

  it('a replicated entry is not cross-checked', () => {
    const app = makeApp();
    const e = entry('ayatCard', { ayatFrom: 10, ayatTo: 20 }, '2026-11-09T10:00:00.000Z');
    expect(applyFeedEntry(app.surau.db, e, ctx(dirs[0]!)).status).toBe('applied');
    expect(getSettings(app.surau.db).ayatCard).toMatchObject({ ayatFrom: 10, ayatTo: 20 });
  });

  it('an old stored range that breaks the rule does not block a save that does not touch the verses', async () => {
    const app = makeApp();
    const admin = await loginAs(app, 'admin');
    seed(app.surau.db, 'ayatCard', { surah: 2, ayatFrom: 10, ayatTo: 20 });
    const r = await put(app, admin, 'ayatCard', { showTranslation: false });
    expect(r.statusCode, r.body).toBe(200);
    expect(getSettings(app.surau.db).ayatCard).toMatchObject({ ayatFrom: 10, ayatTo: 20, showTranslation: false });
    // touching a verse field re-checks the whole range
    expect((await put(app, admin, 'ayatCard', { ayatFrom: 11 })).statusCode).toBe(400);
    expect((await put(app, admin, 'ayatCard', { ayatFrom: 16 })).statusCode).toBe(200);
  });
});

describe('old stored values do not block a save or a feed entry that leaves them alone', () => {
  it('a route: an unchanged stale leaf passes, a changed one is held to the rule', async () => {
    const app = makeApp();
    const sup = await loginAs(app, 'superadmin');
    seed(app.surau.db, 'liveYoutube', { titleTemplate: OLD_TITLE, maxBitrateKbps: 2500 });
    // the other field changes; the stale one is not part of it
    expect((await put(app, sup, 'liveYoutube', { maxBitrateKbps: 3000 })).statusCode).toBe(200);
    // the whole row sent back with the stale value unchanged
    const same = await put(app, sup, 'liveYoutube', { titleTemplate: OLD_TITLE, maxBitrateKbps: 3500 });
    expect(same.statusCode, same.body).toBe(200);
    expect(stored(app.surau.db, 'liveYoutube')).toMatchObject({ titleTemplate: OLD_TITLE, maxBitrateKbps: 3500 });
    // a new long value is still refused, and so is an out-of-range value on another field
    expect((await put(app, sup, 'liveYoutube', { titleTemplate: 'U'.repeat(120) })).statusCode).toBe(400);
    expect((await put(app, sup, 'liveYoutube', { titleTemplate: OLD_TITLE, maxBitrateKbps: 7000 })).statusCode).toBe(400);
    // an unknown key is refused whatever is stored
    expect((await put(app, sup, 'liveYoutube', { nope: 1 })).statusCode).toBe(400);
  });

  it('a signed op: the same', async () => {
    const app = makeApp();
    const sup = await loginAs(app, 'superadmin');
    seed(app.surau.db, 'liveYoutube', { titleTemplate: OLD_TITLE });
    expect((await send(app, sup, 'liveYoutube', { titleTemplate: OLD_TITLE, maxBitrateKbps: 3000 })).status).toBe('applied');
    expect(await send(app, sup, 'liveYoutube', { titleTemplate: 'U'.repeat(120) })).toMatchObject({ status: 'refused', reason: 'invalid' });
  });

  it('a feed entry carrying the whole row with one stale unchanged field is applied', () => {
    const app = makeApp();
    seed(app.surau.db, 'liveYoutube', { titleTemplate: OLD_TITLE, maxBitrateKbps: 2500 });
    const e = entry('liveYoutube', { titleTemplate: OLD_TITLE, maxBitrateKbps: 4000, privacy: 'public' }, '2026-11-09T10:00:00.000Z');
    expect(applyFeedEntry(app.surau.db, e, ctx(dirs[0]!)).status).toBe('applied');
    expect(stored(app.surau.db, 'liveYoutube')).toMatchObject({ titleTemplate: OLD_TITLE, maxBitrateKbps: 4000, privacy: 'public' });
    // a changed stale-looking value is checked as ever
    const bad = entry('liveYoutube', { titleTemplate: 'U'.repeat(120) }, '2026-11-09T11:00:00.000Z');
    expect(applyFeedEntry(app.surau.db, bad, ctx(dirs[0]!)).status).toBe('refused');
  });
});
