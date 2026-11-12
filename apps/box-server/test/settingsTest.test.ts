import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { putFeature } from '../src/settingsStore.ts';
import { guardedFetch } from '../src/net/safeFetch.ts';
import { loginAs } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Seen {
  url: string;
  method: string;
}

function makeApp(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): { app: FastifyInstance } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-st-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'test.db'), { dataDir: dir, fetchImpl, ...extra });
  apps.push(app);
  return { app };
}

const call = (app: FastifyInstance, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/settings/test-source', headers, payload: payload as object });

function recorder(status = 200, body: string | null = 'x'): { seen: Seen[]; fetchImpl: typeof fetch } {
  const seen: Seen[] = [];
  const fetchImpl = (async (u: unknown, i?: RequestInit) => {
    seen.push({ url: String(u), method: i?.method ?? 'GET' });
    return new Response(body, { status });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe('Cuba sambungan: POST /api/settings/test-source', () => {
  it('a private host is blocked_host and nothing was fetched', async () => {
    const rec = recorder();
    const { app } = makeApp(rec.fetchImpl);
    const sup = await loginAs(app, 'superadmin');
    for (const url of ['https://10.168.1.10/x', 'https://localhost/x', 'https://10.0.0.5:8443/', 'https://[::1]/']) {
      const r = await call(app, sup.headers, { kind: 'source', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.json(), url).toMatchObject({ ok: false, status: null, error: 'blocked_host' });
    }
    expect(rec.seen).toEqual([]);
    const bad = await call(app, sup.headers, { kind: 'source', url: 'http://example.my/x' });
    expect(bad.json()).toMatchObject({ ok: false, error: 'bad_url' });
    expect(rec.seen).toEqual([]);
  });

  it('a name that resolves to a private address is blocked by the guarded fetch', async () => {
    const { app } = makeApp(guardedFetch((async () => new Response('x')) as typeof fetch, async () => ['10.1.2.3']));
    const sup = await loginAs(app, 'superadmin');
    const r = await call(app, sup.headers, { kind: 'source', url: 'https://sneaky.example.my/' });
    expect(r.json()).toMatchObject({ ok: false, status: null, error: 'blocked_host' });
  });

  it('a 200 within the time is ok with its status and time; a 404 is not ok; only the status and time come back', async () => {
    const ok200 = recorder(200, 'SECRET BODY');
    const a = makeApp(ok200.fetchImpl).app;
    const supA = await loginAs(a, 'superadmin');
    const ok = await call(a, supA.headers, { kind: 'source', url: 'https://www.e-solat.gov.my/index.php' });
    expect(ok.json()).toMatchObject({ ok: true, status: 200 });
    expect(typeof ok.json().ms).toBe('number');
    expect(Object.keys(ok.json()).sort()).toEqual(['ms', 'ok', 'status']);
    expect(ok.body).not.toContain('SECRET');
    expect(ok200.seen).toEqual([{ url: 'https://www.e-solat.gov.my/index.php', method: 'GET' }]);
    const nf = recorder(404, 'nope');
    const b = makeApp(nf.fetchImpl).app;
    const supB = await loginAs(b, 'superadmin');
    expect((await call(b, supB.headers, { kind: 'source', url: 'https://www.e-solat.gov.my/none' })).json()).toMatchObject({ ok: false, status: 404 });
  });

  it('a slow server is a timeout', async () => {
    const slow = ((_u: unknown, i?: RequestInit) =>
      new Promise((_res, rej) => {
        i?.signal?.addEventListener('abort', () => rej(i.signal!.reason));
      })) as typeof fetch;
    const { app } = makeApp(slow, { sourceTestTimeoutMs: 60 });
    const sup = await loginAs(app, 'superadmin');
    const r = await call(app, sup.headers, { kind: 'source', url: 'https://slow.example.my/' });
    expect(r.json()).toMatchObject({ ok: false, status: null, error: 'timeout' });
  });

  it('a reciter is checked by a HEAD on the configured audio source and a safe folder name only', async () => {
    const rec = recorder(200, null);
    const { app } = makeApp(rec.fetchImpl);
    const sup = await loginAs(app, 'superadmin');
    const r = await call(app, sup.headers, { kind: 'reciter', folder: 'Alafasy_64kbps' });
    expect(r.json()).toMatchObject({ ok: true, status: 200 });
    expect(rec.seen).toEqual([{ url: 'https://everyayah.com/data/Alafasy_64kbps/001001.mp3', method: 'HEAD' }]);
    putFeature(app.surau.db, 'dataSources', { quranAudio: { url: 'https://audio.example.my/files/' } }, 'test');
    await call(app, sup.headers, { kind: 'reciter', folder: 'Husary_64kbps' });
    expect(rec.seen[1]).toEqual({ url: 'https://audio.example.my/files/Husary_64kbps/001001.mp3', method: 'HEAD' });
    for (const folder of ['../etc', 'a/b', 'ab', 'x'.repeat(65), '', 7, null]) {
      expect((await call(app, sup.headers, { kind: 'reciter', folder })).statusCode, String(folder)).toBe(400);
    }
    expect(rec.seen).toHaveLength(2);
  });

  it('every probe is logged with who, which host and the outcome, never the path or query', async () => {
    const rec = recorder(200, 'x');
    const { app } = makeApp(rec.fetchImpl);
    const sup = await loginAs(app, 'superadmin');
    const rows = () =>
      app.surau.db.prepare("SELECT user_id, device_id, ok, detail FROM auth_log WHERE event = 'source_test' ORDER BY id").all();
    await call(app, sup.headers, { kind: 'source', url: 'https://www.e-solat.gov.my/index.php?token=SECRET123&x=1' });
    await call(app, sup.headers, { kind: 'source', url: 'https://10.168.1.10/private?key=SECRET456' });
    await call(app, sup.headers, { kind: 'source', url: 'http://plain.example.my/p?q=SECRET789' });
    await call(app, sup.headers, { kind: 'reciter', folder: 'Alafasy_64kbps' });
    const logged = rows();
    expect(logged).toHaveLength(4);
    expect(logged[0]).toMatchObject({ user_id: sup.userId, device_id: sup.deviceId, ok: 1, detail: 'source www.e-solat.gov.my ok' });
    expect(logged[1]).toMatchObject({ ok: 0, detail: 'source 10.168.1.10 blocked_host' });
    expect(logged[2]).toMatchObject({ ok: 0, detail: 'source plain.example.my bad_url' });
    expect(logged[3]).toMatchObject({ ok: 1, detail: 'reciter everyayah.com ok' });
    const all = JSON.stringify(logged);
    for (const secret of ['SECRET', 'token', 'index.php', 'private', 'Alafasy']) expect(all).not.toContain(secret);
    // a refused body is not a probe and writes no row
    await call(app, sup.headers, { kind: 'source', url: 5 });
    expect(rows()).toHaveLength(4);
  });

  it('only system:write: an admin is 403, anonymous 401; bad bodies are 400', async () => {
    const { app } = makeApp(recorder().fetchImpl);
    const admin = await loginAs(app, 'admin');
    const sup = await loginAs(app, 'superadmin');
    expect((await call(app, admin.headers, { kind: 'source', url: 'https://www.e-solat.gov.my/' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/settings/test-source', remoteAddress: '10.168.1.99', payload: {} })).statusCode).toBe(401);
    for (const body of [{}, { kind: 'nope' }, { kind: 'source' }, { kind: 'source', url: 5 }]) {
      expect((await call(app, sup.headers, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('11 calls in a minute: the 11th is 429', async () => {
    const { app } = makeApp(recorder().fetchImpl);
    const sup = await loginAs(app, 'superadmin');
    for (let i = 0; i < 10; i++) expect((await call(app, sup.headers, { kind: 'source', url: 'https://www.e-solat.gov.my/' })).statusCode).toBe(200);
    const last = await call(app, sup.headers, { kind: 'source', url: 'https://www.e-solat.gov.my/' });
    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
  });
});
