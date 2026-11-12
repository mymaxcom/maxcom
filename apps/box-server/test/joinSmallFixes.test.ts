import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBoxQr } from '@surau/core';
import type { BoxStateView } from '@surau/core';
import { buildApp } from '../src/app.ts';
import type { TlsMaterial } from '../src/tls.ts';
import { boxOrigin } from '../src/setup/stateRoutes.ts';
import { issueRecoveryCode } from '../src/setup/codes.ts';
import { loginAs } from './authHelpers.ts';
import { TEST_PIN, makeDevice, screenNonce } from './support/joinHelpers.ts';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const TLS = { mode: 'ip', pfx: Buffer.alloc(0), passphrase: '', notAfter: new Date('2030-01-01'), ipSan: ['10.168.0.20', '127.0.0.1'], dnsSan: [] } as TlsMaterial;
function make(opts: Parameters<typeof buildApp>[1] = {}): FastifyInstance {
  const dir = mkdtempSync(join(tmpdir(), 'surau-small-'));
  dirs.push(dir);
  const app = buildApp(join(dir, 'surau.db'), { dataDir: dir, ...opts });
  apps.push(app);
  return app;
}
let n = 0;
const addr = (): string => `10.77.${Math.floor(++n / 250)}.${(n % 250) + 1}`;
async function body(nonce: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const d = await makeDevice();
  return { nonce, surauName: 'Surau X', boxName: 'MAXCOM X', adminName: 'Haji Ali', deviceName: 'vivo', publicJwk: d.publicJwk, platform: 'android', pin: TEST_PIN, ...over };
}

describe('the loser of a setup race', () => {
  it('two phones on one nonce: the winner is 201, the loser is 409 already_set_up and writes nothing', async () => {
    const app = make();
    const nonce = await screenNonce(app);
    const post = async (b: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/setup/complete', remoteAddress: addr(), payload: b });
    const [a, b] = await Promise.all([post(await body(nonce)), post(await body(nonce, { adminName: 'Kedua' }))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().code).toBe('already_set_up');
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    expect(app.surau.db.prepare('SELECT COUNT(*) AS n FROM devices').get()?.n).toBe(1);
  });

  it('a junk nonce on an empty box is still 401 bad_code', async () => {
    const app = make();
    const r = await app.inject({ method: 'POST', url: '/api/setup/complete', remoteAddress: addr(), payload: await body('x'.repeat(43)) });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('bad_code');
  });
});

describe('recovery on a suspended box', () => {
  it('answers box_locked with its own words, not "there is an active Pentadbir"', async () => {
    const app = make();
    await loginAs(app, 'admin');
    issueRecoveryCode(app.surau.db);
    app.surau.db.prepare("INSERT INTO sync_state (key, value) VALUES ('suspended', '1')").run();
    const r = await app.inject({
      method: 'POST', url: '/api/recovery/complete', remoteAddress: addr(),
      payload: { ...(await body('x'.repeat(43))), recoveryCode: 'AAAA-AAAA-AAAA-AAAA' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('box_locked');
    expect(JSON.stringify(r.json())).not.toContain('Pentadbir aktif');
    expect(r.json().errors[0]).toContain('digantung');
    expect(app.surau.db.prepare("SELECT detail FROM auth_log WHERE event = 'recovery'").get()?.detail).toBe('box_locked');
  });

  it('a box with an active Pentadbir still says not_in_recovery', async () => {
    const app = make();
    await loginAs(app, 'admin');
    const r = await app.inject({
      method: 'POST', url: '/api/recovery/complete', remoteAddress: addr(),
      payload: { ...(await body('x'.repeat(43))), recoveryCode: 'AAAA-AAAA-AAAA-AAAA' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('not_in_recovery');
  });
});

describe('the box address in the QR', () => {
  it('leaves out the port when it is 443, keeps it otherwise', () => {
    expect(boxOrigin(TLS, 443)).toBe('https://10.168.0.20');
    expect(boxOrigin(TLS, 8443)).toBe('https://10.168.0.20:8443');
    const v6 = { ...TLS, ipSan: ['fd00::5', '::1'] } as TlsMaterial;
    expect(boxOrigin(v6, 443)).toBe('https://[fd00::5]');
    expect(boxOrigin(v6, 8443)).toBe('https://[fd00::5]:8443');
  });

  it('a QR from a box on 443 parses with the shared parser and its box is its own origin', async () => {
    const app = make({ tls: TLS, httpsPort: 443 });
    const v = (await app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' })).json() as BoxStateView;
    const p = parseBoxQr(v.qr!.payload);
    expect(p.box).toBe('https://10.168.0.20');
    expect(new URL(p.box).origin).toBe(p.box);
  });

  it('the TS parser refuses an explicit :443 (the old output), so the omission is needed', async () => {
    const app = make({ tls: TLS, httpsPort: 8443 });
    const v = (await app.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' })).json() as BoxStateView;
    const raw = JSON.parse(Buffer.from(v.qr!.payload.slice('maxcom1:'.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    raw.box = 'https://10.168.0.20:443';
    const text = `maxcom1:${Buffer.from(JSON.stringify(raw)).toString('base64url')}`;
    expect(() => parseBoxQr(text)).toThrow();
    raw.box = 'https://10.168.0.20';
    expect(() => parseBoxQr(`maxcom1:${Buffer.from(JSON.stringify(raw)).toString('base64url')}`)).not.toThrow();
  });
});
