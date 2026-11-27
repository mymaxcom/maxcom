// Recording download link (2026.11.15, O16/O32): the iPad saves the joined file through a short-lived URL instead of
// reading the whole file into memory; plus the total store limit across lives.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { Recordings } from '../src/live/recordings.ts';
import type { JoinRunner } from '../src/live/recordings.ts';
import { loginAs } from './authHelpers.ts';
import type { Login } from './authHelpers.ts';

const LIVE = 'AbCd1234EfGh';
const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fakeJoin = (): JoinRunner => async (_ff, args) => {
  const listPath = args[args.indexOf('-i') + 1]!;
  const list = readFileSync(listPath, 'utf8');
  const files = [...list.matchAll(/^file '(.*)'$/gm)].map((m) => join(dirname(listPath), m[1]!));
  writeFileSync(args[args.length - 1]!, Buffer.concat(files.map((f) => readFileSync(f))));
  return { code: 0, stderr: '' };
};

const mp4 = (tail: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('ftyp'), Buffer.from(tail)]);
const A = mp4('AA'); // 10 bytes
const B = mp4('BBBB'); // 12

interface Rig { app: FastifyInstance; dir: string; owner: Login; other: Login; admin: Login; clock: { t: number }; lines: string[] }

async function joinedRig(over: Record<string, unknown> = {}, join = true): Promise<Rig> {
  const dir = mkdtempSync(join_(tmpdir(), 'surau-reclink-'));
  dirs.push(dir);
  const clock = { t: Date.parse('2026-11-24T10:00:00Z') };
  const lines: string[] = [];
  const app = buildApp(join_(dir, 'test.db'), {
    dataDir: dir,
    liveRecordings: { ffmpegPath: () => 'ffmpeg-fake', run: fakeJoin(), free: () => 50 * 1024 ** 3, now: () => new Date(clock.t), log: (m: string) => lines.push(m), ...over },
  });
  apps.push(app);
  const owner = await loginAs(app, 'live');
  const other = await loginAs(app, 'live');
  const admin = await loginAs(app, 'admin');
  app.surau.db
    .prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'test', 'live', LIVE, null, JSON.stringify({ deviceId: owner.deviceId, source: 'phone' }));
  const r: Rig = { app, dir, owner, other, admin, clock, lines };
  await piece(r, 0, A);
  await piece(r, 1, B);
  if (join) expect((await app.inject({ method: 'POST', url: `/api/live/recordings/${LIVE}/join`, headers: owner.headers })).statusCode).toBe(200);
  return r;
}
const join_ = join;

const piece = (r: Rig, n: number, bytes: Buffer) =>
  r.app.inject({ method: 'POST', url: `/api/live/recordings/${LIVE}/pieces/${n}`, headers: { ...r.owner.headers, 'content-type': 'video/mp4', 'content-length': String(bytes.length) }, payload: bytes });
const linkOf = (r: Rig, who: Login) => r.app.inject({ method: 'POST', url: `/api/live/recordings/${LIVE}/link`, headers: who.headers });
const dl = (r: Rig, url: string, extra: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  r.app.inject({ method: 'GET', url, ...(extra.remoteAddress !== undefined ? { remoteAddress: extra.remoteAddress } : {}), ...(extra.headers !== undefined ? { headers: extra.headers } : {}) });
const urlOf = async (r: Rig): Promise<string> => ((await linkOf(r, r.owner)).json() as { url: string }).url;
const whole = Buffer.concat([A, B]);

describe('the download link', () => {
  it('the owner gets a url with a random 32-byte token and a 15 minute expiry; it downloads the whole joined file as an attachment', async () => {
    const r = await joinedRig();
    const res = await linkOf(r, r.owner);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { url, expiresAt } = res.json() as { url: string; expiresAt: string };
    expect(url).toMatch(/^\/api\/live\/recordings\/dl\/[0-9a-f]{64}$/);
    expect(Date.parse(expiresAt)).toBe(r.clock.t + 15 * 60_000);
    const got = await dl(r, url);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(whole)).toBe(true);
    expect(got.headers['content-disposition']).toBe('attachment; filename="MAXCOM-2026-11-24-AbCd1234EfGh.mp4"');
    expect(got.headers['content-type']).toBe('video/mp4');
    expect(got.headers['cache-control']).toBe('no-store');
    expect(got.headers['accept-ranges']).toBe('bytes');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    // asking again gives another token and the first one stops working
    const second = await urlOf(r);
    expect(second).not.toBe(url);
    expect((await dl(r, url)).statusCode).toBe(404);
    expect((await dl(r, second)).statusCode).toBe(200);
  });

  it('F18: the link is made only for a caller on the surau network (lan_only otherwise), so the app falls back to the Blob path', async () => {
    const r = await joinedRig();
    const out = await r.app.inject({ method: 'POST', url: `/api/live/recordings/${LIVE}/link`, headers: r.owner.headers, remoteAddress: '8.8.8.8' });
    expect(out.statusCode).toBe(403);
    expect(out.json().code).toBe('lan_only');
    expect(out.body).not.toMatch(/dl\//);
    const inside = await r.app.inject({ method: 'POST', url: `/api/live/recordings/${LIVE}/link`, headers: r.owner.headers, remoteAddress: '10.168.50.7' });
    expect(inside.statusCode).toBe(200);
  });

  it('only the owner device or an administrator may ask; others get a code; no joined file is not_ready', async () => {
    const r = await joinedRig();
    expect((await linkOf(r, r.admin)).statusCode).toBe(200);
    const other = await linkOf(r, r.other);
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('not_owner');
    const ajk = await loginAs(r.app, 'ajk');
    expect((await linkOf(r, ajk)).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'POST', url: '/api/live/recordings/NoSuchLive99/link', headers: r.admin.headers })).json().code).toBe('unknown_live');
    expect([401, 403]).toContain((await r.app.inject({ method: 'POST', url: `/api/live/recordings/${LIVE}/link` })).statusCode);
    const unjoined = await joinedRig({}, false);
    const none = await linkOf(unjoined, unjoined.owner);
    expect(none.statusCode).toBe(404);
    expect(none.json().code).toBe('not_ready');
  });

  it('is good for this purpose only: a wrong, short, long or made-up token is 404 bad_link, and it is not a session token', async () => {
    const r = await joinedRig();
    const token = (await urlOf(r)).split('/').pop()!;
    const wrong = await dl(r, `/api/live/recordings/dl/${'0'.repeat(64)}`);
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json().code).toBe('bad_link');
    // a token of another shape is refused by the handler's own shape check, the same as an unknown one
    for (const bad of [token.slice(0, 63), `${token}0`, 'x']) {
      const res = await dl(r, `/api/live/recordings/dl/${bad}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('bad_link');
    }
    const bearer = { authorization: `Bearer ${token}` };
    expect((await r.app.inject({ method: 'GET', url: `/api/live/recordings/${LIVE}/file`, headers: bearer })).statusCode).toBe(401);
    expect((await r.app.inject({ method: 'DELETE', url: `/api/live/recordings/${LIVE}`, headers: bearer })).statusCode).toBe(401);
  });

  it('expires after 15 minutes', async () => {
    const r = await joinedRig();
    const url = await urlOf(r);
    r.clock.t += 14 * 60_000 + 59_000;
    expect((await dl(r, url)).statusCode).toBe(200);
    r.clock.t += 2_000;
    const gone = await dl(r, url);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().code).toBe('bad_link');
    expect((await dl(r, await urlOf(r))).statusCode).toBe(200);
  });

  it('answers Range requests inside the lifetime (206; 416 past the end) so a download can resume', async () => {
    const r = await joinedRig();
    const url = await urlOf(r);
    const part = await dl(r, url, { headers: { range: 'bytes=4-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 4-9/${whole.length}`);
    expect(part.rawPayload.equals(whole.subarray(4, 10))).toBe(true);
    const tail = await dl(r, url, { headers: { range: 'bytes=15-' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(whole.subarray(15))).toBe(true);
    expect((await dl(r, url, { headers: { range: 'bytes=500-600' } })).statusCode).toBe(416);
    r.clock.t += 16 * 60_000;
    expect((await dl(r, url, { headers: { range: 'bytes=4-9' } })).statusCode).toBe(404);
  });

  it('deleting the recording (saved or given up) voids the link', async () => {
    const r = await joinedRig();
    const url = await urlOf(r);
    expect((await r.app.inject({ method: 'DELETE', url: `/api/live/recordings/${LIVE}`, headers: r.owner.headers })).json()).toEqual({ removed: true });
    const after = await dl(r, url);
    expect(after.statusCode).toBe(404);
    expect(after.json().code).toBe('bad_link');
  });

  it('a restart voids it: the box keeps only a hash in memory and nothing on disk holds the token', async () => {
    const r = await joinedRig();
    const token = (await urlOf(r)).split('/').pop()!;
    const fresh = new Recordings({ dataDir: r.dir, ffmpegPath: () => null, free: () => null });
    expect(fresh.resolveLink(token)).toBeNull();
    const folder = join(r.dir, 'live-recordings', LIVE);
    for (const f of readdirSync(folder)) expect(readFileSync(join(folder, f)).includes(token)).toBe(false);
  });

  it('works only on the surau network: an outside address or any proxy header is refused with lan_only and gets nothing', async () => {
    const r = await joinedRig();
    const url = await urlOf(r);
    const out = await dl(r, url, { remoteAddress: '8.8.8.8' });
    expect(out.statusCode).toBe(403);
    expect(out.json().code).toBe('lan_only');
    expect(out.rawPayload.includes(A)).toBe(false);
    expect((await dl(r, url, { headers: { 'x-forwarded-for': '10.168.50.7' } })).statusCode).toBe(403);
    expect((await dl(r, url, { headers: { 'cf-connecting-ip': '8.8.8.8' } })).statusCode).toBe(403);
    expect((await dl(r, url, { remoteAddress: '10.168.50.7' })).statusCode).toBe(200);
  });

  it('is rate limited per address (429 with Retry-After) for wrong guesses; a valid download never counts', async () => {
    const r = await joinedRig({ dlRate: { windowMs: 60_000, max: 4 } });
    const url = await urlOf(r);
    const ip = '10.168.50.9';
    // F4: a Range download makes many valid requests: none is counted
    for (let i = 0; i < 10; i++) expect([200, 206]).toContain((await dl(r, url, { remoteAddress: ip, headers: { range: 'bytes=0-9' } })).statusCode);
    for (const n of ['1', '2', '3', '4']) expect((await dl(r, `/api/live/recordings/dl/${n.repeat(64)}`, { remoteAddress: ip })).statusCode).toBe(404);
    const limited = await dl(r, `/api/live/recordings/dl/${'5'.repeat(64)}`, { remoteAddress: ip });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await dl(r, url, { remoteAddress: '10.168.50.10' })).statusCode).toBe(200);
  });

  it('never puts the token in a log line, a refusal body, a header or the change log', async () => {
    const r = await joinedRig();
    const url = await urlOf(r);
    const token = url.split('/').pop()!;
    const answers = [await dl(r, url), await dl(r, url, { remoteAddress: '8.8.8.8' }), await dl(r, url, { headers: { range: 'bytes=999-1000' } })];
    await r.app.inject({ method: 'DELETE', url: `/api/live/recordings/${LIVE}`, headers: r.owner.headers });
    answers.push(await dl(r, url));
    for (const a of answers) expect(JSON.stringify(a.headers)).not.toContain(token);
    expect(answers[1]!.body).not.toContain(token);
    expect(answers[3]!.body).not.toContain(token);
    expect(r.lines.join('\n')).not.toContain(token);
    expect(JSON.stringify(r.app.surau.db.prepare('SELECT * FROM change_log').all())).not.toContain(token);
  });
});

describe('the whole store has a limit, across lives', () => {
  it('a piece that would take all recordings over the box limit is refused with no_space; a replacement is judged on the difference; removing a live gives room back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-rectotal-'));
    dirs.push(dir);
    const rec = new Recordings({ dataDir: dir, ffmpegPath: () => null, free: () => null, maxTotalBytes: 30, maxPerDeviceBytes: 30 });
    const put = (id: string, n: number, b: Buffer) => rec.putPiece(id, 'dev', n, 'video/mp4', b.length, Readable.from([b]));
    await put('TotalLive001', 0, A); // 10
    await put('TotalLive002', 0, B); // 12, together 22
    await expect(put('TotalLive003', 0, mp4('C'))).rejects.toMatchObject({ status: 413, code: 'no_space' }); // 9 more is 31
    await expect(put('TotalLive002', 0, mp4('BBBBBB'))).resolves.toMatchObject({ pieces: 1 }); // 14 replaces 12: 24
    await expect(put('TotalLive002', 0, mp4('BBBBBBBBBBBBB'))).rejects.toMatchObject({ status: 413, code: 'no_space' }); // 21 replaces 14: 31
    expect(rec.remove('TotalLive001')).toBe(true);
    await expect(put('TotalLive002', 0, mp4('BBBBBBBBBBBBB'))).resolves.toMatchObject({ pieces: 1 }); // 21 alone
  });
});

describe('S10: one device holds at most half of the box total', () => {
  it('a device over its half is refused no_space while another device still has room; a replacement is judged on the difference; removing a live gives room back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-recdev-'));
    dirs.push(dir);
    const rec = new Recordings({ dataDir: dir, ffmpegPath: () => null, free: () => null, maxTotalBytes: 40 }); // half is 20
    const put = (dev: string, id: string, n: number, b: Buffer) => rec.putPiece(id, dev, n, 'video/mp4', b.length, Readable.from([b]));
    await put('devA', 'DevHalfLive01', 0, A); // A holds 10
    await expect(put('devA', 'DevHalfLive02', 0, B)).rejects.toMatchObject({ status: 413, code: 'no_space' }); // 22 is over A's half (20)
    await expect(put('devB', 'DevHalfLive02', 0, B)).resolves.toMatchObject({ pieces: 1 }); // B holds 12, the box 22 of 40
    await expect(put('devA', 'DevHalfLive01', 0, mp4('BBBBBB'))).resolves.toMatchObject({ pieces: 1 }); // replacing 10 with 14 stays under 20
    expect(rec.storedBytesOf('devA')).toBe(14);
    expect(rec.remove('DevHalfLive01')).toBe(true);
    await expect(put('devA', 'DevHalfLive03', 0, B)).resolves.toMatchObject({ pieces: 1 }); // room again
  });
});
