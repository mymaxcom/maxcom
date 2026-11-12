/**
 * The /app/ preview screen frames the kiosk page (`/?preview=1`) on the same origin. Only that page
 * may be framed, and only by itself: every other response keeps `frame-ancestors 'none'` + DENY.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CSP, KIOSK_CSP } from '../src/securityHeaders.ts';

let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'surau-preview-'));
  const appDir = join(dir, 'app');
  const kioskDir = join(dir, 'kiosk');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(kioskDir, { recursive: true });
  writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(kioskDir, 'index.html'), '<!doctype html><title>kiosk</title>');
  writeFileSync(join(kioskDir, 'a.js'), '// a');
  app = buildApp(':memory:', { appDir, staticDir: kioskDir });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const many = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : v === undefined ? [] : [String(v)]);
const NONE = CSP; // contains frame-ancestors 'none' and connect-src 'self' only (everything but the kiosk page document)
const KIOSK = KIOSK_CSP; // the kiosk page document: also the loopback host-exit port
const SELF = KIOSK_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

async function frame(url: string): Promise<{ csp: string[]; xfo: string[]; status: number }> {
  const res = await app.inject({ method: 'GET', url });
  return { csp: many(res.headers['content-security-policy']), xfo: many(res.headers['x-frame-options']), status: res.statusCode };
}

describe('kiosk page preview framing', () => {
  it('relaxes to same origin for /?preview=1, with one header each', async () => {
    const r = await frame('/?preview=1');
    expect(r.status).toBe(200);
    expect(r.csp).toEqual([SELF]);
    expect(r.xfo).toEqual(['SAMEORIGIN']);
    expect(SELF).toContain("frame-ancestors 'self'");
    expect(SELF).not.toContain("frame-ancestors 'none'");
  });

  it('still relaxes with other query parameters and on the SPA fallback', async () => {
    for (const url of ['/?preview=1&x=1', '/?x=1&preview=1', '/some/route?preview=1']) {
      const r = await frame(url);
      expect(r.status, url).toBe(200);
      expect(r.csp, url).toEqual([SELF]);
      expect(r.xfo, url).toEqual(['SAMEORIGIN']);
    }
  });

  it('keeps none/DENY for the kiosk page without preview=1', async () => {
    for (const url of ['/', '/?preview=0', '/?preview=', '/?preview=11', '/?preview=true', '/?xpreview=1', '/some/route']) {
      const r = await frame(url);
      expect(r.status, url).toBe(200);
      expect(r.csp, url).toEqual([KIOSK]);
      expect(r.xfo, url).toEqual(['DENY']);
    }
  });

  it('never relaxes anything but the kiosk page', async () => {
    const health = await frame('/api/health?preview=1');
    expect(health.csp).toEqual([NONE]);
    expect(health.xfo).toEqual(['DENY']);
    const appPage = await app.inject({ method: 'GET', url: '/app/?preview=1' });
    const appCsp = many(appPage.headers['content-security-policy']);
    expect(appCsp).toHaveLength(1);
    expect(appCsp[0]).toContain("frame-ancestors 'none'");
    expect(many(appPage.headers['x-frame-options'])).toEqual(['DENY']);
    const asset = await frame('/a.js?preview=1');
    expect(asset.csp).toEqual([NONE]);
    expect(asset.xfo).toEqual(['DENY']);
    const missingApi = await frame('/api/nope?preview=1');
    expect(missingApi.csp).toEqual([NONE]);
    expect(missingApi.xfo).toEqual(['DENY']);
    const notFoundFile = await frame('/missing.png?preview=1');
    expect(notFoundFile.status).toBe(404);
    expect(notFoundFile.csp).toEqual([NONE]);
    expect(notFoundFile.xfo).toEqual(['DENY']);
  });

  it('does not relax a POST', async () => {
    const res = await app.inject({ method: 'POST', url: '/?preview=1', payload: {} });
    expect(many(res.headers['content-security-policy'])).toEqual([NONE]);
    expect(many(res.headers['x-frame-options'])).toEqual(['DENY']);
  });
});
