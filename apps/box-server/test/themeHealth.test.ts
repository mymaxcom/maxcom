import { mkdtempSync, rmSync } from 'node:fs';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SHELL_ONLY_SCREEN_IDS } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { PACK_MIME } from '../src/themes/packFormat.ts';
import { activeThemeHealth, parseHealthBody, recordThemeHealth } from '../src/themes/health.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';
import { insertSite } from './support/sites.ts';
import { jpeg, manifestJson as json, zip } from './support/themePacks.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const open = (dir: string): FastifyInstance => {
  const app = buildApp(join(dir, 'test.db'));
  apps.push(app);
  return app;
};
async function setup(): Promise<{ app: FastifyInstance; dir: string; admin: Login['headers'] }> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-themehealth-'));
  dirs.push(dir);
  const app = open(dir);
  const login = await loginAs(app, 'admin');
  const z = zip({ 'theme.json': json({ version: 3 }), 'theme.css': '.stage{--accent:#0a0}', 'images/kuliah.jpg': jpeg(8, 8) });
  const c = await app.inject({ method: 'POST', url: '/api/themes/check', headers: { ...login.headers, 'content-type': PACK_MIME }, payload: z });
  await app.inject({ method: 'POST', url: '/api/themes/install', headers: login.headers, payload: { stagedId: c.json().stagedId } });
  putFeature(app.surau.db, 'kioskTemplate', { templateId: 'hijau-siti' }, 'test', undefined, LOCAL_SURAU_ID);
  return { app, dir, admin: login.headers };
}

const report = (over: Record<string, unknown> = {}) => ({ theme: 'hijau-siti', version: 3, screen: 'biasa', ok: false, failed: ['clock'], ...over });
const post = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
  app.inject({ method: 'POST', url: '/api/kiosk/theme-health', headers, payload: payload as never, ...(remoteAddress ? { remoteAddress } : {}) });

describe('theme health reports', () => {
  it('the kiosk may post; the machine itself and an admin see themeOk false, a caller across the network sees no theme state at all', async () => {
    const { app, admin } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().themeOk).toBe(true);
    expect((await post(app, report())).statusCode).toBe(204);
    // anonymous across the network: nothing about the theme (not themeOk, not the report)
    const lan = (await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '10.5.5.5' })).json();
    expect(Object.keys(lan).sort()).toEqual(['features', 'name', 'ok', 'themes', 'version']);
    expect(lan.themeOk).toBeUndefined();
    expect(lan.themeHealth).toBeUndefined();
    // anonymous on the box's own machine (the setup doctor): themeOk, never the report
    const anon = (await app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(anon.themeOk).toBe(false);
    expect(anon.themeHealth).toBeUndefined();
    const full = (await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json();
    expect(full.themeOk).toBe(false);
    expect(full.themeHealth).toMatchObject({ theme: 'hijau-siti', version: 3, ok: false, screen: 'biasa', failed: ['clock'] });
    expect(typeof full.themeHealth.at).toBe('string');
    // a later good report clears it
    expect((await post(app, report({ ok: true, failed: [] }))).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json()).toMatchObject({ themeOk: true, themeHealth: { ok: true, failed: [] } });
  });

  it('a linked site token may not post, and nobody on the LAN without a token', async () => {
    const { app } = await setup();
    const site = insertSite(app.surau.db, { boxId: 'ab'.repeat(8) });
    expect((await post(app, report(), site.headers)).statusCode).toBe(403);
    expect((await post(app, report(), {}, '10.6.6.6')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().themeOk).toBe(true);
  });

  it('a bad body is 400', async () => {
    const { app } = await setup();
    for (const bad of [
      null, [], {}, report({ theme: 'Bad Name' }), report({ theme: 5 }), report({ version: 0 }), report({ version: 1.5 }), report({ version: '3' }),
      report({ screen: 'x'.repeat(21) }), report({ screen: 'setup' }), report({ screen: 5 }), report({ ok: 'no' }), report({ failed: ['clock', 'clock'] }),
      report({ failed: ['siren'] }), report({ failed: 'clock' }), report({ failed: ['clock', 'prayers', 'countdown', 'next', 'logo', 'clock'] }),
      report({ ok: true, failed: ['clock'] }), report({ ok: false, failed: [] }), { ...report(), extra: 1 },
    ]) {
      expect((await post(app, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(parseHealthBody(report({ screen: 'tarawih' }))).not.toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/kiosk/theme-health', headers: { 'content-type': 'text/plain' }, payload: 'x' })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('accepts a report from the shell-only stage screens (tugasan, waktu-dunia, video), stored and read back', async () => {
    const { app } = await setup();
    expect([...SHELL_ONLY_SCREEN_IDS]).toEqual(['tugasan', 'waktu-dunia', 'video']);
    for (const screen of SHELL_ONLY_SCREEN_IDS) expect(parseHealthBody(report({ screen })), screen).not.toBeNull();
    expect((await post(app, report({ screen: 'tugasan' }))).statusCode).toBe(204);
    expect(activeThemeHealth(app.surau.db)).toMatchObject({ ok: false, screen: 'tugasan', failed: ['clock'] });
    const good = parseHealthBody(report({ screen: 'waktu-dunia', ok: true, failed: [] }))!;
    expect(recordThemeHealth(app.surau.db, good, new Date(), 'tv-2')).toBe(true);
  });

  it('a report for a theme or version that is not installed changes nothing', async () => {
    const { app, admin } = await setup();
    expect((await post(app, report({ theme: 'tiada-tema' }))).statusCode).toBe(204);
    expect((await post(app, report({ version: 2 }))).statusCode).toBe(204);
    expect((await post(app, report({ theme: 'creative' }))).statusCode).toBe(204);
    const h = (await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json();
    expect(h.themeOk).toBe(true);
    expect(h.themeHealth).toBeNull();
    const rows = app.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'theme_health_json'").get();
    expect(rows).toBeUndefined();
  });

  it('a report is accepted only for the theme this box shows now: any other is dropped and never recorded', async () => {
    const { app, admin } = await setup();
    putFeature(app.surau.db, 'kioskTemplate', { templateId: 'creative' }, 'test', undefined, LOCAL_SURAU_ID);
    // the installed theme is not the one in use: a report for it changes nothing, and uses none of the allowance
    expect((await post(app, report())).statusCode).toBe(204);
    expect((await post(app, report())).statusCode).toBe(204);
    expect(app.surau.db.prepare("SELECT value FROM sync_state WHERE key = 'theme_health_json'").get()).toBeUndefined();
    putFeature(app.surau.db, 'kioskTemplate', { templateId: 'hijau-siti' }, 'test', undefined, LOCAL_SURAU_ID);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json().themeOk).toBe(true);
    // a display that is told to show another uploaded theme cannot make a report about this one count
    expect((await post(app, report({ theme: 'hijau-siti', version: 3 }))).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json().themeOk).toBe(false);
  });

  it('one report of each kind a minute per display: a second one of the same kind is 429, the other kind still passes', async () => {
    const { app, admin } = await setup();
    expect((await post(app, report())).statusCode).toBe(204);
    const again = await post(app, report({ screen: 'azan' }));
    expect(again.statusCode).toBe(429);
    expect(again.headers['retry-after']).toBe('60');
    // the second report did not replace the first
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json().themeHealth).toMatchObject({ screen: 'biasa' });
    // a pass is a different kind: it clears the failure, once
    expect((await post(app, report({ ok: true, failed: [] }))).statusCode).toBe(204);
    expect((await post(app, report({ ok: true, failed: [] }))).statusCode).toBe(429);
    // and a different display has its own allowance
    const site = insertSite(app.surau.db, { boxId: 'cd'.repeat(8) });
    expect((await post(app, report(), site.headers)).statusCode).toBe(403);
  });

  it('only the theme in use counts', async () => {
    const { app, admin } = await setup();
    await post(app, report());
    putFeature(app.surau.db, 'kioskTemplate', { templateId: 'creative' }, 'test', undefined, LOCAL_SURAU_ID);
    const h = (await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json();
    expect(h.themeOk).toBe(true);
    expect(h.themeHealth).toBeNull();
    putFeature(app.surau.db, 'kioskTemplate', { templateId: 'hijau-siti' }, 'test', undefined, LOCAL_SURAU_ID);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json().themeOk).toBe(false);
  });

  it('a new version of the theme starts clean (the old report is for the old file)', async () => {
    const { app, admin } = await setup();
    await post(app, report());
    const z = zip({ 'theme.json': json({ version: 4 }), 'theme.css': '.stage{--accent:#0a0}' });
    const c = await app.inject({ method: 'POST', url: '/api/themes/check', headers: { ...admin, 'content-type': PACK_MIME }, payload: z });
    await app.inject({ method: 'POST', url: '/api/themes/install', headers: admin, payload: { stagedId: c.json().stagedId } });
    expect(getSettings(app.surau.db, LOCAL_SURAU_ID).themeStyle.packs['hijau-siti']!.version).toBe(4);
    const h = (await app.inject({ method: 'GET', url: '/api/health', headers: admin })).json();
    expect(h.themeOk).toBe(true);
    expect(h.themeHealth).toBeNull();
  });

  it('the report survives a restart of the app on the same database', async () => {
    const { app, dir, admin } = await setup();
    await post(app, report());
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const again = open(dir);
    const login = await loginAs(again, 'admin');
    const h = (await again.inject({ method: 'GET', url: '/api/health', headers: login.headers })).json();
    expect(h.themeOk).toBe(false);
    expect(h.themeHealth).toMatchObject({ theme: 'hijau-siti', failed: ['clock'] });
    expect(admin).toBeDefined();
  });
});

describe('S8: one report per display, the theme is bad when any display says so', () => {
  const rep = (ok: boolean) => ({ theme: 'hijau-siti', version: 3, screen: 'biasa', ok, failed: ok ? [] : ['clock' as const] });
  it('a display that is fine does not clear what another display reported', async () => {
    const { app } = await setup();
    const db = app.surau.db;
    const t0 = new Date('2026-11-16T10:00:00Z');
    recordThemeHealth(db, rep(false), t0, 'display-A');
    recordThemeHealth(db, rep(true), new Date(t0.getTime() + 60_000), 'display-B');
    expect(activeThemeHealth(db, new Date(t0.getTime() + 120_000))?.ok).toBe(false);
    // the display that failed says it is fine now: all clear
    recordThemeHealth(db, rep(true), new Date(t0.getTime() + 180_000), 'display-A');
    expect(activeThemeHealth(db, new Date(t0.getTime() + 200_000))?.ok).toBe(true);
  });
  it('a bad report older than 24 hours no longer counts', async () => {
    const { app } = await setup();
    const db = app.surau.db;
    const t0 = new Date('2026-11-16T10:00:00Z');
    recordThemeHealth(db, rep(false), t0, 'display-A');
    recordThemeHealth(db, rep(true), new Date(t0.getTime() + 60_000), 'display-B');
    expect(activeThemeHealth(db, new Date(t0.getTime() + 24 * 3600_000 + 120_000))?.ok).toBe(true);
  });
});
