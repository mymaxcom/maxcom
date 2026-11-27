import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signLink } from '../src/link/sign.ts';
import { loadIdentity } from '../src/setup/identity.ts';
import type { BoxIdentity } from '../src/setup/identity.ts';
import { PIN, createWorld } from './support/twoBoxes.ts';
import type { TestBox, World } from './support/twoBoxes.ts';

/**
 * The two giver-side routes of the store move (`POST /api/link/peer/store/list`, `GET /api/link/peer/store/file`).
 * Two real boxes with data folders are brought to the questions of a link; the giver box is then put in step
 * `agreed` with answers of case X (its data kept, the other box the master) by writing its session row. The master's
 * own work is never run (case X is not ready in `work.ts`), so the giver stays in `agreed` for the whole test.
 */

const LIST = '/api/link/peer/store/list';
const FILE = '/api/link/peer/store/file';
const TOKEN = 'x-link-store';

let w: World;
beforeEach(() => {
  w = createWorld();
});
afterEach(async () => {
  await w.close();
});

const put = (dir: string, rel: string, data: Buffer | string): void => {
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
};

interface Rig {
  /** The box that showed the QR and is the master in the honest case S answers; here the peer that asks. */
  a: TestBox;
  /** The scanning box: its data is kept and the other box is the master, so it GIVES its store. */
  b: TestBox;
  linkId: string;
  idA: BoxIdentity;
  idB: BoxIdentity;
}

const poster = Buffer.from('poster one: bytes of a picture');
const video = Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7) % 251));

/** Both boxes set up with data folders, a link opened and approved up to the questions; nobody agreed yet. */
async function rig(): Promise<Rig> {
  const a = await w.make(1, { persist: true });
  const b = await w.make(2, { persist: true });
  expect((await a.call('POST', '/api/link/show', { pin: PIN })).status).toBe(200);
  const qr = String((await a.tv()).body.qr.payload);
  expect((await b.call('POST', '/api/link/scan', { pin: PIN, qr })).status).toBe(200);
  const ap = await a.call('POST', '/api/link/approve', { ok: true });
  expect(ap.status).toBe(200);
  const linkId = String(ap.body.session.id);
  put(b.dir!, 'assets/poster-1.jpg', poster);
  put(b.dir!, 'assets/sub/video-1.mp4', video);
  put(b.dir!, 'finance/photos/receipt-1.jpg', Buffer.from('receipt'));
  put(b.dir!, 'themes/hijau/theme.json', '{"name":"Hijau"}');
  put(b.dir!, 'import/scratch.zip', Buffer.from('scratch'));
  put(b.dir!, 'secret/sync.key', Buffer.from('cloud key'));
  return { a, b, linkId, idA: loadIdentity(a.dir!), idB: loadIdentity(b.dir!) };
}

type Pair = { keep: 'show' | 'scan'; master: 'show' | 'scan' };
/** Writes the session row of a box as it would be past the agreement, with these answers (the shape is the real one). */
function setSession(box: TestBox, linkId: string, step: string, answers: Pair): void {
  const db = box.app.surau.db;
  const row = db.prepare('SELECT answers_json FROM link_sessions WHERE id = ?').get(linkId);
  const cur = JSON.parse(String(row!.answers_json)) as Record<string, unknown>;
  db.prepare('UPDATE link_sessions SET step = ?, answers_json = ? WHERE id = ?').run(step, JSON.stringify({ ...cur, ...answers }), linkId);
}

const signed = (linkId: string, who: BoxIdentity, step = 'store-list', signedStep = step, body: Record<string, unknown> = { page: 0 }): Record<string, unknown> => ({
  linkId, step, body, sig: signLink(who, signedStep as 'store-list', linkId, body),
});

const list = (r: Rig, body: unknown, from = r.a.addr) =>
  r.b.app.inject({ method: 'POST', url: LIST, payload: body as object, remoteAddress: from });

/** The honest asker: a signed list request until the answer is `ready`. */
async function readyList(r: Rig): Promise<{ list: { files: { path: string; size: number; sha256: string }[]; linkId: string; bytes: number }; token: string }> {
  for (let i = 0; i < 300; i++) {
    const res = await list(r, signed(r.linkId, r.idA));
    expect(res.statusCode).toBe(200);
    const j = res.json();
    if (j.state === 'ready') return { list: { files: j.files, linkId: j.linkId, bytes: j.bytes }, token: j.token };
    expect(j.state).toBe('preparing');
    await new Promise((x) => setTimeout(x, 20));
  }
  throw new Error('list never became ready');
}

const file = (r: Rig, o: { token?: string; path: string; linkId?: string; range?: string; from?: string }) =>
  r.b.app.inject({
    method: 'GET', url: `${FILE}?linkId=${encodeURIComponent(o.linkId ?? r.linkId)}&path=${encodeURIComponent(o.path)}`,
    remoteAddress: o.from ?? r.a.addr,
    headers: { ...(o.token === undefined ? {} : { [TOKEN]: o.token }), ...(o.range === undefined ? {} : { range: o.range }) },
  });

describe('store list, at the giver', () => {
  it('listOnlyForSessionPeer: unsigned, wrong key, wrong step in the signature, other link id: 400 bad_message', async () => {
    const r = await rig();
    setSession(r.b, r.linkId, 'agreed', { keep: 'scan', master: 'show' });
    const other = 'e5'.repeat(16);
    const bodies: unknown[] = [
      {},
      null,
      { linkId: r.linkId, step: 'store-list', body: {} },
      { linkId: r.linkId, step: 'store-list', body: {}, sig: 'A'.repeat(86) },
      signed(r.linkId, r.idB), // signed by the giver's own key, not the peer's
      signed(r.linkId, r.idA, 'store-list', 'people'), // signature made for another step
      signed(r.linkId, r.idA, 'people', 'people'), // honest signature but another step named
      signed(other, r.idA), // another link id
      { ...signed(r.linkId, r.idA), body: { extra: 1 } }, // body changed after signing
      { ...signed(r.linkId, r.idA), linkId: other },
      { ...signed(r.linkId, r.idA), step: 'commit' },
    ];
    for (const b of bodies) {
      const res = await list(r, b);
      expect(res.statusCode, JSON.stringify(b)).toBe(400);
      expect(res.json().code).toBe('bad_message');
    }
    // nothing was prepared for any of them
    const ok = await list(r, signed(r.linkId, r.idA));
    expect(ok.json()).toEqual({ state: 'preparing' });
  });

  it('listOutsideWorkRefused: before the agreement, a box that is the master, and case S: 409 wrong_step', async () => {
    const r = await rig();
    // before the agreement (the real state after approve: questions)
    let res = await list(r, signed(r.linkId, r.idA));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('wrong_step');

    // agreed, but the answers are case S (same box kept and master)
    setSession(r.b, r.linkId, 'agreed', { keep: 'show', master: 'show' });
    res = await list(r, signed(r.linkId, r.idA));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('wrong_step');
    setSession(r.b, r.linkId, 'agreed', { keep: 'scan', master: 'scan' });
    res = await list(r, signed(r.linkId, r.idA));
    expect(res.statusCode).toBe(409);

    // this box is the master (it scanned and the answers make the scanner master)
    setSession(r.b, r.linkId, 'agreed', { keep: 'show', master: 'scan' });
    res = await list(r, signed(r.linkId, r.idA));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('wrong_step');

    // the same on the box that showed: it is the master of case X answers where the shower is the master
    setSession(r.a, r.linkId, 'agreed', { keep: 'scan', master: 'show' });
    const back = await r.a.app.inject({ method: 'POST', url: LIST, payload: signed(r.linkId, r.idB) as object, remoteAddress: r.b.addr });
    expect(back.statusCode).toBe(409);
    expect(back.json().code).toBe('wrong_step');

    // a session that is done gives nothing
    setSession(r.b, r.linkId, 'agreed', { keep: 'scan', master: 'show' });
    r.b.app.surau.db.prepare("UPDATE link_sessions SET step = 'done', finished_at = ?, outcome = 'failed' WHERE id = ?").run(w.clock.now().toISOString(), r.linkId);
    res = await list(r, signed(r.linkId, r.idA));
    expect(res.statusCode).toBe(400);
  });

  it('a box that is not LAN-direct is refused before the signature is looked at: 403 lan_only', async () => {
    const r = await rig();
    setSession(r.b, r.linkId, 'agreed', { keep: 'scan', master: 'show' });
    const res = await list(r, signed(r.linkId, r.idA), '8.8.8.8');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('lan_only');
  });

  it('first call preparing, then ready with the list and a token; the list holds the moved files only', async () => {
    const r = await rig();
    setSession(r.b, r.linkId, 'working', { keep: 'scan', master: 'show' });
    const first = await list(r, signed(r.linkId, r.idA));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ state: 'preparing' });
    const { list: l, token } = await readyList(r);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(l.linkId).toBe(r.linkId);
    const paths = l.files.map((f) => f.path);
    for (const p of ['surau.db', 'assets/poster-1.jpg', 'assets/sub/video-1.mp4', 'finance/photos/receipt-1.jpg', 'themes/hijau/theme.json']) expect(paths).toContain(p);
    for (const p of paths) {
      expect(p).not.toMatch(/^(import|secret|live)\//);
      expect(p === 'surau.db' || /^(assets|finance\/photos|themes)\//.test(p)).toBe(true);
    }
    expect(l.files.find((f) => f.path === 'assets/poster-1.jpg')!.size).toBe(poster.length);
    expect(l.bytes).toBe(l.files.reduce((n, f) => n + f.size, 0));
    // the answer carries no secret of the box besides the one-time token
    expect(JSON.stringify(l)).not.toContain('cloud key');
  });

  it('pages: the list is built once and read in pages of 2,000 entries; the token comes with page 0 only; a page that does not exist, a body that is not exactly {page} and a page before the list is built are refused', async () => {
    const r = await rig();
    setSession(r.b, r.linkId, 'working', { keep: 'scan', master: 'show' });
    for (let i = 0; i < 4500; i++) put(r.b.dir!, `assets/many/p${i}.jpg`, `p${i}`);
    // a later page before any list was built: no list to slice
    const early = await list(r, signed(r.linkId, r.idA, 'store-list', 'store-list', { page: 1 }));
    expect([early.statusCode, early.json().code]).toEqual([409, 'wrong_step']);
    let p0: Record<string, any> | null = null;
    for (let i = 0; i < 400 && p0 === null; i++) {
      const res = await list(r, signed(r.linkId, r.idA));
      expect(res.statusCode).toBe(200);
      if (res.json().state === 'ready') p0 = res.json();
      else await new Promise((x) => setTimeout(x, 100));
    }
    expect(p0).not.toBeNull();
    const total = p0!.total as number;
    expect(total).toBeGreaterThanOrEqual(4500 + 5);
    expect([p0!.page, p0!.pages, p0!.files.length]).toEqual([0, Math.ceil(total / 2000), 2000]);
    expect(typeof p0!.token).toBe('string');
    expect(p0!.files.some((f: { path: string }) => f.path === 'surau.db')).toBe(true);
    const seen = new Set<string>(p0!.files.map((f: { path: string }) => f.path));
    for (let n = 1; n < p0!.pages; n++) {
      const res = await list(r, signed(r.linkId, r.idA, 'store-list', 'store-list', { page: n }));
      expect(res.statusCode, res.body).toBe(200);
      const j = res.json();
      expect([j.state, j.page, j.pages, j.total]).toEqual(['ready', n, p0!.pages, total]);
      expect(j.token).toBeUndefined();
      expect(j.secrets).toBeUndefined();
      expect(j.files.length).toBe(n < p0!.pages - 1 ? 2000 : total - 2000 * (p0!.pages - 1));
      for (const f of j.files) {
        expect(seen.has(f.path)).toBe(false);
        seen.add(f.path);
      }
    }
    expect(seen.size).toBe(total);
    // a later page did not replace the token of page 0
    const hold = await file(r, { token: p0!.token, path: 'assets/poster-1.jpg' });
    expect(hold.statusCode).toBe(200);
    for (const bad of [{ page: p0!.pages }, { page: -1 }, { page: 1.5 }, { page: '0' }, { page: 1_000_000 }, { extra: 1 }, { page: 0, extra: 1 }]) {
      const res = await list(r, signed(r.linkId, r.idA, 'store-list', 'store-list', bad));
      expect([res.statusCode, res.json().code], JSON.stringify(bad)).toEqual([400, 'bad_message']);
    }
  }, 120_000);

  it('compat with the previous release: a request with an empty body is page 0, a short list also comes as `list`', async () => {
    const r = await rig();
    setSession(r.b, r.linkId, 'working', { keep: 'scan', master: 'show' });
    const empty = signed(r.linkId, r.idA, 'store-list', 'store-list', {});
    const answer = async (): Promise<Record<string, any>> => {
      for (let i = 0; i < 300; i++) {
        const res = await list(r, empty);
        if (res.statusCode !== 200) return { status: res.statusCode, ...res.json() };
        if (res.json().state === 'ready') return res.json();
        await new Promise((x) => setTimeout(x, 100));
      }
      throw new Error('list never ready');
    };
    const small = await answer();
    expect(small.state).toBe('ready');
    expect(small.list.files.length).toBe(small.total);
    expect(small.page).toBe(0);
    expect(typeof small.token).toBe('string');
  }, 120_000);

  it('compat with the previous release: a list of more than one page is refused once with 409 version when the asker sent no page, and read in pages when it did', async () => {
    const r = await rig();
    setSession(r.b, r.linkId, 'working', { keep: 'scan', master: 'show' });
    for (let i = 0; i < 2100; i++) put(r.b.dir!, `assets/many/q${i}.jpg`, `q${i}`);
    const asked = async (body: Record<string, unknown>): Promise<{ status: number; json: Record<string, any> }> => {
      for (let i = 0; i < 300; i++) {
        const res = await list(r, signed(r.linkId, r.idA, 'store-list', 'store-list', body));
        const j = res.json() as Record<string, any>;
        if (res.statusCode !== 200 || j.state === 'ready') return { status: res.statusCode, json: j };
        await new Promise((x) => setTimeout(x, 100));
      }
      throw new Error('list never ready');
    };
    const old = await asked({});
    expect([old.status, old.json.code]).toEqual([409, 'version']);
    expect(old.json.token).toBeUndefined();
    const nu = await asked({ page: 0 });
    expect([nu.status, nu.json.pages > 1, nu.json.list]).toEqual([200, true, undefined]);
    expect(typeof nu.json.token).toBe('string');
  }, 120_000);

  it('a new list call rotates the token: the old token gets 404, the new one reads', async () => {
    const r = await rig();
    setSession(r.b, r.linkId, 'agreed', { keep: 'scan', master: 'show' });
    const one = await readyList(r);
    expect((await file(r, { token: one.token, path: 'assets/poster-1.jpg' })).statusCode).toBe(200);
    const two = await readyList(r);
    expect(two.token).not.toBe(one.token);
    const old = await file(r, { token: one.token, path: 'assets/poster-1.jpg' });
    expect(old.statusCode).toBe(404);
    expect(old.json().code).toBe('not_found');
    expect((await file(r, { token: two.token, path: 'assets/poster-1.jpg' })).statusCode).toBe(200);
  });
});

describe('store file, at the giver', () => {
  async function ready(): Promise<{ r: Rig; token: string; size: number }> {
    const r = await rig();
    setSession(r.b, r.linkId, 'agreed', { keep: 'scan', master: 'show' });
    const { token, list: l } = await readyList(r);
    return { r, token, size: l.files.find((f) => f.path === 'assets/sub/video-1.mp4')!.size };
  }

  it('a full read with the token is 200 with the exact bytes; the database copy opens as a file of the list size', async () => {
    const { r, token } = await ready();
    const res = await file(r, { token, path: 'assets/sub/video-1.mp4' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(video.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.equals(video)).toBe(true);
    const lst = await readyList(r);
    const db = await file(r, { token: lst.token, path: 'surau.db' });
    expect(db.statusCode).toBe(200);
    expect(db.rawPayload.length).toBe(lst.list.files.find((f) => f.path === 'surau.db')!.size);
    expect(db.rawPayload.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  it('a ranged read bytes=N- is 206 with the right Content-Range and the rest of the bytes', async () => {
    const { r, token, size } = await ready();
    const res = await file(r, { token, path: 'assets/sub/video-1.mp4', range: 'bytes=2500-' });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 2500-${size - 1}/${size}`);
    expect(res.headers['content-length']).toBe(String(size - 2500));
    expect(res.rawPayload.equals(video.subarray(2500))).toBe(true);
    const last = await file(r, { token, path: 'assets/sub/video-1.mp4', range: `bytes=${size - 1}-` });
    expect(last.statusCode).toBe(206);
    expect(last.rawPayload.equals(video.subarray(size - 1))).toBe(true);
    // a range from the very end: empty body, still 206 (the receiver then has the whole file)
    const end = await file(r, { token, path: 'assets/sub/video-1.mp4', range: `bytes=${size}-` });
    expect(end.statusCode).toBe(206);
    expect(end.rawPayload.length).toBe(0);
  });

  it('a range the giver does not understand falls back to the whole file (200), a start beyond the size too', async () => {
    const { r, token } = await ready();
    for (const range of ['bytes=0-10', 'bytes=-5', 'bytes=999999-', 'lines=1-']) {
      const res = await file(r, { token, path: 'assets/sub/video-1.mp4', range });
      expect(res.statusCode, range).toBe(200);
      expect(res.rawPayload.equals(video)).toBe(true);
    }
  });

  it('no token, wrong token, short token: 404 not_found', async () => {
    const { r, token } = await ready();
    for (const t of [undefined, '', 'x'.repeat(43), token.slice(0, 20), `${token}x`, token.toUpperCase()]) {
      const res = await file(r, { ...(t === undefined ? {} : { token: t }), path: 'assets/poster-1.jpg' });
      expect(res.statusCode, String(t)).toBe(404);
      expect(res.json().code).toBe('not_found');
    }
  });

  it('an unlisted path, a traversal, the secrets and the scratch folder: 404 not_found, even with the right token', async () => {
    const { r, token } = await ready();
    put(r.b.dir!, 'assets/added-after-the-list.jpg', 'new');
    const paths = [
      'assets/added-after-the-list.jpg', '../secret/box.key', 'secret/box.key', 'secret/sync.key', 'secret/identity.key', 'import/scratch.zip',
      'assets/../secret/sync.key', '/assets/poster-1.jpg', 'assets\\poster-1.jpg', 'assets//poster-1.jpg', './assets/poster-1.jpg',
      'C:/Windows/win.ini', '..\\..\\secret\\box.key', 'surau.db-wal', 'surau.db-shm', 'ASSETS/POSTER-1.JPG', '', 'linkstage-out/' + r.linkId + '/surau.db',
      'identity.key', 'follow.json', '%2e%2e/secret/box.key',
    ];
    for (const p of paths) {
      const res = await file(r, { token, path: p });
      expect(res.statusCode, p).toBe(404);
      expect(res.json().code, p).toBe('not_found');
    }
    // a path given twice in the query is not a way round either
    const dup = await r.b.app.inject({
      method: 'GET', url: `${FILE}?linkId=${r.linkId}&path=secret/box.key&path=assets/poster-1.jpg`, remoteAddress: r.a.addr, headers: { [TOKEN]: token },
    });
    expect(dup.statusCode).toBe(404);
  });

  it('another link id: 404 not_found', async () => {
    const { r, token } = await ready();
    for (const id of ['e5'.repeat(16), '', 'x', r.linkId.toUpperCase(), `${r.linkId}0`]) {
      const res = await file(r, { token, path: 'assets/poster-1.jpg', linkId: id });
      expect(res.statusCode, id).toBe(404);
      expect(res.json().code).toBe('not_found');
    }
  });

  it('from a non-LAN address: 403 lan_only, even with the token', async () => {
    const { r, token } = await ready();
    const res = await file(r, { token, path: 'assets/poster-1.jpg', from: '8.8.8.8' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('lan_only');
  });

  it('the token alone does not open a session that is not giving: after the session ends (or turns case S) every read is 404', async () => {
    const { r, token } = await ready();
    setSession(r.b, r.linkId, 'agreed', { keep: 'show', master: 'show' });
    expect((await file(r, { token, path: 'assets/poster-1.jpg' })).statusCode).toBe(404);
    setSession(r.b, r.linkId, 'agreed', { keep: 'scan', master: 'show' });
    expect((await file(r, { token, path: 'assets/poster-1.jpg' })).statusCode).toBe(200);
    r.b.app.surau.db.prepare("UPDATE link_sessions SET step = 'done', finished_at = ?, outcome = 'cancelled' WHERE id = ?").run(w.clock.now().toISOString(), r.linkId);
    expect((await file(r, { token, path: 'assets/poster-1.jpg' })).statusCode).toBe(404);
  });

  it('the file read needs no sign-in, and the read bytes are the ones on disk', async () => {
    const { r, token } = await ready();
    const res = await file(r, { token, path: 'assets/poster-1.jpg' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(readFileSync(join(r.b.dir!, 'assets', 'poster-1.jpg')))).toBe(true);
  });
});
