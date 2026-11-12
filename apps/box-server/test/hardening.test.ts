import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { klInstant } from '@surau/core';
import { buildApp } from '../src/app.ts';
import { DatabaseSync } from 'node:sqlite';
import { loginAs, loginAsAdmin, withAdmin } from './authHelpers.ts';
import type { AdminApp } from './authHelpers.ts';
import { parsePort } from '../src/main.ts';

const fixtureCsv = readFileSync(
  fileURLToPath(new URL('../../../packages/core/test/fixtures/SGR01-2026.csv', import.meta.url)),
  'utf8',
);
const AT = klInstant('2026-11-03', '12:00');

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'surau-hard-'));
  tempDirs.push(dir);
  return dir;
}

function makeApp(options: Parameters<typeof buildApp>[1] = {}): AdminApp {
  const app = withAdmin(buildApp(join(tempDir(), 'test.db'), { now: () => AT, ...options }));
  apps.push(app);
  return app;
}

function makeStaticApp(): FastifyInstance {
  const dir = tempDir();
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>kiosk</title>');
  return makeApp({ staticDir: dir });
}

async function version(app: FastifyInstance): Promise<number> {
  const r = await app.inject({ method: 'GET', url: '/api/health' });
  return r.json().version as number;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    try {
      await app.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PUT /api/settings no-op', () => {
  it('an empty or unchanged PUT leaves the version unchanged', async () => {
    const app = makeApp();
    await app.inject({ method: 'PUT', url: '/api/settings/hijriDate', payload: { adjustDays: 1 } });
    const v = await version(app);
    const empty = await app.inject({ method: 'PUT', url: '/api/settings/hijriDate', payload: {} });
    expect(empty.statusCode).toBe(200);
    const same = await app.inject({ method: 'PUT', url: '/api/settings/hijriDate', payload: { adjustDays: 1 } });
    expect(same.statusCode).toBe(200);
    expect(await version(app)).toBe(v);
  });
});

describe('PUT /api/settings/zone guard', () => {
  it('rejects a zone that is not on the JAKIM list and accepts a listed one, with or without data', async () => {
    const app = makeApp();
    const imp = await app.inject({
      method: 'POST',
      url: '/api/prayer/import',
      payload: { zone: 'SGR01', csv: fixtureCsv },
    });
    expect(imp.statusCode).toBe(200);
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/zone', payload: { zone: 'XXX99' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0]).toBe('Zon tidak dikenali; kemas kini senarai zon');
    // Plan 13: a listed zone with no data yet is accepted (with a warning) and fetched after saving
    const nodata = await app.inject({ method: 'PUT', url: '/api/settings/zone', payload: { zone: 'JHR01' } });
    expect(nodata.statusCode).toBe(200);
    expect(nodata.json().warnings).toEqual(['Tiada data untuk zon ini; MAXCOM akan memuat turun']);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings/zone', payload: { zone: 'SGR01' } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('Host allowlist', () => {
  it('rejects unknown hosts and accepts loopback names', async () => {
    const app = makeApp();
    const evil = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example' } });
    expect(evil.statusCode).toBe(421);
    const evilPort = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:8787' } });
    expect(evilPort.statusCode).toBe(421);
    for (const host of ['127.0.0.1:8787', 'localhost', 'localhost:8787', '[::1]:8787', '[::1]']) {
      const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(r.statusCode, host).toBe(200);
    }
  });

  it('accepts hosts from allowedHosts', async () => {
    const app = makeApp({ allowedHosts: ['surau.local'] });
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'surau.local:8787' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('not-found handling', () => {
  it('treats /api?x=1 as an API path (JSON 404)', async () => {
    const app = makeStaticApp();
    const r = await app.inject({ method: 'GET', url: '/api?x=1' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toContain('application/json');
  });

  it('does not serve index.html for missing files with an extension', async () => {
    const app = makeStaticApp();
    for (const url of ['/assets/x.js', '/favicon.ico', '/a/b.css?v=1']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
    }
    const link = await app.inject({ method: 'GET', url: '/some/deep/link' });
    expect(link.statusCode).toBe(200);
  });
});

describe('error handler', () => {
  it('keeps 4xx messages but hides 5xx detail and logs it', async () => {
    const app = makeApp();
    app.get('/boom', async () => {
      throw new Error('secret db path /var/x');
    });
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/hijriDate',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors[0]).toMatch(/JSON/i);

    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      logged.push(a);
    };
    try {
      const r = await app.inject({ method: 'GET', url: '/boom' });
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ errors: ['internal error'] });
      expect(r.body).not.toContain('secret');
    } finally {
      console.error = orig;
    }
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe('parsePort', () => {
  it('accepts 1..65535 and the default, rejects the rest', () => {
    expect(parsePort(undefined)).toBe(8787);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    for (const bad of ['0', '65536', '-1', '80.5', 'abc', '', '8787x', '1e3', '99999']) {
      expect(parsePort(bad), bad).toBeNull();
    }
  });
});

// ---- Gate fix round W13, lane A2 ----

/** Reads an event stream until `pred` matches the text so far; false on timeout or end of stream. */
async function streamHas(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { text: string },
  pred: (text: string) => boolean,
  ms = 4000,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred(state.text)) return true;
    const left = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read().catch(() => ({ done: true as const, value: undefined })),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left)),
    ]);
    if (chunk === 'timeout') return false;
    if (chunk.done) return pred(state.text);
    state.text += new TextDecoder().decode(chunk.value);
  }
  return pred(state.text);
}

/** True when the server ends the stream (the reader reports done) within `ms`. */
async function streamEnds(reader: ReadableStreamDefaultReader<Uint8Array>, state: { text: string }, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const left = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read().catch(() => ({ done: true as const, value: undefined })),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left)),
    ]);
    if (chunk === 'timeout') return false;
    if (chunk.done) return true;
    state.text += new TextDecoder().decode(chunk.value);
  }
  return false;
}

describe('W13 S10/Q16: the event stream re-checks its identity', () => {
  it('ends when the signed-in session is logged out', async () => {
    const app = makeApp({ heartbeatMs: 40 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const second = await loginAsAdmin(app);
    const res = await fetch(`http://127.0.0.1:${port}/api/kiosk/events`, { headers: second.headers });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const state = { text: '' };
    expect(await streamHas(reader, state, (t) => t.includes(': hb'))).toBe(true);
    // revoke that session (log out); the next heartbeat ends the stream
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: second.headers });
    expect(out.statusCode).toBe(200);
    expect(await streamEnds(reader, state)).toBe(true);
    await app.close();
  });

  it('ends when the device of the session is revoked, or the user is deactivated', async () => {
    const app = makeApp({ heartbeatMs: 40 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const admin = await app.admin();
    const a = await loginAs(app, 'ajk');
    const b = await loginAs(app, 'ajk');
    const open = async (token: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/kiosk/events`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const state = { text: '' };
      expect(await streamHas(reader, state, (t) => t.includes('event: changed'))).toBe(true);
      return { reader, state };
    };
    const sa = await open(a.token);
    const sb = await open(b.token);
    expect((await app.inject({ method: 'POST', url: `/api/devices/${a.deviceId}/revoke`, headers: admin.headers })).statusCode).toBe(200);
    expect(await streamEnds(sa.reader, sa.state)).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/users/${b.userId}/deactivate`, headers: admin.headers })).statusCode).toBe(200);
    expect(await streamEnds(sb.reader, sb.state)).toBe(true);
    await app.close();
  });

  it('ends when the paired kiosk cookie is revoked; a valid one keeps receiving heartbeats', async () => {
    const app = makeApp({ heartbeatMs: 40 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const admin = await app.admin();
    const b = (await app.inject({ method: 'POST', url: '/api/kiosk/pair/begin', remoteAddress: '10.168.1.77' })).json() as { code: string; pollToken: string };
    const ap = await app.inject({ method: 'POST', url: '/api/kiosk/pair/approve', headers: admin.headers, payload: { code: b.code } });
    expect(ap.statusCode).toBe(200);
    const p = await app.inject({ method: 'POST', url: '/api/kiosk/pair/poll', remoteAddress: '10.168.1.77', payload: { pollToken: b.pollToken } });
    const cookie = String(p.headers['set-cookie']).split(';')[0]!;
    const res = await fetch(`http://127.0.0.1:${port}/api/kiosk/events`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const state = { text: '' };
    expect(await streamHas(reader, state, (t) => (t.match(/: hb/g) ?? []).length >= 3)).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/devices/${ap.json().deviceId}/revoke`, headers: admin.headers })).statusCode).toBe(200);
    expect(await streamEnds(reader, state)).toBe(true);
    await app.close();
  });
});

describe('W13 Q6: a write by another process is announced to event-stream clients', () => {
  it('re-reads the version on a timer and emits when it moved', async () => {
    const dir = tempDir();
    const dbFile = join(dir, 'shared.db');
    const app = withAdmin(buildApp(dbFile, { now: () => AT, heartbeatMs: 60_000, versionPollMs: 40 }));
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/kiosk/events`);
    const reader = res.body!.getReader();
    const state = { text: '' };
    expect(await streamHas(reader, state, (t) => t.includes('event: changed'))).toBe(true);
    const before = await version(app);
    // a second connection to the same file stands in for a CLI process
    const other = new DatabaseSync(dbFile);
    other.exec('PRAGMA busy_timeout = 2000');
    other.prepare("INSERT INTO meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(before + 5));
    other.close();
    expect(await streamHas(reader, state, (t) => t.includes(`"version":${before + 5}`))).toBe(true);
    // announced once, not repeated on every poll
    await new Promise((r) => setTimeout(r, 200));
    state.text += '';
    const count = (state.text.match(new RegExp(`"version":${before + 5}\\b`, 'g')) ?? []).length;
    expect(count).toBe(1);
    await reader.cancel().catch(() => undefined);
    await app.close();
  });
});

describe('W13 S8: public and small-body POSTs refuse bodies over 8 KB', () => {
  const big = { junk: 'x'.repeat(9 * 1024) };
  const small = { junk: 'x'.repeat(1024) };
  const urls = [
    '/api/enrol/complete',
    '/api/auth/challenge',
    '/api/auth/unlock',
    '/api/kiosk/pair/begin',
    '/api/kiosk/pair/poll',
    '/api/kiosk/pair/approve',
    '/api/users',
    '/api/enrol/begin',
  ];

  it.each(urls)('%s answers 413 to a 9 KB JSON body', async (url) => {
    const app = makeApp();
    const r = await app.inject({ method: 'POST', url, payload: big, remoteAddress: '10.168.1.80' });
    expect(r.statusCode).toBe(413);
  });

  it('a 1 KB body still reaches the handler (a normal refusal, not 413)', async () => {
    const app = makeApp();
    for (const url of urls) {
      const r = await app.inject({ method: 'POST', url, payload: small, remoteAddress: '10.168.1.81' });
      expect(r.statusCode, url).not.toBe(413);
    }
  });

  it('routes that really take big bodies keep the large limit', async () => {
    const app = makeApp();
    const r = await app.inject({ method: 'PUT', url: '/api/settings/hijriDate', payload: { adjustDays: 1, pad: 'x'.repeat(20 * 1024) } });
    expect(r.statusCode).not.toBe(413);
  });
});
