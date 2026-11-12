/**
 * Static-mount hardening (@fastify/static advisories GHSA-pr96, x428, 8pvw, 83w8): dot-dot and
 * encoded-separator paths never reach a file outside the served root, and no directory listing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const SECRET = 'TOP-SECRET-CONTENT';
let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'surau-trav-'));
  const appDir = join(dir, 'app');
  const kioskDir = join(dir, 'kiosk');
  mkdirSync(join(appDir, 'sub'), { recursive: true });
  mkdirSync(join(kioskDir, 'sub'), { recursive: true });
  writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(appDir, 'sub', 'a.txt'), 'a');
  writeFileSync(join(kioskDir, 'index.html'), '<!doctype html><title>kiosk</title>');
  writeFileSync(join(kioskDir, 'sub', 'k.txt'), 'k');
  // Non-public files beside and above the served roots.
  writeFileSync(join(dir, 'secret.txt'), SECRET);
  writeFileSync(join(dir, 'package.json'), `{"secret":"${SECRET}"}`);
  writeFileSync(join(appDir, '..secret'), SECRET);
  app = buildApp(':memory:', { appDir, staticDir: kioskDir });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const PATHS = [
  '/app/..%2f..%2fpackage.json',
  '/app/..%2fsecret.txt',
  '/app/%2e%2e/secret.txt',
  '/app/%2e%2e%2fsecret.txt',
  '/app/%2e%2e%2f%2e%2e%2fpackage.json',
  '/app/sub%2f..%2f..%2fsecret.txt',
  '/app/sub/..%2f..%2fsecret.txt',
  '/app/..%5csecret.txt',
  '/app//..//secret.txt',
  '/%2e%2e/secret.txt',
  '/%2e%2e/',
  '/..%2fsecret.txt',
  '/..%2f..%2fpackage.json',
  '/sub%2f..%2f..%2fsecret.txt',
  '/sub/..%2f..%2fsecret.txt',
  '/..%5csecret.txt',
  '/%2e%2e%2fsecret.txt',
];

describe('static mounts refuse traversal', () => {
  for (const url of PATHS) {
    it(`GET ${url} never returns file contents`, async () => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain('"secret"');
      // The kiosk mount's SPA fallback may answer an unknown path with its own index page (200);
      // that is the served root's document, never a file outside it.
      if (res.statusCode === 200) expect(res.body === '' || res.body.includes('<title>kiosk</title>')).toBe(true);
      else expect([400, 401, 403, 404]).toContain(res.statusCode);
    });
  }

  it('does not list directories on either mount', async () => {
    for (const url of ['/app/sub/', '/app/sub', '/sub/']) {
      const res = await app.inject({ method: 'GET', url });
      // No listing: the body never names the files inside the directory.
      expect(res.body).not.toMatch(/a\.txt|k\.txt/);
      if (url.startsWith('/app/')) expect(res.statusCode).toBe(404);
    }
  });
});
