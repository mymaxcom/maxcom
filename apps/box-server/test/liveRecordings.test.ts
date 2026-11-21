// Recording merge, box side (2026.11.14, contract C): pieces upload, ffmpeg concat copy, file download, cleanup.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { Recordings, concatList, joinArgs, magicOk } from '../src/live/recordings.ts';
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

/** A fake ffmpeg: reads the concat list and writes the pieces one after the other into the output (what `-c copy` amounts to). */
const fakeJoin = (calls: Array<{ args: readonly string[]; list: string }> = []): JoinRunner => async (_ff, args) => {
  const listPath = args[args.indexOf('-i') + 1]!;
  const list = readFileSync(listPath, 'utf8');
  calls.push({ args, list });
  // the demuxer resolves the bare names against the folder of the list
  const files = [...list.matchAll(/^file '(.*)'$/gm)].map((m) => join(dirname(listPath), m[1]!.replaceAll("'\\''", "'")));
  writeFileSync(args[args.length - 1]!, Buffer.concat(files.map((f) => readFileSync(f))));
  return { code: 0, stderr: '' };
};

interface Rig { app: FastifyInstance; dir: string; owner: Login; other: Login; admin: Login; calls: Array<{ args: readonly string[]; list: string }> }

async function rig(over: Parameters<typeof buildApp>[1] = {}, run?: JoinRunner): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-rec-'));
  dirs.push(dir);
  const calls: Rig['calls'] = [];
  const app = buildApp(join(dir, 'test.db'), {
    dataDir: dir,
    liveRecordings: { ffmpegPath: () => 'ffmpeg-fake', run: run ?? fakeJoin(calls), free: () => 50 * 1024 ** 3 },
    ...over,
  });
  apps.push(app);
  const owner = await loginAs(app, 'live');
  const other = await loginAs(app, 'live');
  const admin = await loginAs(app, 'admin');
  // the live this owner ran: its start record (what LiveSessions writes) names the device
  app.surau.db
    .prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'test', 'live', LIVE, null, JSON.stringify({ deviceId: owner.deviceId, source: 'phone' }));
  return { app, dir, owner, other, admin, calls };
}

const piece = (r: Rig, who: Login, n: number | string, bytes: Buffer, type = 'video/mp4', live = LIVE) =>
  r.app.inject({ method: 'POST', url: `/api/live/recordings/${live}/pieces/${n}`, headers: { ...who.headers, 'content-type': type, 'content-length': String(bytes.length) }, payload: bytes });
const join_ = (r: Rig, who: Login, body?: object) =>
  r.app.inject({ method: 'POST', url: `/api/live/recordings/${LIVE}/join`, headers: who.headers, ...(body !== undefined ? { payload: body } : {}) });
const fileOf = (r: Rig, who: Login) => r.app.inject({ method: 'GET', url: `/api/live/recordings/${LIVE}/file`, headers: who.headers });
const recDir = (r: Rig): string => join(r.dir, 'live-recordings', LIVE);
/** What a recording piece starts with: an mp4 has `ftyp` at offset 4, a webm the EBML id. */
const mp4 = (tail: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('ftyp'), Buffer.from(tail)]);
const webm = (tail: string): Buffer => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(tail)]);
const A = mp4('AA'); // 10 bytes
const B = mp4('BBBB'); // 12
const C = mp4('C'); // 9

describe('who may send the pieces of a live', () => {
  it('the device that ran the live, or an administrator; not another device, not a person who cannot run a live, not an unknown live', async () => {
    const r = await rig();
    expect((await piece(r, r.owner, 0, A)).statusCode).toBe(200);
    expect((await piece(r, r.admin, 1, B)).statusCode).toBe(200);
    const other = await piece(r, r.other, 2, C);
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('not_owner');
    const ajk = await loginAs(r.app, 'ajk');
    expect((await piece(r, ajk, 2, C)).statusCode).toBe(403);
    const unknown = await piece(r, r.admin, 0, A, 'video/mp4', 'NoSuchLive99');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('unknown_live');
    // the same rule for the join, the file and the removal
    expect((await join_(r, r.other)).statusCode).toBe(403);
    expect((await fileOf(r, r.other)).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'DELETE', url: `/api/live/recordings/${LIVE}`, headers: r.other.headers })).statusCode).toBe(403);
    expect(readdirSync(recDir(r)).filter((f) => f.startsWith('piece-')).sort()).toEqual(['piece-00000.mp4', 'piece-00001.mp4']);
  });

  it('a live that started on a release without a recorded device is open to administrators only', async () => {
    const r = await rig();
    r.app.surau.db.prepare("UPDATE change_log SET after_json = '{}' WHERE entity = 'live'").run();
    expect((await piece(r, r.owner, 0, A)).statusCode).toBe(403);
    expect((await piece(r, r.admin, 0, A)).statusCode).toBe(200);
  });
});

describe('the pieces', () => {
  it('are stored in order, a piece sent again replaces the first, and the answer counts them', async () => {
    const r = await rig();
    expect((await piece(r, r.owner, 0, A)).json()).toMatchObject({ n: 0, bytes: 10, pieces: 1, totalBytes: 10 });
    expect((await piece(r, r.owner, 1, B)).json()).toMatchObject({ pieces: 2, totalBytes: 22 });
    expect((await piece(r, r.owner, 1, C)).json()).toMatchObject({ pieces: 2, totalBytes: 19 });
    expect(readFileSync(join(recDir(r), 'piece-00001.mp4'))).toEqual(C);
  });

  it('refuse a bad number, a type the box cannot join, a mix of mp4 and webm', async () => {
    const r = await rig();
    expect((await piece(r, r.owner, 'x', A)).json().code).toBe('bad_piece');
    expect((await piece(r, r.owner, 5000, A)).json().code).toBe('bad_piece');
    expect((await piece(r, r.owner, 0, A, 'text/plain')).json().code).toBe('bad_piece');
    expect((await piece(r, r.owner, 0, A)).statusCode).toBe(200);
    const mixed = await piece(r, r.owner, 1, webm('bb'), 'video/webm;codecs=vp8,opus');
    expect(mixed.statusCode).toBe(409);
    expect(mixed.json().code).toBe('mixed_types');
  });

  it('are refused with too_big over the piece limit and over the limit of the whole live, and no_space when the box would keep too little free', async () => {
    const small = await rig({ liveRecordings: { ffmpegPath: () => 'f', run: fakeJoin(), free: () => 50 * 1024 ** 3, maxPieceBytes: 11, maxLiveBytes: 22 } });
    const big = await piece(small, small.owner, 0, B);
    expect(big.statusCode).toBe(413);
    expect(big.json().code).toBe('too_big');
    expect((await piece(small, small.owner, 0, A)).statusCode).toBe(200);
    expect((await piece(small, small.owner, 1, A)).statusCode).toBe(200);
    const over = await piece(small, small.owner, 2, A);
    expect(over.statusCode).toBe(413);
    expect(over.json().code).toBe('too_big');
    const tight = await rig({ liveRecordings: { ffmpegPath: () => 'f', run: fakeJoin(), free: () => 100 * 1024 * 1024 } });
    const noRoom = await piece(tight, tight.owner, 0, A);
    expect(noRoom.statusCode).toBe(413);
    expect(noRoom.json().code).toBe('no_space');
    expect(existsSync(join(tight.dir, 'live-recordings', LIVE, 'piece-00000.mp4'))).toBe(false);
  });
});

describe('the join', () => {
  it('copies the pieces into one file with the concat demuxer (-c copy, never a re-encode) in piece order, then removes the pieces', async () => {
    const r = await rig();
    for (const [n, b] of [[2, C], [0, A], [1, B]] as const) expect((await piece(r, r.owner, n, b)).statusCode).toBe(200);
    const j = await join_(r, r.owner, { count: 3 });
    expect(j.statusCode).toBe(200);
    expect(j.json()).toEqual({ bytes: 31, container: 'mp4', pieces: 3 });
    const call = r.calls[0]!;
    expect(call.args).toEqual(expect.arrayContaining(['-f', 'concat', '-protocol_whitelist', 'file', '-c', 'copy']));
    expect(call.args).not.toContain('libx264');
    // no unsafe names, and the list names its pieces bare (no folder)
    expect(call.args).not.toContain('-safe');
    expect(call.list).toBe("file 'piece-00000.mp4'\nfile 'piece-00001.mp4'\nfile 'piece-00002.mp4'\n");
    expect(call.args[call.args.indexOf('-format_whitelist') + 1]).toBe('concat,mov,mp4,m4a,3gp,3g2,mj2,matroska,webm');
    expect(call.args.indexOf('-protocol_whitelist')).toBeLessThan(call.args.indexOf('-i'));
    const order = [...call.list.matchAll(/piece-(\d{5})/g)].map((m) => Number(m[1]));
    expect(order).toEqual([0, 1, 2]);
    // the pieces are gone, the joined file stands
    expect(readdirSync(recDir(r)).filter((f) => f.startsWith('piece-'))).toEqual([]);
    const f = await fileOf(r, r.owner);
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-type']).toBe('video/mp4');
    expect(f.headers['content-length']).toBe('31');
    expect(String(f.headers['content-disposition'])).toMatch(/^attachment; filename="MAXCOM-\d{4}-\d{2}-\d{2}-AbCd1234EfGh\.mp4"$/);
    expect(f.rawPayload).toEqual(Buffer.concat([A, B, C]));
    // asked again after a good join (the answer was lost): the same file, no second ffmpeg
    expect((await join_(r, r.owner)).json()).toMatchObject({ bytes: 31, pieces: 0 });
    expect(r.calls).toHaveLength(1);
  });

  it('webm pieces are joined to webm', async () => {
    const r = await rig();
    await piece(r, r.owner, 0, webm('aa'), 'video/webm;codecs=vp8,opus');
    await piece(r, r.owner, 1, webm('bbbb'), 'video/webm');
    const j = await join_(r, r.owner);
    expect(j.json().container).toBe('webm');
    expect(r.calls[0]!.args[r.calls[0]!.args.length - 1]).toMatch(/joined-tmp\.webm$/);
    const f = await fileOf(r, r.owner);
    expect(f.headers['content-type']).toBe('video/webm');
    expect(String(f.headers['content-disposition'])).toMatch(/\.webm"$/);
  });

  it('refuses with a code when there is nothing to join, a piece is missing, or the count is not what arrived', async () => {
    const r = await rig();
    expect((await join_(r, r.owner)).json().code).toBe('no_pieces');
    await piece(r, r.owner, 0, A);
    await piece(r, r.owner, 2, C);
    expect((await join_(r, r.owner)).json().code).toBe('missing_piece');
    await piece(r, r.owner, 1, B);
    expect((await join_(r, r.owner, { count: 4 })).json().code).toBe('missing_piece');
    expect((await join_(r, r.owner, { count: 'x' })).json().code).toBe('bad_piece');
    expect(r.calls).toHaveLength(0);
    expect((await join_(r, r.owner, { count: 3 })).statusCode).toBe(200);
  });

  it('a join that fails leaves the pieces in place (join_failed 500), and a later try can succeed', async () => {
    let n = 0;
    const calls: Rig['calls'] = [];
    const flaky: JoinRunner = async (ff, args, t) => (n++ === 0 ? { code: 1, stderr: 'Invalid data found when processing input' } : fakeJoin(calls)(ff, args, t));
    const r = await rig({}, flaky);
    await piece(r, r.owner, 0, A);
    await piece(r, r.owner, 1, B);
    const bad = await join_(r, r.owner);
    expect(bad.statusCode).toBe(500);
    expect(bad.json().code).toBe('join_failed');
    expect(readdirSync(recDir(r)).filter((f) => f.startsWith('piece-'))).toHaveLength(2);
    expect(readdirSync(recDir(r)).some((f) => f.startsWith('joined'))).toBe(false);
    expect((await fileOf(r, r.owner)).json().code).toBe('not_ready');
    expect((await join_(r, r.owner)).statusCode).toBe(200);
  });

  it('refuses no_space when the box would keep too little free after the join', async () => {
    let free = 50 * 1024 ** 3;
    const r = await rig({ liveRecordings: { ffmpegPath: () => 'f', run: fakeJoin(), free: () => free } });
    await piece(r, r.owner, 0, A);
    free = 100 * 1024 * 1024;
    const j = await join_(r, r.owner);
    expect(j.statusCode).toBe(413);
    expect(j.json().code).toBe('no_space');
  });

  it('a piece sent after a good join is refused with already_joined and the joined file survives (the pieces are gone, so it is the only copy)', async () => {
    const r = await rig();
    await piece(r, r.owner, 0, A);
    await join_(r, r.owner);
    const before = await fileOf(r, r.owner);
    expect(before.statusCode).toBe(200);
    const late = await piece(r, r.owner, 1, B);
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe('already_joined');
    const after = await fileOf(r, r.owner);
    expect(after.statusCode).toBe(200);
    expect(after.rawPayload).toEqual(before.rawPayload);
    expect(readdirSync(recDir(r)).some((f) => f.startsWith('joined.'))).toBe(true);
    expect(readdirSync(recDir(r)).filter((f) => f.startsWith('piece-'))).toEqual([]);
  });

  it('join_failed gives a generic message to the caller; the ffmpeg detail (paths) goes to the log only', async () => {
    const logs: string[] = [];
    const bad: JoinRunner = async () => ({ code: 1, stderr: 'C:\\secret\\path\\piece-00000.mp4: Invalid data' });
    const r = await rig({ liveRecordings: { ffmpegPath: () => 'f', run: bad, free: () => 50 * 1024 ** 3, log: (m) => logs.push(m) } });
    await piece(r, r.owner, 0, A);
    const res = await join_(r, r.owner);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ errors: ['join failed'], code: 'join_failed' });
    expect(res.body).not.toContain('secret');
    expect(logs.join('\n')).toContain('secret');
  });
});

describe('the bytes of a piece', () => {
  it('must be the container the type names: text, an ffconcat/HLS file, a webm sent as mp4 and a short body are refused with bad_piece and leave nothing', async () => {
    const r = await rig();
    const cases: Array<[string, Buffer, string]> = [
      ['text', Buffer.from('hello, this is not a video at all'), 'video/mp4'],
      ['ffconcat', Buffer.from("ffconcat version 1.0\nfile 'file:///c:/windows/win.ini'\n"), 'video/mp4'],
      ['hls', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nhttp://127.0.0.1/secret\n'), 'video/webm'],
      ['webm as mp4', webm('xxxxxxxx'), 'video/mp4'],
      ['mp4 as webm', mp4('xxxx'), 'video/webm'],
      ['short', Buffer.from('ftyp'), 'video/mp4'],
    ];
    for (const [name, bytes, type] of cases) {
      const res = await piece(r, r.owner, 0, bytes, type);
      expect(res.statusCode, name).toBe(400);
      expect(res.json().code, name).toBe('bad_piece');
    }
    const left = existsSync(recDir(r)) ? readdirSync(recDir(r)) : [];
    expect(left, left.join(',')).toEqual([]);
    // the real thing is accepted
    expect((await piece(r, r.owner, 0, A)).statusCode).toBe(200);
    expect((await piece(r, r.owner, 1, B, 'audio/mp4')).statusCode).toBe(200);
  });

  it('magicOk reads mp4 ftyp at offset 4 and the webm EBML id', () => {
    expect(magicOk('mp4', mp4(''))).toBe(true);
    expect(magicOk('mp4', Buffer.from('ftypxxxxxxxx'))).toBe(false);
    expect(magicOk('webm', webm(''))).toBe(true);
    expect(magicOk('webm', Buffer.from([0x1a, 0x45, 0xdf]))).toBe(false);
  });

  it('a failed first piece leaves no recording type behind: the retry with another type is accepted, and no meta exists before a piece is stored', async () => {
    const r = await rig();
    const bad = await piece(r, r.owner, 0, Buffer.from('not a video file'), 'video/webm');
    expect(bad.statusCode).toBe(400);
    expect(existsSync(join(recDir(r), 'meta.json'))).toBe(false);
    expect((await piece(r, r.owner, 0, A, 'video/mp4')).statusCode).toBe(200);
    expect(existsSync(join(recDir(r), 'meta.json'))).toBe(true);
  });

  it('a piece file that vanishes between the listing and the stat does not turn into a 500', async () => {
    const r = await rig();
    await piece(r, r.owner, 0, A);
    await piece(r, r.owner, 1, B);
    // a dangling name the listing returns but the stat cannot read (a broken link stands for a file removed in between)
    const ghost = join(recDir(r), 'piece-00002.mp4');
    try {
      symlinkSync(join(recDir(r), 'nowhere'), ghost);
    } catch {
      return; // no symlink right on this machine
    }
    const res = await piece(r, r.owner, 3, C);
    expect(res.statusCode).toBe(200);
  });
});

describe('the upload', () => {
  it('a good upload stays a 200 when the clean-up sweep throws', async () => {
    const r = await rig();
    const spy = vi.spyOn(Recordings.prototype, 'sweep').mockImplementation(() => {
      throw new Error('EPERM');
    });
    try {
      expect((await piece(r, r.owner, 0, A)).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('is cut off (408) when it passes its deadline, and the slot is free again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-recslow-'));
    dirs.push(dir);
    const rec = new Recordings({ dataDir: dir, ffmpegPath: () => null, free: () => null, deadlineMs: 50 });
    const slow = new PassThrough();
    slow.write(mp4('AA'));
    await expect(rec.putPiece('SlowLive001', 'dev', 0, 'video/mp4', 100, slow)).rejects.toMatchObject({ status: 408, code: 'upload_failed' });
    // no stale lock or temp file
    await expect(rec.putPiece('SlowLive001', 'dev', 0, 'video/mp4', 10, Readable.from([A]))).resolves.toMatchObject({ pieces: 1 });
  });

  it('is cut off when it runs under the minimum rate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-recrate-'));
    dirs.push(dir);
    const rec = new Recordings({ dataDir: dir, ffmpegPath: () => null, free: () => null, minRate: { bytesPerSec: 1000, windowMs: 40 }, rateCheckMs: 10, deadlineMs: 5000 });
    const slow = new PassThrough();
    slow.write(mp4('AA'));
    await expect(rec.putPiece('SlowLive002', 'dev', 0, 'video/mp4', 100_000, slow)).rejects.toMatchObject({ status: 408 });
  });

  it('at most two piece uploads run at once on the box; a third is told busy, and one finishing frees a place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-reccap-'));
    dirs.push(dir);
    const rec = new Recordings({ dataDir: dir, ffmpegPath: () => null, free: () => null });
    const s1 = new PassThrough();
    const s2 = new PassThrough();
    const p1 = rec.putPiece('CapLive0001', 'dev', 0, 'video/mp4', 10, s1);
    const p2 = rec.putPiece('CapLive0002', 'dev', 0, 'video/mp4', 10, s2);
    await expect(rec.putPiece('CapLive0003', 'dev', 0, 'video/mp4', 10, Readable.from([A]))).rejects.toMatchObject({ status: 409, code: 'busy' });
    s1.end(A);
    await p1;
    await expect(rec.putPiece('CapLive0003', 'dev', 0, 'video/mp4', 10, Readable.from([A]))).resolves.toMatchObject({ pieces: 1 });
    s2.end(A);
    await p2;
  });
});

describe('cleanup', () => {
  it('the app confirming it saved the file removes pieces and file; asking twice is harmless', async () => {
    const r = await rig();
    await piece(r, r.owner, 0, A);
    await join_(r, r.owner);
    const del = await r.app.inject({ method: 'DELETE', url: `/api/live/recordings/${LIVE}`, headers: r.owner.headers });
    expect(del.json()).toEqual({ removed: true });
    expect(existsSync(recDir(r))).toBe(false);
    expect((await r.app.inject({ method: 'DELETE', url: `/api/live/recordings/${LIVE}`, headers: r.owner.headers })).json()).toEqual({ removed: false });
  });

  it('a recording nobody saved is removed after 7 days (swept), a younger one stays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-recsweep-'));
    dirs.push(dir);
    let t = Date.parse('2026-11-21T10:00:00Z');
    const rec = new Recordings({ dataDir: dir, ffmpegPath: () => null, now: () => new Date(t), free: () => null });
    const put = (id: string) => rec.putPiece(id, 'dev', 0, 'video/mp4', 8, (async function* () { yield mp4(''); })() as unknown as NodeJS.ReadableStream);
    return (async () => {
      await put('OldLive0001');
      t += 6 * 24 * 3600_000;
      await put('NewLive0002');
      t += 24 * 3600_000 + 60_000; // the first is now just over 7 days old
      expect(rec.sweep()).toEqual(['OldLive0001']);
      expect(existsSync(join(dir, 'live-recordings', 'OldLive0001'))).toBe(false);
      expect(existsSync(join(dir, 'live-recordings', 'NewLive0002'))).toBe(true);
      t += 8 * 24 * 3600_000;
      expect(rec.sweep()).toEqual(['NewLive0002']);
    })();
  });
});

describe('helpers', () => {
  it('the concat list quotes a path with a single quote and uses forward slashes; the join args copy and never re-encode', () => {
    expect(concatList(["it's.mp4", 'piece-00001.mp4'])).toBe("file 'it'\\''s.mp4'\nfile 'piece-00001.mp4'\n");
    const a = joinArgs('l.txt', 'o.mp4');
    expect(a.slice(a.indexOf('-c'), a.indexOf('-c') + 2)).toEqual(['-c', 'copy']);
    expect(a).not.toContain('-vf');
  });
});

/** Real ffmpeg, when the machine has one: two tiny generated clips come out as one clip of the summed length. */
const ffmpeg = (() => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() : '';
})();

describe.runIf(ffmpeg !== '')('with the real ffmpeg', () => {
  const clip = (file: string): void => {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-y', file]);
    expect(r.status, String(r.stderr)).toBe(0);
  };
  const seconds = (file: string): number => {
    const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
    const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr);
    return m === null ? NaN : Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  };

  it('joins two clips into one whose length is the sum, without re-encoding', async () => {
    const work = mkdtempSync(join(tmpdir(), 'surau-recreal-'));
    dirs.push(work);
    clip(join(work, 'a.mp4'));
    clip(join(work, 'b.mp4'));
    const r = await rig({ liveRecordings: { ffmpegPath: () => ffmpeg, free: () => 50 * 1024 ** 3 } });
    expect((await piece(r, r.owner, 0, readFileSync(join(work, 'a.mp4')))).statusCode).toBe(200);
    expect((await piece(r, r.owner, 1, readFileSync(join(work, 'b.mp4')))).statusCode).toBe(200);
    const j = await join_(r, r.owner, { count: 2 });
    expect(j.statusCode, j.body).toBe(200);
    const f = await fileOf(r, r.owner);
    expect(f.statusCode).toBe(200);
    const out = join(work, 'out.mp4');
    writeFileSync(out, f.rawPayload);
    expect(seconds(out)).toBeGreaterThan(1.8);
    expect(seconds(out)).toBeLessThan(2.3);
    expect(seconds(join(work, 'a.mp4'))).toBeLessThan(1.3);
  });

  it('joins two webm clips with the whitelists in place (the format whitelist lets matroska/webm through)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'surau-recreal-'));
    dirs.push(work);
    const mk = (file: string): number =>
      spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', '-y', file]).status ?? 1;
    if (mk(join(work, 'a.webm')) !== 0 || mk(join(work, 'b.webm')) !== 0) return; // this ffmpeg has no vp8/opus encoder
    const r = await rig({ liveRecordings: { ffmpegPath: () => ffmpeg, free: () => 50 * 1024 ** 3 } });
    expect((await piece(r, r.owner, 0, readFileSync(join(work, 'a.webm')), 'video/webm')).statusCode).toBe(200);
    expect((await piece(r, r.owner, 1, readFileSync(join(work, 'b.webm')), 'video/webm')).statusCode).toBe(200);
    const j = await join_(r, r.owner, { count: 2 });
    expect(j.statusCode, j.body).toBe(200);
    const out = join(work, 'out.webm');
    writeFileSync(out, (await fileOf(r, r.owner)).rawPayload);
    expect(seconds(out)).toBeGreaterThan(1.8);
  });
});
