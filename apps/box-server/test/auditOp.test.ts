import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { applyOp } from '../src/sync/apply.ts';
import type { ApplyCtx, VerifiedOp } from '../src/sync/apply.ts';
import { readFeed } from '../src/sync/feed.ts';
import { OP_PERMISSIONS } from '../src/sync/verify.ts';

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date('2026-11-06T10:00:00.000Z');
let n = 0;
function op(over: Partial<VerifiedOp> = {}): VerifiedOp {
  n += 1;
  return {
    v: 1,
    opId: `AUD${String(n).padStart(23, '0')}`,
    surauId: 'sdm',
    boxId: 'box1',
    deviceId: 'dev-a',
    userId: 'u1',
    kind: 'audit.put',
    entity: 'audit',
    entityId: 'sess-1',
    baseRev: null,
    editedAt: '2026-11-06T09:00:00.000Z',
    payload: { event: 'recording/deleted', sessionId: 'sess-1', videoIds: ['abc123XYZ_-'], bytes: 1234 },
    sig: 'x',
    userName: 'Ali',
    ...over,
  };
}
function rig(): { db: DatabaseSync; ctx: ApplyCtx } {
  const dir = mkdtempSync(join(tmpdir(), 'surau-audit-'));
  dirs.push(dir);
  const db = openDb(join(dir, 't.db'));
  dbs.push(db);
  return { db, ctx: { now: NOW, origin: 'app', actor: 'user:u1', dataDir: dir } };
}
const rows = (db: DatabaseSync) => db.prepare("SELECT * FROM change_log WHERE entity = 'recording/deleted'").all();

describe('audit.put (a device writes an audit row)', () => {
  it('needs live:control', () => {
    expect(OP_PERMISSIONS['audit.put']).toEqual(['live:control']);
  });

  it('writes one change_log row with ids and bytes only, stamped as an app write', () => {
    const { db, ctx } = rig();
    const o = op();
    const r = applyOp(db, o, ctx);
    expect(r.status).toBe('applied');
    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ actor: 'user:u1', entity_id: 'sess-1', op_id: o.opId, origin: 'app', device_id: 'dev-a' });
    expect(JSON.parse(String(all[0]!.after_json))).toEqual({ sessionId: 'sess-1', videoIds: ['abc123XYZ_-'], bytes: 1234 });
  });

  it('the same op twice is a duplicate and writes nothing more', () => {
    const { db, ctx } = rig();
    const o = op();
    applyOp(db, o, ctx);
    expect(applyOp(db, o, ctx).status).toBe('duplicate');
    expect(rows(db)).toHaveLength(1);
  });

  it('refuses a wrong entity, a bad event, bad ids, a negative or fractional size, too many videos, extra keys', () => {
    const { db, ctx } = rig();
    const bad: Array<Partial<VerifiedOp>> = [
      { entity: 'settings' },
      { payload: null },
      { payload: [] },
      { payload: { event: 'recording/other', sessionId: 's', videoIds: [], bytes: 1 } },
      { payload: { event: 'recording/deleted', sessionId: '../x', videoIds: [], bytes: 1 } },
      { payload: { event: 'recording/deleted', sessionId: 's', videoIds: ['a b'], bytes: 1 } },
      { payload: { event: 'recording/deleted', sessionId: 's', videoIds: 'abc', bytes: 1 } },
      { payload: { event: 'recording/deleted', sessionId: 's', videoIds: Array.from({ length: 51 }, (_, i) => `v${i}`), bytes: 1 } },
      { payload: { event: 'recording/deleted', sessionId: 's', videoIds: [], bytes: -1 } },
      { payload: { event: 'recording/deleted', sessionId: 's', videoIds: [], bytes: 1.5 } },
      { payload: { event: 'recording/deleted', sessionId: 's', videoIds: [], bytes: 1, uri: 'content://x' } },
    ];
    for (const b of bad) {
      const r = applyOp(db, op(b), ctx);
      expect(r.status, JSON.stringify(b)).toBe('refused');
    }
    expect(rows(db)).toHaveLength(0);
  });

  it('gate 2: one device writes at most 200 audit notes a day; the 201st is refused too_many', () => {
    const { db, ctx } = rig();
    for (let i = 0; i < 200; i++) expect(applyOp(db, op(), ctx).status).toBe('applied');
    const over = applyOp(db, op(), ctx);
    expect(over).toMatchObject({ status: 'refused', reason: 'too_many' });
    expect(rows(db)).toHaveLength(200);
    // another device is not held back, and the same device is let in again a day later
    expect(applyOp(db, op({ deviceId: 'dev-b' }), ctx).status).toBe('applied');
    const later = { ...ctx, now: new Date(NOW.getTime() + 25 * 3_600_000) };
    expect(applyOp(db, op(), later).status).toBe('applied');
  });

  it('never travels in the feed (a box does not replicate it)', () => {
    const { db, ctx } = rig();
    applyOp(db, op(), ctx);
    const feed = readFeed(db, 0, 500, { users: true, devices: true });
    expect(feed.entries.filter((e) => e.entity.includes('recording') || e.entity.includes('audit'))).toHaveLength(0);
  });
});
