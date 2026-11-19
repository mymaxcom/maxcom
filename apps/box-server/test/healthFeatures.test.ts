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
  it('lists video, posterStretch and tvLangAr to an anonymous caller and to a signed-in one', async () => {
    const app = buildApp(':memory:');
    apps.push(app);
    expect([...SERVER_FEATURES]).toEqual(['video', 'posterStretch', 'tvLangAr']);
    const anon = await app.inject({ method: 'GET', url: '/api/health' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().features).toEqual(['video', 'posterStretch', 'tvLangAr']);
    const admin = await loginAs(app, 'admin');
    const signed = await app.inject({ method: 'GET', url: '/api/health', headers: admin.headers });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().users).toBeTypeOf('number');
    expect(signed.json().features).toEqual(['video', 'posterStretch', 'tvLangAr']);
  });
});
