import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/auth/ratelimit.ts';
import { applyUnlinkNote, readUnlinkNote, writeUnlinkNote } from '../src/follow/unlinkNote.ts';
import type { UnlinkNote } from '../src/follow/unlinkNote.ts';
import { writeJournal } from '../src/link/journal.ts';
import { backupDirOf, writeManifest } from '../src/link/setAside.ts';
import { UnlinkError, dropKept, readKeptNote, switchKept, writeKeptNote } from '../src/link/unlink.ts';
import { loadIdentity } from '../src/setup/identity.ts';
import { loginAs } from './authHelpers.ts';
import { createXWorld, PIN } from './support/caseXWorld.ts';
import type { XWorld } from './support/caseXWorld.ts';

/* Gate fixes (multi-box I2): the link PIN limit, stale unlink notes, the kept-data switch and drop. */

let w: XWorld;
beforeEach(() => {
  w = createXWorld();
});
afterEach(async () => {
  await w.close();
});

describe('S2: the link PIN limit cannot be passed by guesses sent side by side', () => {
  it('eight wrong PINs at once: at most five are compared, the rest answer 429', async () => {
    const m = await w.make(1);
    const admin = await loginAs(m.app, 'admin');
    const res = await Promise.all(Array.from({ length: 8 }, () => m.call('POST', '/api/link/pin', { pin: '000000' }, { as: admin })));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(3);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
    // blocked now even with the right PIN (nothing is learnt about a guess)
    expect((await m.call('POST', '/api/link/pin', { pin: PIN }, { as: admin })).status).toBe(429);
  });

  it('a right PIN never counts: ten in a row all pass', async () => {
    const m = await w.make(1);
    // the PIN check passes each time (what follows it, a link step, may refuse for its own reason, never 401 / 429)
    for (let i = 0; i < 10; i++) expect([401, 429]).not.toContain((await m.call('POST', '/api/link/pin', { pin: PIN })).status);
  });

  it('release gives back the newest slot only', () => {
    let t = 0;
    const lim = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    expect(lim.hit('a').ok).toBe(true);
    lim.release!('a');
    t = 1;
    expect(lim.hit('a').ok).toBe(true);
    expect(lim.hit('a').ok).toBe(true);
    expect(lim.hit('a').ok).toBe(false);
  });
});

describe('Q4: an unlink note whose join code ran out makes nobody Pentadbir', () => {
  it('expired: not applied, removed; fresh: applied', async () => {
    const f = await w.make(2);
    const id = loadIdentity(f.dir);
    const base: UnlinkNote = {
      v: 1, unlinkId: 'a'.repeat(32), linkId: 'b'.repeat(32), choice: 'back',
      person: { peerUserId: null, name: 'Encik Hamid', phone: null }, ticketHash: 'c'.repeat(64),
      ticketExpiresAt: new Date(w.clock.now().getTime() - 60_000).toISOString(), dropYoutube: false,
      master: { boxId: '1'.repeat(16), name: 'Dewan Utama', pub: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as never, ca: 'd'.repeat(64), addresses: [] },
      applied: false, userId: null, copied: true,
    };
    const db = f.app.surau.db;
    const before = Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Encik Hamid'").get()?.n);
    writeUnlinkNote(f.dir, id, f.boxId, base);
    expect(applyUnlinkNote(db, f.dir, id, f.boxId, 'sdm', w.clock.now())).toBeNull();
    expect(readUnlinkNote(f.dir, id, f.boxId)).toBeNull();
    expect(Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Encik Hamid'").get()?.n)).toBe(before);
    writeUnlinkNote(f.dir, id, f.boxId, { ...base, ticketExpiresAt: new Date(w.clock.now().getTime() + 600_000).toISOString() });
    expect(applyUnlinkNote(db, f.dir, id, f.boxId, 'sdm', w.clock.now())).not.toBeNull();
  });
});

describe('Q6 / Q10: the kept data is never left outside its note', () => {
  const LINK = 'e'.repeat(32);
  const seedBack = (dir: string): void => {
    const kept = backupDirOf(dir, `${LINK}-at-unlink`);
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, 'surau.db'), 'x');
    writeManifest(kept, { v: 1, kind: 'at-unlink', linkId: LINK, at: new Date().toISOString(), release: 't', dbLevel: 1, files: [], bytes: 1 });
    writeKeptNote(dir, {
      v: 1, linkId: LINK, side: 'master', chosen: 'back', folder: `${LINK}-at-unlink`, keptUntil: new Date(Date.now() + 86_400_000).toISOString(),
      followerName: 'Ruang Muslimat', masterName: 'Dewan Utama', finishedAt: new Date().toISOString(), outcome: 'done', unlinkId: '9'.repeat(32),
    });
  };

  it('a switch while another move is open renames nothing', async () => {
    const m = await w.make(1);
    seedBack(m.dir);
    writeJournal(m.dir, { v: 1, op: 'forget', linkId: 'f'.repeat(32), step: 'planned', at: new Date().toISOString() });
    expect(() => switchKept(m.dir, 'master', new Date())).toThrow(UnlinkError);
    expect(existsSync(backupDirOf(m.dir, `${LINK}-at-unlink`))).toBe(true);
    expect(existsSync(backupDirOf(m.dir, LINK))).toBe(false);
    expect(readKeptNote(m.dir)?.folder).toBe(`${LINK}-at-unlink`);
  });

  it('a drop whose delete fails keeps the note', async () => {
    const m = await w.make(1);
    seedBack(m.dir);
    // the journal is open: the drop refuses and nothing is cleared
    writeJournal(m.dir, { v: 1, op: 'forget', linkId: 'f'.repeat(32), step: 'planned', at: new Date().toISOString() });
    expect(() => dropKept(m.dir, 'master')).toThrow();
    expect(readKeptNote(m.dir)).not.toBeNull();
    expect(readdirSync(join(m.dir, 'linkundo'))).toContain(`${LINK}-at-unlink`);
  });
});
