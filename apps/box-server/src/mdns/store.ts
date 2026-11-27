import { closeSync, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_BOX_NUMBER } from './answerer.ts';

/** The persisted claim: number n (1..99), when it was first claimed (ISO) and the renumbers of the last day (epoch seconds). */
export interface StoredName {
  n: number;
  claimedAt: string;
  renumbers: number[];
}

export const MAX_RENUMBERS_PER_DAY = 3;
const DAY_S = 86_400;
const MAX_BYTES = 1024;
const MAX_STORED = 16;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,16}Z$/;

/**
 * `<data folder>/box-name.json`: `{"n":1,"claimedAt":"2026-11-14T10:00:00Z","renumbers":[1794650000]}`, the same file
 * the Android box keeps. The optional `renumbers` array holds epoch seconds of the renumbers done in the last 24 hours
 * (the cap is MAX_RENUMBERS_PER_DAY). Read strictly (a damaged, oversized, linked or odd file is "no name", never a
 * guess), written as a temporary file then a rename, so a power cut leaves the old value or the new one.
 *
 * The box service writes this file and the certificate renewal (which runs as SYSTEM) reads it, so the reader keeps
 * to the plain shape above: only `n` matters to the renewal, and it is checked there again.
 */
export class BoxNameStore {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  read(): StoredName | null {
    let text: string;
    try {
      // never follow a link and never read more than the cap
      const st = lstatSync(this.file);
      if (!st.isFile() || st.size > MAX_BYTES) return null;
      const fd = openSync(this.file, 'r');
      try {
        if (fstatSync(fd).size > MAX_BYTES) return null;
        const buf = Buffer.alloc(MAX_BYTES);
        const got = readSync(fd, buf, 0, MAX_BYTES, 0);
        text = buf.toString('utf8', 0, got);
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
    const o = j as Record<string, unknown>;
    if (typeof o.n !== 'number' || !Number.isInteger(o.n) || o.n < 1 || o.n > MAX_BOX_NUMBER) return null;
    if (typeof o.claimedAt !== 'string' || !ISO.test(o.claimedAt) || Number.isNaN(Date.parse(o.claimedAt))) return null;
    let renumbers: number[] = [];
    if (o.renumbers !== undefined) {
      if (!Array.isArray(o.renumbers)) return null;
      renumbers = o.renumbers.filter((t): t is number => typeof t === 'number' && Number.isSafeInteger(t) && t >= 0).slice(0, MAX_STORED);
    }
    return { n: o.n, claimedAt: o.claimedAt, renumbers };
  }

  private write(n: number, claimedAt: string, renumbers: number[]): void {
    if (!Number.isInteger(n) || n < 1 || n > MAX_BOX_NUMBER) throw new RangeError('box number must be 1..99');
    const tail = renumbers.length === 0 ? '' : `,"renumbers":[${renumbers.join(',')}]`;
    const json = `{"n":${n},"claimedAt":"${claimedAt}"${tail}}\n`;
    const tmp = join(dirname(this.file), `.box-name.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, json, { encoding: 'ascii', mode: 0o644 });
      renameSync(tmp, this.file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to remove */
      }
      throw error;
    }
  }

  /** How many renumbers are recorded within 24 hours before now. */
  renumbersInLastDay(now: Date): number {
    const cutoff = Math.floor(now.getTime() / 1000) - DAY_S;
    return this.read()?.renumbers.filter((t) => t > cutoff).length ?? 0;
  }

  /**
   * The renumber cap: when fewer than MAX_RENUMBERS_PER_DAY renumbers happened in the last 24 hours, records one at
   * now and returns true; otherwise records nothing and returns false. With no stored name the box has never claimed
   * one, so there is nothing to cap and the first claim is allowed.
   */
  tryRecordRenumber(now: Date): boolean {
    const cur = this.read();
    if (cur === null) return true;
    const nowS = Math.floor(now.getTime() / 1000);
    const cutoff = nowS - DAY_S;
    // an entry in the future (the clock was wrong when it was written) still counts: the cap errs safe
    const recent = cur.renumbers.filter((t) => t > cutoff);
    if (recent.length >= MAX_RENUMBERS_PER_DAY) return false;
    this.write(cur.n, cur.claimedAt, [...recent, nowS]);
    return true;
  }

  /** Stores the claimed number; claimedAt changes only when the number does; the renumber record is kept. */
  persistClaim(n: number, now: Date): void {
    const cur = this.read();
    if (cur?.n === n) return;
    this.write(n, now.toISOString().replace(/\.\d{3}Z$/, 'Z'), cur?.renumbers ?? []);
  }
}
