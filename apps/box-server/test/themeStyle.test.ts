import { mkdtempSync, rmSync } from 'node:fs';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { getSettings, readFieldStamps } from '../src/settingsStore.ts';
import { applyOp } from '../src/sync/apply.ts';
import type { VerifiedOp } from '../src/sync/apply.ts';
import { loginAs, withAdmin } from './authHelpers.ts';
import type { AdminApp } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];
const dbs: DatabaseSync[] = [];

function makeApp(): { app: AdminApp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-theme-'));
  tempDirs.push(dir);
  const app = withAdmin(buildApp(join(dir, 'test.db')));
  apps.push(app);
  return { app, dir };
}

afterEach(async () => {
  for (const a of apps.splice(0)) { try { await a.close(); } catch { /* closed */ } }
  for (const d of dbs.splice(0)) { try { d.close(); } catch { /* closed */ } }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function png(): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(2, 16);
  b.writeUInt32BE(2, 20);
  return b;
}

const put = (app: FastifyInstance, feature: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/api/settings/${feature}`, payload: payload as object });
const styles = async (app: FastifyInstance) => (await app.inject({ method: 'GET', url: '/api/settings' })).json().themeStyle.styles;

describe('themeStyle on the box', () => {
  it('saves, replaces one theme whole and removes a key', async () => {
    const { app } = makeApp();
    expect((await put(app, 'themeStyle', { styles: { creative: { semua: { shade: 20, accent: '#111111' }, skrin: {} } } })).statusCode).toBe(200);
    expect((await styles(app)).creative.semua).toEqual({ shade: 20, accent: '#111111' });
    await put(app, 'themeStyle', { styles: { creative: { semua: { shade: 30 }, skrin: {} } } });
    expect((await styles(app)).creative.semua).toEqual({ shade: 30 });
    await put(app, 'themeStyle', { styles: { creative: { semua: {}, skrin: {} } } });
    expect((await styles(app)).creative).toEqual({ semua: {}, skrin: {} });
  });

  it('two editors on different themes never erase each other; the same theme is replaced whole', async () => {
    const { app } = makeApp();
    expect((await put(app, 'themeStyle', { styles: { minimal: { semua: { shade: 5 }, skrin: {} } } })).statusCode).toBe(200);
    expect((await put(app, 'themeStyle', { styles: { creative: { semua: { align: 'kanan' }, skrin: { kuliah: { scale: 'L' } } } } })).statusCode).toBe(200);
    expect(await styles(app)).toEqual({
      minimal: { semua: { shade: 5 }, skrin: {} },
      creative: { semua: { align: 'kanan' }, skrin: { kuliah: { scale: 'L' } } },
    });
    await put(app, 'themeStyle', { styles: { creative: { semua: {}, skrin: { hadis: { font: 'amiri' } } } } });
    expect((await styles(app)).creative).toEqual({ semua: {}, skrin: { hadis: { font: 'amiri' } } });
    expect((await styles(app)).minimal.semua).toEqual({ shade: 5 });
  });

  it('refuses unknown keys and unknown screens on write, naming them, and stores nothing', async () => {
    const { app } = makeApp();
    const a = await put(app, 'themeStyle', { styles: { creative: { semua: { wat: 1 }, skrin: {} } } });
    expect(a.statusCode).toBe(400);
    expect(a.json().errors.join(' ')).toMatch(/wat/);
    const b = await put(app, 'themeStyle', { styles: { creative: { semua: {}, skrin: { 'no-such': { shade: 1 } } } } });
    expect(b.statusCode).toBe(400);
    expect(b.json().errors.join(' ')).toMatch(/no-such/);
    const c = await put(app, 'themeStyle', { packs: { 'hijau-siti': { assetId: 'b'.repeat(64), version: 1, title: 'H', base: 'creative', contract: 1, bytes: 1, fonts: [], screens: [], images: {}, defaults: {}, extra: 1 } } });
    expect(c.statusCode).toBe(400);
    expect(c.json().errors.join(' ')).toMatch(/extra/);
    expect(await styles(app)).toEqual({});
  });

  it('keeps the whole stored maps within 32 KB (styles) and 64 KB (packs) as entries add up', async () => {
    const { app } = makeApp();
    const fat = (): unknown => ({ semua: {}, skrin: Object.fromEntries(['kuliah', 'hadis', 'azan', 'biasa', 'iqamah', 'solat', 'jumaat', 'poster', 'program', 'zikir', 'tilawah', 'takwim', 'tabung', 'ayat', 'live'].map((id) => [id, { accent: '#112233', bgFit: 'penuh', bgPos: 'kiri', shade: 20, text: '#ffffff', font: 'jakarta', scale: 'XL', align: 'kanan' }])) });
    let refused = false;
    for (let i = 0; i < 30 && !refused; i += 1) {
      const r = await put(app, 'themeStyle', { styles: { [`t${i}`]: fat() } });
      if (r.statusCode === 400) { refused = true; expect(r.json().errors.join(' ')).toMatch(/32 KB/); }
    }
    expect(refused).toBe(true);
  });

  it('refuses a bad value with 400 and stores nothing', async () => {
    const { app } = makeApp();
    const r = await put(app, 'themeStyle', { styles: { creative: { semua: { shade: 99 }, skrin: {} } } });
    expect(r.statusCode).toBe(400);
    expect(await styles(app)).toEqual({});
  });

  it('refuses a bgImage that is not a stored picture; accepts one that is', async () => {
    const { app } = makeApp();
    const bad = await put(app, 'themeStyle', { styles: { creative: { semua: { bgImage: 'f'.repeat(64) }, skrin: {} } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors).toEqual(['bgImage refers to a picture that does not exist (theme creative, screen all screens)']);
    const up = await app.inject({ method: 'POST', url: '/api/assets', headers: { 'content-type': 'image/png' }, payload: png() });
    const id = up.json().id as string;
    const bad2 = await put(app, 'themeStyle', { styles: { creative: { semua: {}, skrin: { kuliah: { bgImage: 'e'.repeat(64) } } } } });
    expect(bad2.statusCode).toBe(400);
    expect(bad2.json().errors).toEqual(['bgImage refers to a picture that does not exist (theme creative, screen kuliah)']);
    const ok = await put(app, 'themeStyle', { styles: { creative: { semua: { bgImage: id }, skrin: { kuliah: { bgImage: id } } } } });
    expect(ok.statusCode).toBe(200);
  });

  it('checks only new or changed bgImage ids: an unchanged reference to a picture that is gone is kept', async () => {
    const { app, dir } = makeApp();
    const up = await app.inject({ method: 'POST', url: '/api/assets', headers: { 'content-type': 'image/png' }, payload: png() });
    const id = up.json().id as string;
    expect((await put(app, 'themeStyle', { styles: { creative: { semua: { bgImage: id }, skrin: {} } } })).statusCode).toBe(200);
    // The picture goes away (removed from the assets table), the stored reference stays.
    const db = openDb(join(dir, 'test.db')); dbs.push(db);
    db.exec('DELETE FROM assets');
    const same = await put(app, 'themeStyle', { styles: { creative: { semua: { bgImage: id, shade: 30 }, skrin: {} } } });
    expect(same.statusCode).toBe(200);
    expect((await styles(app)).creative.semua).toEqual({ bgImage: id, shade: 30 });
    // A different picture that does not exist is still refused.
    const other = await put(app, 'themeStyle', { styles: { creative: { semua: { bgImage: 'd'.repeat(64) }, skrin: {} } } });
    expect(other.statusCode).toBe(400);
  });

  it('a role without settings:write gets 403', async () => {
    const { app } = makeApp();
    const ajk = await loginAs(app, 'ajk');
    const r = await app.inject({ method: 'PUT', url: '/api/settings/themeStyle', headers: ajk.headers, payload: { styles: {} } });
    expect(r.statusCode).toBe(403);
  });

  it('health reports theme support to everyone', async () => {
    const { app } = makeApp();
    const want = { contract: 1, builtIn: ['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic'] };
    const anon = await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: 'Bearer nope' } });
    expect(anon.json().themes).toEqual(want);
    const full = await app.inject({ method: 'GET', url: '/api/health' });
    expect(full.json().themes).toEqual(want);
  });

  it('the kiosk bundle carries themeStyle', async () => {
    const { app } = makeApp();
    await put(app, 'themeStyle', { styles: { creative: { semua: { shade: 20 }, skrin: {} } } });
    const k = await app.inject({ method: 'GET', url: '/api/kiosk/bundle', headers: { authorization: '' }, remoteAddress: '127.0.0.1' });
    expect(k.statusCode).toBe(200);
    expect(k.json().settings.themeStyle.styles).toEqual({ creative: { semua: { shade: 20 }, skrin: {} } });
  });
});

describe('themeStyle over sync', () => {
  let counter = 0;
  const op = (over: Partial<VerifiedOp>): VerifiedOp => ({
    v: 1, opId: `TH${String(++counter).padStart(24, '0')}`, surauId: 'sdm', boxId: 'box1', deviceId: 'dev-a', userId: 'u1',
    kind: 'settings.put', entity: 'settings', entityId: 'themeStyle', baseRev: null, editedAt: '2026-11-05T09:00:00.000Z',
    payload: {}, sig: 'x', userName: 'Ali', ...over,
  });
  it('a settings.put for themeStyle is applied, and templateId "hijau-siti" is accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-theme-')); tempDirs.push(dir);
    const db = openDb(join(dir, 't.db')); dbs.push(db);
    const ctx = { now: new Date('2026-11-05T10:00:00.000Z'), origin: 'app' as const, actor: 'user:u1', dataDir: dir, surauId: LOCAL_SURAU_ID };
    const a = applyOp(db, op({ payload: { styles: { creative: { semua: { shade: 20 }, skrin: {} } } } }), ctx);
    expect(a.status).toBe('applied');
    expect(getSettings(db, LOCAL_SURAU_ID).themeStyle.styles).toEqual({ creative: { semua: { shade: 20 }, skrin: {} } });
    const b = applyOp(db, op({ entityId: 'kioskTemplate', payload: { templateId: 'hijau-siti' } }), ctx);
    expect(b.status).toBe('applied');
    expect(getSettings(db, LOCAL_SURAU_ID).kioskTemplate.templateId).toBe('hijau-siti');
  });
  it('edits to two different themes from two devices both survive, in either order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-theme-')); tempDirs.push(dir);
    const db = openDb(join(dir, 't.db')); dbs.push(db);
    const ctx = { now: new Date('2026-11-05T10:00:00.000Z'), origin: 'app' as const, actor: 'user:u1', dataDir: dir, surauId: LOCAL_SURAU_ID };
    const newer = op({ deviceId: 'dev-a', editedAt: '2026-11-05T09:00:00.000Z', payload: { styles: { creative: { semua: { shade: 20 }, skrin: {} } } } });
    const older = op({ deviceId: 'dev-b', editedAt: '2026-11-05T08:00:00.000Z', payload: { styles: { minimal: { semua: { shade: 5 }, skrin: {} } } } });
    expect(applyOp(db, newer, ctx).status).toBe('applied');
    expect(applyOp(db, older, ctx).status).toBe('applied');
    expect(getSettings(db, LOCAL_SURAU_ID).themeStyle.styles).toEqual({
      creative: { semua: { shade: 20 }, skrin: {} },
      minimal: { semua: { shade: 5 }, skrin: {} },
    });
    // The stamps are per theme.
    expect(Object.keys(readFieldStamps(db, 'themeStyle', LOCAL_SURAU_ID)).sort()).toEqual(['styles.creative', 'styles.minimal']);
  });
  it('a row stored as one whole map (before per-theme fields) keeps working and its stamp covers the themes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-theme-')); tempDirs.push(dir);
    const db = openDb(join(dir, 't.db')); dbs.push(db);
    const json = JSON.stringify({ styles: { creative: { semua: { shade: 20 }, skrin: {} } }, packs: {} });
    db.prepare('INSERT INTO settings (feature, json, updated_at, updated_by, rev, edited_at, origin, field_stamps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('themeStyle', json, '2026-11-05T07:00:00.000Z', 'x', 'r1', '2026-11-05T07:00:00.000Z', 'local', JSON.stringify({ styles: { editedAt: '2026-11-05T07:00:00.000Z', deviceId: 'dev-a' } }));
    expect(getSettings(db, LOCAL_SURAU_ID).themeStyle.styles.creative!.semua).toEqual({ shade: 20 });
    expect(readFieldStamps(db, 'themeStyle', LOCAL_SURAU_ID)['styles.creative']).toEqual({ editedAt: '2026-11-05T07:00:00.000Z', deviceId: 'dev-a' });
    const ctx = { now: new Date('2026-11-05T10:00:00.000Z'), origin: 'app' as const, actor: 'user:u1', dataDir: dir, surauId: LOCAL_SURAU_ID };
    expect(applyOp(db, op({ editedAt: '2026-11-05T09:00:00.000Z', payload: { styles: { minimal: { semua: { shade: 5 }, skrin: {} } } } }), ctx).status).toBe('applied');
    expect(Object.keys(getSettings(db, LOCAL_SURAU_ID).themeStyle.styles).sort()).toEqual(['creative', 'minimal']);
  });
});
