import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoxQrPub } from '@surau/core';
import { keyFingerprint } from '@surau/core';
import { secretDir } from '../auth/secrets.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { openWithBoxKey, sealToBoxKey, sealedRe } from '../sync/boxSeal.ts';

/**
 * What a follower box (kotak pengikut) keeps about its master (kotak utama): who it follows and the TV token the
 * master gave it. SECURITY code. The record is sealed to this box's own identity key and lives OUTSIDE the store
 * (`secret/follow.json`), because the store is what a link sets aside.
 *
 * A box with this file is a follower: it serves its TV from the mirror, refuses every session and admin route and
 * obeys only orders signed by `masterPub`.
 */
export interface FollowRecord {
  v: 1;
  linkId: string;
  masterBoxId: string;
  masterKeyFp: string;
  masterPub: BoxQrPub;
  /** sha256 hex of the DER of the master's root CA: the only CA trusted on the channel to the master. */
  masterCa: string;
  masterName: string;
  /** https origins of the master on the LAN, the first is the one used at link time. */
  addresses: string[];
  /** The TV token: sent as the kiosk cookie. Grants `kiosk:read` at the master and nothing else. */
  token: string;
  /** This box's TV device row at the master (its key in `tvProfiles`). */
  deviceId: string;
  linkedAt: string;
  /** True when this box was set up before the link: its old store is the backup under `linkundo/<linkId>/`. */
  hadStore: boolean;
}

const FILE = 'follow.json';
const LABEL = 'maxcom-follow-v1';
const SEALED = sealedRe(8192);
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64URL43 = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,40}$/;

function isOrigin(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 200) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.origin === s;
  } catch {
    return false;
  }
}

/** Strict parse: a record that does not hold together is no record. */
export function parseFollowRecord(v: unknown): FollowRecord | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const pub = r.masterPub as Record<string, unknown> | null;
  if (
    r.v !== 1 ||
    typeof r.linkId !== 'string' || !HEX32.test(r.linkId) ||
    typeof r.masterBoxId !== 'string' || !HEX16.test(r.masterBoxId) ||
    typeof r.masterKeyFp !== 'string' || !HEX16.test(r.masterKeyFp) ||
    typeof pub !== 'object' || pub === null || pub.kty !== 'EC' || pub.crv !== 'P-256' ||
    typeof pub.x !== 'string' || !B64URL43.test(pub.x) || typeof pub.y !== 'string' || !B64URL43.test(pub.y) ||
    typeof r.masterCa !== 'string' || !HEX64.test(r.masterCa) ||
    typeof r.masterName !== 'string' || r.masterName.length < 1 || r.masterName.length > 60 ||
    !Array.isArray(r.addresses) || r.addresses.length < 1 || r.addresses.length > 8 || !r.addresses.every(isOrigin) ||
    typeof r.token !== 'string' || !B64URL43.test(r.token) ||
    typeof r.deviceId !== 'string' || !DEVICE_ID.test(r.deviceId) ||
    typeof r.linkedAt !== 'string' || Number.isNaN(Date.parse(r.linkedAt)) ||
    typeof r.hadStore !== 'boolean'
  ) return null;
  const masterPub: BoxQrPub = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y };
  if (keyFingerprint(masterPub) !== r.masterKeyFp) return null;
  return {
    v: 1, linkId: r.linkId, masterBoxId: r.masterBoxId, masterKeyFp: r.masterKeyFp, masterPub, masterCa: r.masterCa,
    masterName: r.masterName, addresses: r.addresses as string[], token: r.token, deviceId: r.deviceId,
    linkedAt: r.linkedAt, hadStore: r.hadStore,
  };
}

export interface FollowStore {
  /** The record, or null for a box that follows nobody (or whose file cannot be opened with this box's key). */
  read(): FollowRecord | null;
  /** True when the file exists, readable or not: a follower whose record is damaged is still not a master. */
  present(): boolean;
  write(rec: FollowRecord): void;
  /** Master addresses learned later (the master moved); the rest of the record stays. */
  setAddresses(addresses: string[]): void;
  clear(): void;
}

/** `dataDir` null: kept in memory (tests and a box with no data folder). */
export function createFollowStore(dataDir: string | null, identity: BoxIdentity, boxId: string): FollowStore {
  const aad = `follow|${boxId}`;
  let mem: FollowRecord | null = null;
  let cache: { raw: string; rec: FollowRecord | null } | null = null;
  const path = dataDir === null ? null : join(secretDir(dataDir), FILE);

  const read = (): FollowRecord | null => {
    if (path === null) return mem;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      cache = null;
      return null;
    }
    if (cache !== null && cache.raw === raw) return cache.rec;
    let rec: FollowRecord | null = null;
    try {
      const sealed = (JSON.parse(raw) as { sealed?: unknown }).sealed;
      rec = parseFollowRecord(JSON.parse(openWithBoxKey(identity.privateJwk, String(sealed), LABEL, aad, SEALED)));
    } catch {
      rec = null;
    }
    cache = { raw, rec };
    return rec;
  };

  const write = (rec: FollowRecord): void => {
    const clean = parseFollowRecord(rec);
    if (clean === null) throw new Error('follow: bad record');
    if (path === null) {
      mem = clean;
      return;
    }
    mkdirSync(secretDir(dataDir!), { recursive: true });
    const body = JSON.stringify({ v: 1, sealed: sealToBoxKey(identity.publicJwk, JSON.stringify(clean), LABEL, aad) });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
    cache = null;
  };

  return {
    read,
    present: () => (path === null ? mem !== null : existsSync(path)),
    write,
    setAddresses(addresses) {
      const cur = read();
      if (cur === null) return;
      const list = [...new Set(addresses.filter(isOrigin))].slice(0, 8);
      if (list.length > 0) write({ ...cur, addresses: list });
    },
    clear() {
      mem = null;
      cache = null;
      if (path !== null) rmSync(path, { force: true });
    },
  };
}
