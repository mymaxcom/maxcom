import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FEATURES, OP_MESSAGE_PREFIX, canonicalJson, decide, isoInstantMs, newRev, opDigest, opMessage, sha256Hex,
  validateFeatureSettings, resolveSettings,
} from '../src/index.ts';
import type { MergeInput, SyncOp } from '../src/index.ts';

interface Vectors {
  canonical: { name: string; inputJson: string; canonical: string; sha256Hex: string }[];
  merge: { name: string; input: MergeInput; apply: boolean; reason: string }[];
  ops: { name: string; op: SyncOp; canonicalWithoutSig: string; digest: string; messageText: string; messageHex: string }[];
}
const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/sync-vectors.json', import.meta.url), 'utf8'),
) as Vectors;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('sync vectors', () => {
  it('pins eleven inputs', () => {
    expect(vectors.canonical.length + vectors.ops.length).toBe(11);
  });
  for (const v of vectors.canonical) {
    it(`canonical: ${v.name}`, () => {
      const c = canonicalJson(JSON.parse(v.inputJson));
      expect(c).toBe(v.canonical);
      expect(sha256Hex(utf8(c))).toBe(v.sha256Hex);
      expect(createHash('sha256').update(c, 'utf8').digest('hex')).toBe(v.sha256Hex);
    });
  }
  for (const v of vectors.ops) {
    it(`${v.name}: canonical, digest and message`, () => {
      const { sig: _sig, ...rest } = v.op;
      expect(canonicalJson(rest)).toBe(v.canonicalWithoutSig);
      expect(opDigest(rest)).toBe(v.digest);
      expect(opDigest(v.op)).toBe(v.digest); // a sig on the input is ignored
      expect(hex(opMessage(rest))).toBe(v.messageHex);
      expect(new TextDecoder().decode(opMessage(rest))).toBe(v.messageText);
      expect(v.messageText).toBe(['surau-op', v.op.boxId, v.op.deviceId, v.op.opId, v.digest].join('\n'));
    });
  }
});

describe('canonicalJson', () => {
  it('sorts keys, drops undefined, keeps array order', () => {
    expect(canonicalJson({ b: 1, a: undefined, c: [3, undefined, 1] })).toBe('{"b":1,"c":[3,null,1]}');
  });
  it('writes -0 as 0 and large numbers like JS', () => {
    expect(canonicalJson([-0, 1e21])).toBe('[0,1e+21]');
  });
  it('orders keys by UTF-16 code units', () => {
    expect(canonicalJson({ '￮': 1, '😀': 2 })).toBe('{"😀":2,"￮":1}');
  });
  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
  });
});

describe('sha256Hex', () => {
  it('matches Node crypto across padding boundaries', () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const b = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      expect(sha256Hex(b)).toBe(createHash('sha256').update(b).digest('hex'));
    }
  });
});

describe('opMessage', () => {
  const op = vectors.ops[0]!.op;
  const { sig: _s, ...rest } = op;
  it('starts with its own prefix, a family apart from the Worker and unlock messages', () => {
    expect(OP_MESSAGE_PREFIX).toBe('surau-op');
    const text = new TextDecoder().decode(opMessage(rest));
    expect(text.startsWith('surau-op\n')).toBe(true);
    for (const other of ['maxcom-wake-dev', 'maxcom-wake-box', 'maxcom-dirty-get', 'maxcom-dirty-clear', 'surau-wake', 'surau-unlock']) {
      expect(text.startsWith(`${other}\n`)).toBe(false);
      expect(text.split('\n')[0]).not.toBe(other);
    }
  });
  it('changes with any field of the op', () => {
    const a = hex(opMessage(rest));
    expect(hex(opMessage({ ...rest, editedAt: '2026-11-05T10:15:30.251Z' }))).not.toBe(a);
    expect(hex(opMessage({ ...rest, payload: null }))).not.toBe(a);
    expect(hex(opMessage({ ...rest, deviceId: 'dev-9g' }))).not.toBe(a);
  });
});

describe('decide', () => {
  const cur = { rev: 'r', editedAt: '2026-11-05T10:00:00.000Z', deviceId: 'dev-m', deletedAt: null as string | null };
  const at = (editedAt: string, deviceId = 'dev-m') => ({ editedAt, deviceId });
  const LATER = '2026-11-05T10:00:01.000Z';
  const EARLIER = '2026-11-05T09:59:59.000Z';
  const DEL = '2026-11-05T10:00:05.000Z';
  const cases: [string, MergeInput, boolean, string][] = [
    ['no current row', { kind: 'content.put', current: null, op: at(LATER) }, true, 'new'],
    ['delete with no current row', { kind: 'content.delete', current: null, op: at(EARLIER) }, true, 'new'],
    ['newer put', { kind: 'content.put', current: cur, op: at(LATER) }, true, 'newer'],
    ['older put', { kind: 'content.put', current: cur, op: at(EARLIER) }, false, 'older'],
    ['tie, greater device id wins', { kind: 'settings.put', current: cur, op: at(cur.editedAt, 'dev-z') }, true, 'tie_won'],
    ['tie, lesser device id loses', { kind: 'settings.put', current: cur, op: at(cur.editedAt, 'dev-a') }, false, 'tie_lost'],
    ['tie, same device loses', { kind: 'user.put', current: cur, op: at(cur.editedAt) }, false, 'tie_lost'],
    ['tie against a row with no device', { kind: 'content.put', current: { ...cur, deviceId: null }, op: at(cur.editedAt, 'dev-a') }, true, 'tie_won'],
    ['an older delete loses to a newer put', { kind: 'content.delete', current: cur, op: at(EARLIER) }, false, 'older'],
    ['a newer delete wins', { kind: 'content.delete', current: cur, op: at(LATER) }, true, 'newer'],
    ['a same-instant delete from the greater device wins', { kind: 'content.delete', current: cur, op: at(cur.editedAt, 'dev-z') }, true, 'tie_won'],
    ['a same-instant delete from the lesser device loses', { kind: 'content.delete', current: cur, op: at(cur.editedAt, 'dev-a') }, false, 'tie_lost'],
    ['on the very same stamp a delete beats a put', { kind: 'content.delete', current: cur, op: at(cur.editedAt) }, true, 'tie_won'],
    ['on the very same stamp a put does not beat a tombstone', { kind: 'content.put', current: { ...cur, deletedAt: cur.editedAt }, op: at(cur.editedAt) }, false, 'tombstoned'],
    ['an older delete leaves the tombstone', { kind: 'content.delete', current: { ...cur, editedAt: DEL, deletedAt: DEL }, op: at(LATER) }, false, 'tombstoned'],
    ['a newer delete replaces the tombstone', { kind: 'content.delete', current: { ...cur, deletedAt: EARLIER }, op: at(LATER) }, true, 'newer'],
    ['put after the delete is an undelete', { kind: 'content.put', current: { ...cur, editedAt: DEL, deletedAt: DEL }, op: at('2026-11-05T10:00:06.000Z') }, true, 'newer'],
    ['put before the delete stays deleted', { kind: 'content.put', current: { ...cur, editedAt: DEL, deletedAt: DEL }, op: at('2026-11-05T10:00:04.000Z') }, false, 'tombstoned'],
    ['put at the instant of the delete: the device rule decides', { kind: 'content.put', current: { ...cur, editedAt: DEL, deletedAt: DEL }, op: at(DEL, 'dev-z') }, true, 'tie_won'],
    ['revoke lands', { kind: 'device.revoke', current: { ...cur, revokedAt: null }, op: at(EARLIER) }, true, 'newer'],
    ['revoke twice', { kind: 'device.revoke', current: { ...cur, revokedAt: EARLIER }, op: at(LATER) }, false, 'already_revoked'],
  ];
  for (const [name, input, apply, reason] of cases) {
    it(name, () => {
      expect(decide(input)).toEqual({ apply, reason });
    });
  }
  it('covers every reason', () => {
    expect(new Set(cases.map((c) => c[3]))).toEqual(
      new Set(['new', 'newer', 'older', 'tie_lost', 'tie_won', 'tombstoned', 'already_revoked']),
    );
  });
  it('the shared vectors hold', () => {
    expect(vectors.merge.length).toBeGreaterThanOrEqual(20);
    for (const v of vectors.merge) expect({ name: v.name, ...decide(v.input) }).toEqual({ name: v.name, apply: v.apply, reason: v.reason });
  });
  it('newRev is sortable and readable', () => {
    expect(newRev('2026-11-05T10:00:00.000Z', 'dev-m')).toBe('2026-11-05T10:00:00.000Z|dev-m');
  });
});

describe('cloud features', () => {
  const byKey = (k: string) => FEATURES.find((f) => f.key === k)!;
  it('registry has 53 features in 11 groups', () => {
    expect(FEATURES).toHaveLength(53);
    expect(new Set(FEATURES.map((f) => f.group)).size).toBe(11);
    expect(byKey('cloudSync').group).toBe('lanjutan');
    expect(byKey('youtubeCatchUp').group).toBe('awan');
  });
  it('cloudSync is on by default and not locked; no fixed polling', () => {
    const f = byKey('cloudSync');
    expect(f.defaultEnabled).toBe(true);
    expect(f.locked).toBe(false);
    expect(f.defaults).toEqual({ dirtyCheckSeconds: 120, cloudUrl: '' });
    expect('pollSeconds' in f.defaults).toBe(false);
  });
  it('youtubeCatchUp defaults', () => {
    expect(byKey('youtubeCatchUp').defaults).toEqual({ wifiOnly: true, joinSegments: true, replaceGappyLive: 'ask' });
    expect(byKey('youtubeCatchUp').defaultEnabled).toBe(true);
  });
  it('dirtyCheckSeconds is 60..900', () => {
    for (const v of [59, 901, 120.5, '120']) expect(validateFeatureSettings('cloudSync', { dirtyCheckSeconds: v }).ok).toBe(false);
    for (const v of [60, 120, 900]) expect(validateFeatureSettings('cloudSync', { dirtyCheckSeconds: v }).ok).toBe(true);
  });
  it('pollSeconds is gone', () => {
    expect(validateFeatureSettings('cloudSync', { pollSeconds: 60 }).ok).toBe(false);
  });
  it('cloudUrl is empty or https, at most 200 characters', () => {
    const ok = (u: string) => validateFeatureSettings('cloudSync', { cloudUrl: u }).ok;
    expect(ok('')).toBe(true);
    expect(ok('https://cloud.example.my')).toBe(true);
    expect(ok('http://x')).toBe(false);
    expect(ok('https://')).toBe(false);
    expect(ok('ftp://x.my')).toBe(false);
    expect(ok('https://a b.my')).toBe(false);
    expect(ok('https://' + 'a'.repeat(192))).toBe(true);
    expect(ok('https://' + 'a'.repeat(193))).toBe(false);
  });
  it('recordingCleanup defaults: on, keep 1 day, group awan, not locked', () => {
    const f = byKey('recordingCleanup');
    expect(f.group).toBe('awan');
    expect(f.locked).toBe(false);
    expect(f.defaultEnabled).toBe(true);
    expect(f.defaults).toEqual({ keepDays: 1 });
    expect(f.labelMs).toBe('Pembersihan rakaman');
  });
  it('recordingCleanup keepDays is one of 0, 1, 3, 7, 30', () => {
    const ok = (v: unknown) => validateFeatureSettings('recordingCleanup', { keepDays: v }).ok;
    for (const v of [0, 1, 3, 7, 30]) expect(ok(v)).toBe(true);
    for (const v of [-1, 2, 4, 14, 31, 1.5, '1', null]) expect(ok(v)).toBe(false);
    expect(validateFeatureSettings('recordingCleanup', { enabled: false }).ok).toBe(true);
  });
  it('youtubeCatchUp settings are checked', () => {
    expect(validateFeatureSettings('youtubeCatchUp', { replaceGappyLive: 'maybe' }).ok).toBe(false);
    for (const v of ['ask', 'never', 'always']) expect(validateFeatureSettings('youtubeCatchUp', { replaceGappyLive: v }).ok).toBe(true);
    expect(validateFeatureSettings('youtubeCatchUp', { wifiOnly: 'yes' }).ok).toBe(false);
  });
  it('resolveSettings falls back from a bad stored value', () => {
    const s = resolveSettings({ cloudSync: { dirtyCheckSeconds: 5, cloudUrl: 'http://x' } as never });
    expect(s.cloudSync.dirtyCheckSeconds).toBe(120);
    expect(s.cloudSync.cloudUrl).toBe('');
  });
});

describe('decide is order-independent', () => {
  // The row an entity ends as: whose edit it holds and whether it is a tombstone.
  type Row = { editedAt: string; deviceId: string; deleted: boolean } | null;
  type Edit = { kind: 'content.put' | 'content.delete'; editedAt: string; deviceId: string };
  const T = ['2026-11-05T10:00:00.000Z', '2026-11-05T10:00:05.000Z', '2026-11-05T10:00:10.000Z'];
  const D = ['dev-a', 'dev-m'];
  const edits: Edit[] = [];
  for (const kind of ['content.put', 'content.delete'] as const) for (const t of T) for (const d of D) edits.push({ kind, editedAt: t, deviceId: d });

  const apply = (row: Row, e: Edit): Row => {
    const current = row === null ? null : {
      rev: newRev(row.editedAt, row.deviceId), editedAt: row.editedAt, deviceId: row.deviceId, deletedAt: row.deleted ? row.editedAt : null,
    };
    const v = decide({ kind: e.kind, current, op: { editedAt: e.editedAt, deviceId: e.deviceId } });
    return v.apply ? { editedAt: e.editedAt, deviceId: e.deviceId, deleted: e.kind === 'content.delete' } : row;
  };

  it('any two edits, either order, leave the same row (put/delete, before/equal/after, both devices)', () => {
    for (const a of edits) for (const b of edits) {
      expect(apply(apply(null, a), b), `${JSON.stringify(a)} then ${JSON.stringify(b)}`).toEqual(apply(apply(null, b), a));
    }
  });
  it('three edits in any order converge', () => {
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const a of edits) for (const b of edits) for (const c of edits) {
      const trio = [a, b, c];
      const ends = orders.map((o) => JSON.stringify(o.reduce<Row>((row, i) => apply(row, trio[i]!), null)));
      expect(new Set(ends).size, JSON.stringify(trio)).toBe(1);
    }
  });
  it('a later put survives an older delete in either order, and reports the delete as lost', () => {
    const put: Edit = { kind: 'content.put', editedAt: T[2]!, deviceId: 'dev-a' };
    const del: Edit = { kind: 'content.delete', editedAt: T[0]!, deviceId: 'dev-m' };
    expect(apply(apply(null, del), put)).toMatchObject({ deleted: false });
    expect(apply(apply(null, put), del)).toMatchObject({ deleted: false });
    const live = { rev: 'r', editedAt: T[2]!, deviceId: 'dev-a', deletedAt: null };
    expect(decide({ kind: 'content.delete', current: live, op: { editedAt: T[0]!, deviceId: 'dev-m' } })).toEqual({ apply: false, reason: 'older' });
  });
  it('device.revoke stays monotonic', () => {
    const cur = { rev: 'r', editedAt: T[2]!, deviceId: 'dev-a', deletedAt: null, revokedAt: null as string | null };
    expect(decide({ kind: 'device.revoke', current: cur, op: { editedAt: T[0]!, deviceId: 'dev-a' } }).apply).toBe(true);
    expect(decide({ kind: 'device.revoke', current: { ...cur, revokedAt: T[0]! }, op: { editedAt: T[2]!, deviceId: 'dev-z' } }).apply).toBe(false);
  });
});

describe('isoInstantMs', () => {
  it('accepts ISO instants with a zone and nothing else', () => {
    expect(isoInstantMs('2026-11-05T10:00:00.000Z')).toBe(Date.parse('2026-11-05T10:00:00.000Z'));
    expect(isoInstantMs('2026-11-05T10:00:00+08:00')).toBe(Date.parse('2026-11-05T02:00:00Z'));
    for (const bad of ['zzzz', '', '2026-11-05', '2026-11-05T10:00:00', 'Nov 5 2026', '2026-13-45T10:00:00Z', 5, null, undefined, 'x'.repeat(41)]) {
      expect(isoInstantMs(bad), String(bad)).toBeNull();
    }
  });
});
