import { cpSync, existsSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../src/auth/crypto.ts';
import { openDb } from '../src/db.ts';
import { adoptStore, carryOf, commitAdopt, dropAdoptPlan, planAdopt, RECOVERY_NOTE_REL, sweepAdoptLeftovers, takeRecoveryNote } from '../src/link/adopt.ts';
import { backupOf, CLOUD_RESET_REL } from '../src/link/setAside.ts';
import { stageDirOf } from '../src/link/storeMove.ts';
import { TokenStore } from '../src/live/youtube/tokenStore.ts';
import { CameraStore } from '../src/live/camera.ts';
import { verifyRecoveryCode } from '../src/setup/codes.ts';
import { loadIdentity } from '../src/setup/identity.ts';
import {
  boot, boxIdOf, buildRig, cloneM, count, dumpDb, endState, filesOf, G_MEDIA_FILES, G_NAMES, LINK, NOW, oneOf, personId, removeTempDirs, rowsOf, tempDir,
} from './support/adoptRig.ts';
import type { Rig } from './support/adoptRig.ts';

/**
 * The adopt of a foreign store at the box that becomes the master (cases X and N-X), at table and boot level: real
 * temp folders, real `node:sqlite` databases, the real start-up journal step. The table under test is
 * `docs/design/plans/2026-11-23-adopt-store-table.md`.
 */

const opened: ReturnType<typeof dbOf>[] = [];
afterEach(() => {
  for (const d of opened.splice(0)) {
    try {
      d.close();
    } catch {
      // closed by the test itself
    }
  }
});
afterAll(() => removeTempDirs());

const parse = (lines: string[]): Record<string, unknown>[] => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
function dbOf(dir: string) {
  return openDb(join(dir, 'surau.db'));
}

/** One adopted M: the folder after a clean start, and the open database to ask it things. */
async function adopted(o: Parameters<typeof buildRig>[0] = {}): Promise<{ rig: Rig; dir: string; db: ReturnType<typeof dbOf> }> {
  const rig = await buildRig(o);
  const dir = cloneM(rig);
  expect(boot(dir, rig)).toBe('adopt');
  const db = dbOf(dir);
  opened.push(db);
  return { rig, dir, db };
}

const YT = { refreshToken: 'refresh-token-of-g', accessToken: 'access-of-g', expiresAt: 4_102_444_800_000, channelId: 'UC-surau', channelTitle: 'Surau Al-Hidayah', scope: 'youtube', streamId: 'stream-1' };

describe('adoptKillEveryStep: a power cut at any step ends in the same place as a clean start', () => {
  it('every step name reported by a clean run, killed there, then started again, gives the clean end state (case X, cloud-linked M)', async () => {
    const rig = await buildRig({ mLinked: true, youtube: YT, camera: { url: 'rtsp://10.168.50.40:554/stream1', username: 'admin', password: 'x' } });
    const cleanDir = cloneM(rig);
    const steps: string[] = [];
    expect(boot(cleanDir, rig, (n) => steps.push(n))).toBe('adopt');
    expect(steps).toEqual(expect.arrayContaining(['adopt:start', 'adopt:aside-done', 'adopt:swap-done', 'adopt:applied', 'adopt:marked', 'adopt:cleared']));
    expect(steps.length).toBeGreaterThanOrEqual(10);
    const clean = endState(cleanDir, rig);
    // sanity: the clean end state is the adopted one
    expect(clean.recovery).toBe(rig.recovery.code);
    expect(clean.youtube?.refreshToken).toBe(YT.refreshToken);
    expect(clean.files[CLOUD_RESET_REL]).toBeDefined();
    expect(clean.files['link.json']).toBeUndefined();
    expect(clean.files['link-adopt.json']).toBeUndefined();

    for (let k = 0; k < steps.length; k++) {
      const dir = cloneM(rig);
      let n = 0;
      let cut: unknown = null;
      try {
        boot(dir, rig, () => {
          if (n++ === k) throw new Error(`power cut at ${steps[k]}`);
        });
      } catch (e) {
        cut = e;
      }
      expect(cut, `kill ${k} (${steps[k]}) must stop the start`).toBeInstanceOf(Error);
      // the box starts again (as many times as it takes: here once more is enough, a third start must change nothing)
      const second = boot(dir, rig);
      expect(['adopt', 'none'], `after kill ${k} (${steps[k]})`).toContain(second);
      expect(boot(dir, rig)).toBe('none');
      expect(endState(dir, rig), `kill at step ${k} (${steps[k]})`).toEqual(clean);
    }
  }, 120_000);

  it('a power cut in the middle of a second cut (killed twice in a row) still ends in the clean end state', async () => {
    const rig = await buildRig({ mLinked: true });
    const cleanDir = cloneM(rig);
    const steps: string[] = [];
    boot(cleanDir, rig, (n) => steps.push(n));
    const clean = endState(cleanDir, rig);
    const dir = cloneM(rig);
    // cut at the second step, then again at the fourth step of what is left, then let it finish
    for (const k of [1, 3]) {
      let n = 0;
      expect(() => boot(dir, rig, () => {
        if (n++ === k) throw new Error('power cut');
      })).toThrow('power cut');
    }
    boot(dir, rig);
    expect(endState(dir, rig)).toEqual(clean);
  }, 60_000);

  it.each([
    ['a listed file is missing', (stage: string) => rmSync(join(stage, 'assets', 'poster-1.jpg'))],
    ['a listed file has the wrong size', (stage: string) => truncateSync(join(stage, 'assets', 'sub', 'video-1.mp4'), 100)],
    ['the database copy is missing', (stage: string) => rmSync(join(stage, 'surau.db'))],
    ['a listed file is longer than listed', (stage: string) => writeFileSync(join(stage, 'themes', 'hijau', 'theme.json'), 'x'.repeat(5000))],
  ])('a journal at planned whose stage is incomplete (%s) ends dropped: M untouched, no stage, no carry file, no journal', async (_name, damage) => {
    const rig = await buildRig();
    const dir = cloneM(rig);
    const before = filesOf(dir).filter((f) => !f.startsWith('linkstage/') && f !== 'link-adopt.json' && f !== 'link.json');
    damage(stageDirOf(dir, LINK));
    expect(boot(dir, rig)).toBe('dropped');
    expect(existsSync(join(dir, 'linkstage'))).toBe(false);
    expect(existsSync(join(dir, 'link-adopt.json'))).toBe(false);
    expect(existsSync(join(dir, 'link.json'))).toBe(false);
    expect(existsSync(join(dir, 'linkundo'))).toBe(false);
    expect(filesOf(dir).filter((f) => f !== 'surau.db-wal' && f !== 'surau.db-shm')).toEqual(before.filter((f) => f !== 'surau.db-wal' && f !== 'surau.db-shm'));
    const db = dbOf(dir);
    expect(dumpDb(db)).toEqual(rig.mBefore);
    db.close();
    // the next start has nothing to do
    expect(boot(dir, rig)).toBe('none');
  });
});

describe('adoptedStoreHasNoLiveCredential (table level)', () => {
  it('no session, challenge, box code, kiosk pairing, kiosk cookie or enrolment of G remains; no device or `*` user of G remains', async () => {
    const { rig, db } = await adopted({ mLinked: true });
    const ids = rig.ids;
    for (const t of ['sessions', 'challenges', 'box_codes', 'kiosk_pairings']) expect(count(db, t), t).toBe(0);
    // kiosk cookies: G's TV cookie is gone; M's own TV cookie and the follower's token are what is left
    expect(oneOf(db, 'SELECT 1 AS x FROM kiosk_cookies WHERE token_hash = ?', sha256hex('g-kiosk-cookie'))).toBeUndefined();
    expect(rowsOf(db, 'SELECT device_id FROM kiosk_cookies ORDER BY device_id').map((r) => r.device_id)).toEqual([rig.followerDeviceId, ids.mTvDev].sort());
    // enrolments: G's open code is gone; M's open code is not carried; the phone-move tickets are the only rows
    expect(oneOf(db, 'SELECT 1 AS x FROM enrolments WHERE code_hash = ?', sha256hex('GENROLCODE'))).toBeUndefined();
    expect(oneOf(db, 'SELECT 1 AS x FROM enrolments WHERE code_hash = ?', sha256hex('MENROLCODE'))).toBeUndefined();
    expect(rowsOf(db, 'SELECT user_id, created_by FROM enrolments ORDER BY user_id')).toEqual(
      [{ user_id: personId(db, G_NAMES.media), created_by: `link:${LINK}` }, { user_id: personId(db, G_NAMES.ajk), created_by: `link:${LINK}` }].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
    // devices of G
    for (const d of [ids.gAdminDev, ids.gMediaDev, ids.gTv]) expect(oneOf(db, 'SELECT 1 AS x FROM devices WHERE id = ?', d), d).toBeUndefined();
    expect(oneOf(db, 'SELECT 1 AS x FROM devices WHERE box_id = ?', rig.gBoxId)).toBeUndefined();
    // `*` users: G's gone, M's remains
    expect(rowsOf(db, "SELECT id FROM users WHERE surau_id = '*'").map((r) => r.id)).toEqual([ids.mStar]);
    expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE id = ? OR name = ?', ids.gStar, G_NAMES.star)).toBeUndefined();
    db.close();
  });

  it('every G user has no PIN of G (NULL, no failures, no lock); G\'s recovery code no longer verifies, the carried new one does', async () => {
    const { rig, db } = await adopted();
    const ids = rig.ids;
    for (const id of [personId(db, G_NAMES.media), personId(db, G_NAMES.ajk)]) {
      const u = oneOf(db, 'SELECT pin_hash, pin_fail_count, pin_locked_until, lock_round FROM users WHERE id = ?', id)!;
      expect(u, id).toEqual({ pin_hash: null, pin_fail_count: 0, pin_locked_until: null, lock_round: 0 });
    }
    // the one person who is on both boxes keeps M's PIN (made under M's key), never G's
    const both = oneOf(db, 'SELECT pin_hash, pin_fail_count, pin_locked_until, lock_round FROM users WHERE id = ?', personId(db, G_NAMES.admin))!;
    expect(both).toEqual({ pin_hash: `m-pin-${ids.mAdmin}`, pin_fail_count: 0, pin_locked_until: null, lock_round: 0 });
    expect(oneOf(db, "SELECT 1 AS x FROM users WHERE pin_hash LIKE 'g-pin-%'")).toBeUndefined();
    expect(verifyRecoveryCode(db, rig.gCode)).toBe(false);
    expect(verifyRecoveryCode(db, rig.recovery.code)).toBe(true);
    // the plain code never reached the database: only its hash did
    expect(oneOf(db, "SELECT value FROM meta WHERE key = 'recovery_code_hash'")!.value).toBe(rig.recovery.hash);
    db.close();
  });
});

describe('adoptKeepsContentFinancePeopleChangeLog', () => {
  it('G\'s content, finance, settings, prayer rows, people and change_log rows are all still there, unchanged; M\'s content is not', async () => {
    const { rig, db } = await adopted();
    const after = dumpDb(db);
    // G's people have new ids: a line of the old store, with each old id named by its person's new id
    const newOf = new Map(parse(rig.gBefore.users!).filter((u) => u.surau_id !== '*').map((u) => [String(u.id), personId(db, String(u.name))]));
    const renew = (l: string): string => [...newOf].reduce((x, [o, n]) => x.split(o).join(n), l);
    for (const t of ['content_items', 'finance_funds', 'prayer_corrections']) {
      expect(after[t], t).toEqual(rig.gBefore[t]!.map(renew).sort());
    }
    for (const t of ['prayer_days', 'applied_ops']) expect(after[t], t).toEqual(rig.gBefore[t]);
    // a finance entry never changes: it still names the old id of its author
    expect(after.finance_entries).toEqual(rig.gBefore.finance_entries);
    expect(after.finance_entries!.join('\n')).toContain(rig.ids.gAdmin);
    expect(after.content_items!.join('\n')).not.toContain('m-a-1');
    // settings: every row but tvProfiles is G's, byte for byte
    const keepSettings = (rows: string[]): string[] => rows.filter((l) => (JSON.parse(l) as { feature: string }).feature !== 'tvProfiles');
    expect(keepSettings(after.settings!)).toEqual(keepSettings(rig.gBefore.settings!.map(renew)).sort());
    expect(JSON.parse((parse(after.settings!).find((r) => r.feature === 'surauInfo')!).json as string)).toEqual({ name: 'Surau Al-Hidayah' });
    // change_log: every G row is there unchanged, and exactly one row more (the marker)
    // (the rows of people name the new id; their text columns stay as they were written)
    const flat = (l: string): string => {
      const r = JSON.parse(l) as Record<string, unknown>;
      if (r.entity === 'users' || r.entity === 'user') r.entity_id = '*';
      r.actor = renew(String(r.actor));
      return JSON.stringify(r, Object.keys(r).sort());
    };
    const afterFlat = after.change_log!.map(flat);
    for (const l of rig.gBefore.change_log!) expect(afterFlat, l).toContain(flat(l));
    for (const [o, n] of newOf) {
      expect(oneOf(db, "SELECT 1 AS x FROM change_log WHERE entity IN ('users', 'user') AND entity_id = ?", o), o).toBeUndefined();
      expect(oneOf(db, "SELECT 1 AS x FROM change_log WHERE entity IN ('users', 'user') AND entity_id = ?", n), n).toBeDefined();
    }
    expect(after.change_log!.length).toBe(rig.gBefore.change_log!.length + 1);
    // people: every G person (but the `*` one) keeps name, roles, phone, number, created_at; only the PIN columns moved
    const was = parse(rig.gBefore.users!).filter((u) => u.surau_id !== '*');
    for (const u of was) {
      const now = oneOf(db, 'SELECT * FROM users WHERE name = ?', String(u.name))!;
      for (const k of ['name', 'roles_json', 'phone', 'no', 'no_src', 'active', 'created_at', 'surau_id']) expect(now[k], `${String(u.name)}.${k}`).toEqual(u[k]);
      expect(now.created_by, String(u.name)).toEqual(renew(String(u.created_by)));
    }
    // the numbers still count above every kept and carried row
    for (const [kind, table] of [['user', 'users'], ['device', 'devices']] as const) {
      const top = Number(oneOf(db, `SELECT MAX(no) AS n FROM ${table}`)!.n);
      const next = Number(oneOf(db, "SELECT next FROM id_counters WHERE surau_id = 'sdm' AND kind = ?", kind)!.next);
      expect(next, kind).toBeGreaterThan(top);
    }
    db.close();
  });

  it('the media of G are in place (every listed file, exact bytes)', async () => {
    const { dir, db } = await adopted();
    db.close();
    for (const f of G_MEDIA_FILES) expect(readFileSync(join(dir, ...f.rel.split('/'))).equals(f.data), f.rel).toBe(true);
    expect(existsSync(join(dir, 'assets', 'mine.jpg'))).toBe(false);
  });
});

describe('adoptClearsCloudCursors', () => {
  it.each([
    ['M linked, G log shorter', { mLinked: true, gLog: 5, mLog: 80 }],
    ['M not linked, G log longer', { mLinked: false, gLog: 90, mLog: 3 }],
  ])('every cloud key of G is gone, the local ones stay, M\'s link is carried only when it had one; marker above both heads (%s)', async (_n, o) => {
    const { rig, dir, db } = await adopted(o);
    const keys = rowsOf(db, 'SELECT key, value FROM sync_state ORDER BY key');
    const byKey = Object.fromEntries(keys.map((r) => [String(r.key), r.value]));
    const marker = oneOf(db, "SELECT id FROM change_log WHERE entity = 'box' AND entity_id = ? AND actor = 'system:link'", LINK)!;
    const id = Number(marker.id);
    expect(id).toBe(Math.max(rig.gHead, rig.mHead) + 1);
    expect(id).toBeGreaterThan(rig.gHead);
    expect(id).toBeGreaterThan(rig.mHead);
    const local = { log_floor: String(id), clean_posters: 'keep-1', poster_stretch_keep: '1', 'ayat_daily_anchor:2026-11-01': 'anchor' };
    const carried = o.mLinked ? { linked: '1', cloud_url: 'https://cloud.example.test/m', link_history: '1' } : {};
    expect(byKey).toEqual({ ...local, ...carried });
    // none of G's cloud keys, none of M's cursors, M's own local key is not carried either
    for (const k of ['last_pull_seq', 'last_push_at', 'pending_out', 'refused_total', 'site_role', 'peer_token', 'parked_token', 'theme_support_a', 'people_resync', 'ids_push', 'device_seen_x', 'photo_up/abc', 'dev_revoked/abc', 'camera_hash', 'youtube_state', 'autolink_try', 'clean_m']) {
      expect(byKey[k], k).toBeUndefined();
    }
    // the cloud copy must be made equal first: sync is held only when M was linked
    expect(existsSync(join(dir, CLOUD_RESET_REL))).toBe(o.mLinked);
    if (o.mLinked) {
      const mark = JSON.parse(readFileSync(join(dir, CLOUD_RESET_REL), 'utf8')) as Record<string, unknown>;
      expect(mark.linkId).toBe(LINK);
      expect(mark.reason).toBe('adopt');
    }
    // the marker names the old log: a cursor of either log gets snapshot_required
    const m = oneOf(db, 'SELECT after_json, origin, entity FROM change_log WHERE id = ?', id)!;
    expect(JSON.parse(String(m.after_json))).toEqual({ reason: 'adopt', case: 'X', fromBoxId: rig.gBoxId });
    db.close();
  });
});

describe('masterOldPeopleMerged', () => {
  it('M\'s active people come over with ids and PIN hashes; the same phone is ONE person; a clashing number is renumbered', async () => {
    const { rig, db } = await adopted();
    const ids = rig.ids;
    // carried with their own ids and PIN hashes
    for (const id of [ids.mCik, ids.mOwner]) {
      const u = oneOf(db, 'SELECT pin_hash, active, deleted_at FROM users WHERE id = ?', id)!;
      expect(u, id).toEqual({ pin_hash: `m-pin-${id}`, active: 1, deleted_at: null });
    }
    // the same phone: G's row (id and roles), M's PIN, M's phone pointed at it, M's own row not there
    expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE id = ?', ids.mAdmin)).toBeUndefined();
    expect(rowsOf(db, "SELECT id FROM users WHERE phone = '+60120000001'")).toHaveLength(1);
    const gAdminNew = personId(db, G_NAMES.admin);
    expect(gAdminNew).not.toBe(ids.gAdmin);
    const one = oneOf(db, 'SELECT id, roles_json, pin_hash FROM users WHERE phone = ?', String(oneOf(db, 'SELECT phone FROM users WHERE id = ?', gAdminNew)!.phone))!;
    expect(one).toEqual({ id: gAdminNew, roles_json: '["admin"]', pin_hash: `m-pin-${ids.mAdmin}` });
    expect(oneOf(db, 'SELECT user_id FROM devices WHERE id = ?', ids.mAdminDev)!.user_id).toBe(gAdminNew);
    // M's deleted person and M's revoked / orphan phones are not carried
    expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE id = ?', ids.mGone)).toBeUndefined();
    expect(oneOf(db, 'SELECT 1 AS x FROM devices WHERE id = ?', ids.mRevokedDev)).toBeUndefined();
    expect(oneOf(db, "SELECT 1 AS x FROM devices WHERE id = 'm-dev-gone'")).toBeUndefined();
    // numbers: no two people (or phones) share one, and the clashing ones got new numbers above G's series
    for (const table of ['users', 'devices']) {
      const dup = rowsOf(db, `SELECT surau_id, no_src, no, COUNT(*) AS n FROM ${table} WHERE no IS NOT NULL GROUP BY surau_id, no_src, no HAVING n > 1`);
      expect(dup, table).toEqual([]);
    }
    const was = Object.fromEntries(parse(rig.mBefore.users!).map((u) => [String(u.id), u.no]));
    for (const id of [ids.mCik, ids.mOwner]) {
      const no = Number(oneOf(db, 'SELECT no FROM users WHERE id = ?', id)!.no);
      expect(no, id).not.toBe(was[id]);
      expect(no).toBeGreaterThanOrEqual(4);
    }
    // the devices that are left: M's carried phones and TV, plus the new follower row; none points at a missing person
    expect(rowsOf(db, 'SELECT id FROM devices ORDER BY id').map((r) => r.id)).toEqual([rig.followerDeviceId, ids.mAdminDev, ids.mCikDev, ids.mOwnerDev, ids.mTvDev].sort());
    expect(rowsOf(db, 'SELECT d.id FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE u.id IS NULL')).toEqual([]);
    // M's phones keep their box id (M's own) and key
    const dev = oneOf(db, 'SELECT box_id, public_jwk, platform FROM devices WHERE id = ?', ids.mCikDev)!;
    expect(dev.box_id).toBe(rig.mBoxId);
    expect(dev.public_jwk).toBe(String(parse(rig.mBefore.devices!).find((d) => d.id === ids.mCikDev)!.public_jwk));
    db.close();
  });

  it('M\'s TV device row and its kiosk cookie are carried; the follower\'s TV is made with its token; the link rows are written', async () => {
    const { rig, db } = await adopted();
    const ids = rig.ids;
    expect(oneOf(db, 'SELECT platform, user_id FROM devices WHERE id = ?', ids.mTvDev)).toEqual({ platform: 'kiosk', user_id: ids.mOwner });
    expect(oneOf(db, 'SELECT device_id FROM kiosk_cookies WHERE token_hash = ?', sha256hex('m-kiosk-cookie'))!.device_id).toBe(ids.mTvDev);
    const f = oneOf(db, 'SELECT user_id, platform, box_id FROM devices WHERE id = ?', rig.followerDeviceId)!;
    expect(f).toEqual({ user_id: ids.mOwner, platform: 'kiosk', box_id: rig.mBoxId });
    expect(oneOf(db, 'SELECT device_id FROM kiosk_cookies WHERE token_hash = ?', sha256hex('follower-token'))!.device_id).toBe(rig.followerDeviceId);
    const lb = rowsOf(db, 'SELECT device_id, box_id, link_id, removed_at FROM linked_boxes');
    expect(lb).toEqual([{ device_id: rig.followerDeviceId, box_id: rig.gBoxId, link_id: LINK, removed_at: null }]);
    // the session as M finished it
    expect(oneOf(db, 'SELECT step, outcome FROM link_sessions WHERE id = ?', LINK)).toEqual({ step: 'done', outcome: 'linked' });
    // the old links of G mean nothing here
    expect(count(db, 'link_people')).toBe(0);
    db.close();
  });

  it('tvProfiles: G\'s `self` is under the follower\'s device id, M\'s `self` is `self`, M\'s carried TV entries are present, orphans of M are not', async () => {
    const { rig, db } = await adopted();
    const tvs = (JSON.parse(String(oneOf(db, "SELECT json FROM settings WHERE feature = 'tvProfiles'")!.json)) as { tvs: Record<string, unknown> }).tvs;
    expect(tvs[rig.followerDeviceId]).toEqual({ name: 'Dewan Utama', lang: 'ms' });
    expect(tvs.self).toEqual({ name: 'TV Ruang Muslimat', lang: 'en' });
    expect(tvs[rig.ids.mTvDev]).toEqual({ name: 'TV Muslimat dua' });
    expect(tvs['m-orphan']).toBeUndefined();
    // G's other entry (a stale TV of G) is the kept data's and stays
    expect(tvs['g-old-tv']).toEqual({ name: 'TV Lama' });
    db.close();
  });

  it('meta: M\'s box name and setup id win, G\'s recovery code hash is replaced; the version rows are kept', async () => {
    const { rig, db } = await adopted();
    const meta = Object.fromEntries(rowsOf(db, 'SELECT key, value FROM meta').map((r) => [String(r.key), r.value]));
    expect(meta.box_name).toBe('Ruang Muslimat');
    expect(meta.surau_id).toBe('m-setup-id');
    expect(meta.recovery_code_hash).toBe(rig.recovery.hash);
    expect(meta.prayer_official_feed_backfill).toBe('done');
    expect(meta['jakimZones.checked']).toBe('2026-11-01');
    expect(meta.schema_version ?? null).toBe(parse(rig.gBefore.meta!).find((m) => m.key === 'schema_version')?.value ?? null);
    db.close();
  });

  it('the old store of M is set aside whole (database, media, its cloud key copied) and its cloud key stays in place', async () => {
    const { rig, dir } = await adopted({ mLinked: true });
    const back = join(dir, 'linkundo', LINK);
    expect(backupOf(dir, LINK)!.kind).toBe('set-aside');
    expect(existsSync(join(back, 'assets', 'mine.jpg'))).toBe(true);
    expect(readFileSync(join(dir, 'secret', 'sync.key'), 'utf8')).toBe('M-cloud-key-bytes');
    expect(readFileSync(join(back, 'secret', 'sync.key'), 'utf8')).toBe('M-cloud-key-bytes');
    const old = openDb(join(back, 'surau.db'));
    expect(dumpDb(old)).toEqual(rig.mBefore);
    old.close();
    // G's cloud key bytes crossed nowhere (they were never listed)
    for (const rel of filesOf(dir)) expect(readFileSync(join(dir, ...rel.split('/'))).includes('G-cloud-key-bytes'), rel).toBe(false);
  });
});

describe('N-X: M is a box that was never set up', () => {
  it('the place is cleared (no backup folder), G\'s store is in place, the follower row and the admin\'s 30 minute ticket exist', async () => {
    const { rig, dir, db } = await adopted({ case: 'N-X' });
    const ids = rig.ids;
    expect(existsSync(join(dir, 'linkundo'))).toBe(false);
    expect(backupOf(dir, LINK)).toBeNull();
    // G's people and data are the store; G's `*` person is gone
    expect(rowsOf(db, 'SELECT name FROM users ORDER BY name').map((r) => r.name)).toEqual([G_NAMES.ajk, G_NAMES.admin, G_NAMES.media].sort());
    for (const old of [ids.gAdmin, ids.gMedia, ids.gAjk]) expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE id = ?', old), old).toBeUndefined();
    expect(rowsOf(db, 'SELECT id FROM content_items ORDER BY id').map((r) => r.id)).toEqual(['a-1', 'p-1']);
    // no one's PIN is left (the new box has no people of its own to carry)
    expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE pin_hash IS NOT NULL')).toBeUndefined();
    // the follower TV row, made in the name of G's linking admin, with its token
    expect(oneOf(db, 'SELECT user_id, box_id FROM devices WHERE id = ?', rig.followerDeviceId)).toEqual({ user_id: personId(db, G_NAMES.admin), box_id: rig.mBoxId });
    expect(oneOf(db, 'SELECT device_id FROM linked_boxes WHERE link_id = ?', LINK)!.device_id).toBe(rig.followerDeviceId);
    // the admin's one-time move ticket on this box, bound to that person, 30 minutes
    const t = oneOf(db, 'SELECT user_id, expires_at, used_at, created_by FROM enrolments WHERE code_hash = ?', sha256hex('TICKETADMIN'))!;
    expect(t).toEqual({ user_id: personId(db, G_NAMES.admin), expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(), used_at: null, created_by: `link:${LINK}` });
    // N-X has no cloud link of M's to carry, no reset mark, no leftovers
    expect(existsSync(join(dir, CLOUD_RESET_REL))).toBe(false);
    expect(existsSync(join(dir, 'linkstage'))).toBe(false);
    expect(oneOf(db, "SELECT 1 AS x FROM sync_state WHERE key IN ('linked', 'cloud_url', 'last_pull_seq')")).toBeUndefined();
    expect(oneOf(db, "SELECT value FROM meta WHERE key = 'recovery_code_hash'")!.value).toBe(rig.recovery.hash);
    db.close();
    expect(takeRecoveryNote(dir, loadIdentity(dir), rig.mBoxId)!.code).toBe(rig.recovery.code);
  });

  it('a power cut at every step also ends in the clean end state (N-X)', async () => {
    const rig = await buildRig({ case: 'N-X' });
    const cleanDir = cloneM(rig);
    const steps: string[] = [];
    expect(boot(cleanDir, rig, (n) => steps.push(n))).toBe('adopt');
    const clean = endState(cleanDir, rig);
    for (let k = 0; k < steps.length; k++) {
      const dir = cloneM(rig);
      let n = 0;
      expect(() => boot(dir, rig, () => {
        if (n++ === k) throw new Error('power cut');
      }), `kill ${k} (${steps[k]})`).toThrow('power cut');
      boot(dir, rig);
      expect(endState(dir, rig), `N-X kill at step ${k} (${steps[k]})`).toEqual(clean);
    }
  }, 120_000);
});

describe('takeRecoveryNote', () => {
  it('gives the new code for 15 minutes after its first read, then null; a note sealed for another box id (or opened with another identity) does not open', async () => {
    const { rig, dir } = await adopted();
    const id = loadIdentity(dir);
    const path = join(dir, RECOVERY_NOTE_REL);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    // another box id: no code (and the file is spent by the read: a wrong reader must not keep it either)
    expect(takeRecoveryNote(dir, id, 'f'.repeat(16))).toBeNull();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, raw);
    // another identity key: no code
    const other = loadIdentity(tempDir());
    expect(takeRecoveryNote(dir, other, rig.mBoxId)).toBeNull();
    writeFileSync(path, raw);
    // a note with another link id inside the clear JSON does not open either (the link id is part of the seal)
    const edited = JSON.parse(raw) as { linkId: string; sealed: string };
    writeFileSync(path, JSON.stringify({ ...edited, linkId: 'd2'.repeat(16) }));
    expect(takeRecoveryNote(dir, id, rig.mBoxId)).toBeNull();
    // the honest note: readable again within 15 minutes of the first read (a lost answer), then gone
    writeFileSync(path, raw);
    const t0 = new Date('2026-11-23T10:00:00.000Z');
    expect(takeRecoveryNote(dir, id, rig.mBoxId, t0)).toEqual({ linkId: LINK, code: rig.recovery.code });
    expect(takeRecoveryNote(dir, id, rig.mBoxId, new Date(t0.getTime() + 14 * 60_000))).toEqual({ linkId: LINK, code: rig.recovery.code });
    expect(takeRecoveryNote(dir, id, rig.mBoxId, new Date(t0.getTime() + 16 * 60_000))).toBeNull();
    expect(existsSync(path)).toBe(false);
    // junk
    writeFileSync(path, '{not json');
    expect(takeRecoveryNote(dir, id, rig.mBoxId)).toBeNull();
  });
});

describe('a carry file that does not open is dropped at planned', () => {
  async function swapCarry(make: (rig: Rig, dir: string) => string): Promise<void> {
    const rig = await buildRig();
    const dir = cloneM(rig);
    // the replacement is sealed in a scratch folder (planAdopt refuses a folder whose journal is open)
    const scratch = tempDir();
    const file = make(rig, scratch);
    cpSync(file, join(dir, 'link-adopt.json'));
    expect(boot(dir, rig)).toBe('dropped');
    expect(existsSync(join(dir, 'link-adopt.json'))).toBe(false);
    expect(existsSync(join(dir, 'linkstage'))).toBe(false);
    expect(existsSync(join(dir, 'link.json'))).toBe(false);
    expect(existsSync(join(dir, 'linkundo'))).toBe(false);
    const db = dbOf(dir);
    expect(dumpDb(db)).toEqual(rig.mBefore);
    db.close();
  }

  it('sealed by another box\'s identity key', async () => {
    await swapCarry((rig, scratch) => {
      planAdopt(scratch, loadIdentity(scratch), rig.carry);
      return join(scratch, 'link-adopt.json');
    });
  });

  it('sealed for another link id', async () => {
    await swapCarry((rig, scratch) => {
      // the key is M's own (copied into the scratch folder) but the seal names another link
      cpSync(join(rig.mDir, 'secret'), join(scratch, 'secret'), { recursive: true });
      planAdopt(scratch, loadIdentity(scratch), { ...rig.carry, linkId: 'd2'.repeat(16) });
      return join(scratch, 'link-adopt.json');
    });
  });

  it('sealed for another box id', async () => {
    await swapCarry((rig, scratch) => {
      cpSync(join(rig.mDir, 'secret'), join(scratch, 'secret'), { recursive: true });
      planAdopt(scratch, loadIdentity(scratch), { ...rig.carry, boxId: 'e5'.repeat(8) });
      return join(scratch, 'link-adopt.json');
    });
  });

  it('a carry file that is not a seal at all, or a missing one', async () => {
    const rig = await buildRig();
    for (const body of ['{}', 'garbage', null]) {
      const dir = cloneM(rig);
      if (body === null) rmSync(join(dir, 'link-adopt.json'));
      else writeFileSync(join(dir, 'link-adopt.json'), body);
      expect(boot(dir, rig)).toBe('dropped');
      expect(existsSync(join(dir, 'linkstage'))).toBe(false);
      const db = dbOf(dir);
      expect(dumpDb(db)).toEqual(rig.mBefore);
      db.close();
    }
  });
});

describe('sweepAdoptLeftovers', () => {
  it('with no adopt journal it removes link-adopt.json and linkstage/; with one it leaves them', async () => {
    const rig = await buildRig();
    // an open adopt journal: nothing is touched
    const open = cloneM(rig);
    sweepAdoptLeftovers(open);
    expect(existsSync(join(open, 'link-adopt.json'))).toBe(true);
    expect(existsSync(stageDirOf(open, LINK))).toBe(true);
    expect(existsSync(join(open, 'link.json'))).toBe(true);
    // no journal (the link failed before the commit): both go
    const none = cloneM(rig);
    rmSync(join(none, 'link.json'));
    sweepAdoptLeftovers(none);
    expect(existsSync(join(none, 'link-adopt.json'))).toBe(false);
    expect(existsSync(join(none, 'linkstage'))).toBe(false);
    // M's own store is not touched by the sweep
    expect(existsSync(join(none, 'surau.db'))).toBe(true);
    expect(existsSync(join(none, 'assets', 'mine.jpg'))).toBe(true);
    // a journal of another op (a set-aside): the leftovers still go, the journal stays
    const other = cloneM(rig);
    writeFileSync(join(other, 'link.json'), JSON.stringify({ v: 1, op: 'forget', linkId: LINK, step: 'planned', at: NOW.toISOString() }));
    sweepAdoptLeftovers(other);
    expect(existsSync(join(other, 'link-adopt.json'))).toBe(false);
    expect(existsSync(join(other, 'linkstage'))).toBe(false);
    expect(existsSync(join(other, 'link.json'))).toBe(true);
    // nothing to sweep: a no-op
    expect(() => sweepAdoptLeftovers(none)).not.toThrow();
  });
});

describe('the plan: planAdopt, commitAdopt, dropAdoptPlan, carryOf', () => {
  it('a plan needs a good link id and no open journal; a commit needs a plan; a drop removes the plan', async () => {
    const rig = await buildRig();
    const dir = tempDir();
    const id = loadIdentity(dir);
    expect(() => planAdopt(dir, id, { ...rig.carry, linkId: '../x' })).toThrow('adopt: bad_link_id');
    expect(() => commitAdopt(dir, LINK, NOW)).toThrow('adopt: no_plan');
    planAdopt(dir, id, { ...rig.carry, boxId: boxIdOf(dir) });
    expect(existsSync(join(dir, 'link-adopt.json'))).toBe(true);
    // the carry file is a seal: none of M's people, hashes or codes are readable in it
    const text = readFileSync(join(dir, 'link-adopt.json'), 'utf8');
    for (const secret of ['m-pin-', rig.recovery.code, rig.recovery.hash, 'Ustaz Zakaria', 'follower-token']) expect(text.includes(secret), secret).toBe(false);
    dropAdoptPlan(dir);
    expect(existsSync(join(dir, 'link-adopt.json'))).toBe(false);
    planAdopt(dir, id, { ...rig.carry, boxId: boxIdOf(dir) });
    commitAdopt(dir, LINK, NOW);
    expect(existsSync(join(dir, 'link.json'))).toBe(true);
    // a journal is open: no second plan
    expect(() => planAdopt(dir, id, { ...rig.carry, boxId: boxIdOf(dir) })).toThrow('adopt: journal_open');
  });

  it('the commit alone writes the journal: a plan with no commit leaves the next start with nothing to apply', async () => {
    const rig = await buildRig();
    const dir = cloneM(rig);
    rmSync(join(dir, 'link.json'));
    expect(boot(dir, rig)).toBe('none');
    // the store is as it was
    const db = dbOf(dir);
    expect(dumpDb(db)).toEqual(rig.mBefore);
    db.close();
  });

  it('carryOf reads only M\'s active people, their live phones, unexpired cookies of those phones, M\'s own TV entries and the cloud link', async () => {
    const rig = await buildRig({ mLinked: true });
    const c = rig.carry;
    expect(c.people.map((p) => p.id).sort()).toEqual([rig.ids.mAdmin, rig.ids.mCik, rig.ids.mOwner, rig.ids.mStar].sort());
    expect(c.devices.map((d) => d.id).sort()).toEqual([rig.ids.mAdminDev, rig.ids.mCikDev, rig.ids.mOwnerDev, rig.ids.mTvDev].sort());
    expect(c.cookies.map((k) => k.device_id)).toEqual([rig.ids.mTvDev]);
    expect(Object.keys(c.tvs).sort()).toEqual(['self', rig.ids.mTvDev].sort());
    expect(c.cloudReset).toBe(true);
    expect(c.sync.map((s) => s.key).sort()).toEqual(['cloud_url', 'link_history', 'linked']);
    expect(c.oldHead).toBe(rig.mHead);
    expect(c.meta.map((m) => m.key).sort()).toEqual(['box_name', 'box_name_basis', 'surau_id']);
    // an expired cookie is not carried
    const db = dbOf(rig.mDir);
    db.prepare("UPDATE kiosk_cookies SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    expect(carryOf(db, NOW, LINK).cookies).toEqual([]);
    db.close();
  });
});

describe('rekeyPeople: G\'s people get new ids', () => {
  const ATTRIBUTION: [string, string][] = [
    ['users', 'created_by'], ['users', 'deleted_by'], ['assets', 'created_by'], ['finance_months', 'closed_by'],
    ['settings', 'updated_by'], ['prayer_imports', 'actor'], ['prayer_imports', 'undone_by'], ['prayer_corrections', 'actor'],
    ['content_items', 'updated_by'], ['finance_funds', 'updated_by'], ['finance_perihal', 'updated_by'],
    ['finance_photos', 'created_by'], ['change_log', 'actor'], ['auth_log', 'user_id'],
  ];

  it('no old id of G\'s people remains in users, auth_log, change_log (users) or any attribution column, in both forms', async () => {
    const { rig, db } = await adopted({ mLinked: true });
    const olds = [rig.ids.gAdmin, rig.ids.gMedia, rig.ids.gAjk];
    for (const o of olds) {
      expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE id = ?', o), `users ${o}`).toBeUndefined();
      expect(oneOf(db, "SELECT 1 AS x FROM change_log WHERE entity IN ('users', 'user') AND entity_id = ?", o), `change_log ${o}`).toBeUndefined();
      for (const [t, col] of ATTRIBUTION) {
        const cols = rowsOf(db, `SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name);
        if (!cols.includes(col)) continue;
        expect(oneOf(db, `SELECT 1 AS x FROM ${t} WHERE ${col} = ? OR ${col} = ?`, o, `user:${o}`), `${t}.${col} ${o}`).toBeUndefined();
      }
    }
    // the people are there under new, distinct UUIDs, and the rows that named them follow
    const ids = [G_NAMES.admin, G_NAMES.media, G_NAMES.ajk].map((n) => personId(db, n));
    expect(new Set(ids).size).toBe(3);
    for (const i of ids) expect(i).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    const [admin, media] = ids as [string, string];
    expect(oneOf(db, 'SELECT user_id FROM auth_log WHERE event = ?', 'unlock')!.user_id).toBe(media);
    expect(oneOf(db, "SELECT updated_by FROM content_items WHERE id = 'a-1'")!.updated_by).toBe(`user:${admin}`);
    expect(oneOf(db, "SELECT updated_by FROM content_items WHERE id = 'p-1'")!.updated_by).toBe(media);
    expect(oneOf(db, 'SELECT actor FROM prayer_corrections')!.actor).toBe(`user:${media}`);
    expect(oneOf(db, "SELECT updated_by FROM finance_funds WHERE id = 'fund-1'")!.updated_by).toBe(admin);
    expect(oneOf(db, "SELECT updated_by FROM settings WHERE feature = 'surauInfo'")!.updated_by).toBe(admin);
    expect(oneOf(db, 'SELECT created_by FROM users WHERE id = ?', media)!.created_by).toBe(admin);
    expect(oneOf(db, 'SELECT 1 AS x FROM change_log WHERE actor = ?', `user:${admin}`)).toBeDefined();
    // a finance entry is immutable history: it keeps the old id
    expect(oneOf(db, "SELECT created_by FROM finance_entries WHERE id = 'fe-1'")!.created_by).toBe(rig.ids.gAdmin);
    db.close();
  });

  it('M\'s own ids are unchanged; the M person matched by phone has M\'s PIN on G\'s NEW id and M\'s phone points at it; tickets land on the new ids', async () => {
    const { rig, db } = await adopted();
    const ids = rig.ids;
    for (const m of [ids.mCik, ids.mOwner, ids.mStar]) expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE id = ?', m), m).toBeDefined();
    const admin = personId(db, G_NAMES.admin);
    expect(admin).not.toBe(ids.gAdmin);
    expect(oneOf(db, 'SELECT pin_hash FROM users WHERE id = ?', admin)!.pin_hash).toBe(`m-pin-${ids.mAdmin}`);
    expect(oneOf(db, 'SELECT user_id FROM devices WHERE id = ?', ids.mAdminDev)!.user_id).toBe(admin);
    expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE id = ?', ids.mAdmin)).toBeUndefined();
    const tickets = rowsOf(db, 'SELECT user_id, code_hash FROM enrolments ORDER BY code_hash');
    expect(tickets).toEqual([
      { user_id: personId(db, G_NAMES.media), code_hash: sha256hex('TICKETMEDIA') },
      { user_id: personId(db, G_NAMES.ajk), code_hash: sha256hex('TICKETAJK') },
    ].sort((a, b) => a.code_hash.localeCompare(b.code_hash)));
    db.close();
  });

  it('the N-X admin ticket lands on the admin\'s new id; the follower row is made for it', async () => {
    const { rig, db } = await adopted({ case: 'N-X' });
    const admin = personId(db, G_NAMES.admin);
    expect(admin).not.toBe(rig.ids.gAdmin);
    expect(oneOf(db, 'SELECT user_id FROM enrolments WHERE code_hash = ?', sha256hex('TICKETADMIN'))!.user_id).toBe(admin);
    expect(oneOf(db, 'SELECT user_id FROM devices WHERE id = ?', rig.followerDeviceId)!.user_id).toBe(admin);
    db.close();
  });
});

describe('adoptStore on its own', () => {
  it('the follower row is made for the merged person when the PIN-proof admin of the master is on both boxes', async () => {
    const { rig, db } = await adopted({ ownerIsMerged: true });
    expect(oneOf(db, 'SELECT user_id FROM devices WHERE id = ?', rig.followerDeviceId)!.user_id).toBe(personId(db, G_NAMES.admin));
    db.close();
  });

  it('a bad carried row (no id, a phone of nobody, an id twice) is left out and counted, never thrown; the rest lands', async () => {
    const rig = await buildRig();
    const dir = cloneM(rig);
    const db = openDb(join(stageDirOf(dir, LINK), 'surau.db'));
    const people = [...rig.carry.people, { id: null, name: 'Tanpa id' }, { ...rig.carry.people[1]! }, { id: 'p-bad', name: 'x'.repeat(10), surau_id: 'sdm', roles_json: '["admin"]', active: 1, created_at: 'x', created_by: 'test', no: 'not-a-number' }];
    const devices = [...rig.carry.devices, { id: 'dev-orphan', user_id: 'nobody', name: 'x', platform: 'android', public_jwk: '{}', enrolled_at: 'x', surau_id: 'sdm' }];
    const r = adoptStore(db, { ...rig.carry, people, devices }, NOW);
    expect(r.skipped).toBeGreaterThanOrEqual(2);
    expect(oneOf(db, 'SELECT 1 AS x FROM devices WHERE id = ?', 'dev-orphan')).toBeUndefined();
    expect(oneOf(db, 'SELECT 1 AS x FROM users WHERE id = ?', rig.ids.mCik)).toBeDefined();
    expect(oneOf(db, "SELECT 1 AS x FROM change_log WHERE actor = 'system:link'")).toBeDefined();
    db.close();
  });

  it('a store with no person at all stops the adopt and leaves the database exactly as it was (one transaction)', async () => {
    const rig = await buildRig({ case: 'N-X' });
    const dir = cloneM(rig);
    const db = openDb(join(stageDirOf(dir, LINK), 'surau.db'));
    db.exec('PRAGMA foreign_keys = OFF');
    for (const t of ['sessions', 'devices', 'enrolments', 'users']) db.prepare(`DELETE FROM ${t}`).run();
    db.exec('PRAGMA foreign_keys = ON');
    const before = dumpDb(db);
    expect(() => adoptStore(db, rig.carry, NOW)).toThrow('adopt: the adopted store has no person');
    expect(dumpDb(db)).toEqual(before);
    db.close();
  });
});

describe('the adopted store keeps G\'s sign-ins under M\'s own key', () => {
  it('the YouTube sign-in and the camera address (no password, password needed) are saved on M; nothing else of G\'s secrets', async () => {
    const { rig, dir } = await adopted({ youtube: YT, camera: { url: 'rtsp://10.168.50.40:554/stream1', username: 'admin', password: 'Sup3rSecret' } });
    expect(new TokenStore(dir).load()).toEqual(YT);
    const cam = new CameraStore(dir).getMasked();
    expect(JSON.stringify(cam)).not.toContain('Sup3rSecret');
    expect(cam).toMatchObject({ passwordNeeded: true });
    expect(new CameraStore(dir).get()?.password).toBeUndefined();
    expect(new CameraStore(dir).get()?.url).toBe('rtsp://10.168.50.40:554/stream1');
    // sealed on disk: the plain tokens are nowhere in the folder
    for (const rel of filesOf(dir)) {
      const bytes = readFileSync(join(dir, ...rel.split('/')));
      expect(bytes.includes(YT.refreshToken), rel).toBe(false);
      expect(bytes.includes('Sup3rSecret'), rel).toBe(false);
    }
    void rig;
  });

  it('with no sign-in on G, M keeps whatever it has (nothing is written)', async () => {
    const { dir } = await adopted();
    expect(new TokenStore(dir).load()).toBeNull();
    expect(existsSync(join(dir, 'secret', 'live-camera.json'))).toBe(false);
  });
});
