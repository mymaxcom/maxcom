// The app learns what its server supports from GET /api/health `features` (it hides the Video kind and the poster
// stretch switch on an older server), so both the anonymous and the signed-in answer carry the list.
import { SERVER_FEATURES } from '@surau/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loginAs } from './authHelpers.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe('GET /api/health features', () => {
  it('lists video, posterStretch, tvLangAr, videoAfterPrayer and videoPlayNow to an anonymous caller and to a signed-in one', async () => {
    const app = buildApp(':memory:');
    apps.push(app);
    expect([...SERVER_FEATURES]).toEqual(['video', 'posterStretch', 'tvLangAr', 'videoAfterPrayer', 'videoPlayNow']);
    const anon = await app.inject({ method: 'GET', url: '/api/health' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().features).toEqual(['video', 'posterStretch', 'tvLangAr', 'videoAfterPrayer', 'videoPlayNow']);
    const admin = await loginAs(app, 'admin');
    const signed = await app.inject({ method: 'GET', url: '/api/health', headers: admin.headers });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().users).toBeTypeOf('number');
    expect(signed.json().features).toEqual(['video', 'posterStretch', 'tvLangAr', 'videoAfterPrayer', 'videoPlayNow']);
  });

  it('answers the doctor Mic-in question only on this machine and only when asked (?mic=1), with no device names', async () => {
    const app = buildApp(':memory:');
    apps.push(app);
    const plain = await app.inject({ method: 'GET', url: '/api/health' });
    expect(plain.json()).not.toHaveProperty('mic');
    const asked = await app.inject({ method: 'GET', url: '/api/health?mic=1' });
    expect(asked.statusCode).toBe(200);
    const mic = asked.json().mic as { devices: number; code: string };
    expect(typeof mic.devices).toBe('number');
    expect(['ok', 'untested', 'no_device', 'no_tool', 'list_failed', 'access_denied', 'device_unavailable', 'silent']).toContain(mic.code);
    expect(Object.keys(mic).sort()).toEqual(['code', 'devices']);
    // a request that comes through a proxy (it names a forwarded address) is not this machine: no answer
    const proxied = await app.inject({ method: 'GET', url: '/api/health?mic=1', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(proxied.json()).not.toHaveProperty('mic');
  });
});
