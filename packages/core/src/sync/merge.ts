/** The merge rule: which of two edits to one entity wins. Pure, so the box, the cloud and the app agree. */

import type { OpKind } from './types.ts';

export type MergeReason = 'new' | 'newer' | 'older' | 'tie_lost' | 'tie_won' | 'tombstoned' | 'already_revoked';

export interface MergeCurrent {
  rev: string;
  editedAt: string;
  deviceId: string | null;
  deletedAt: string | null;
  revokedAt?: string | null;
}

export interface MergeInput {
  kind: OpKind;
  current: MergeCurrent | null;
  op: { editedAt: string; deviceId: string };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The instant (ms since epoch) of a strict ISO-8601 time with a zone, else null. Every time that reaches a merge decision must pass this. */
export function isoInstantMs(text: unknown): number | null {
  if (typeof text !== 'string' || text.length > 40 || !ISO_INSTANT.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * -1, 0 or 1. ISO times compare as instants. TOTAL on purpose, so a stray value cannot throw: text that is
 * not a date falls back to plain text order. Callers never rely on that fallback for a decision: device ops
 * and feed entries are refused unless `isoInstantMs` accepts their time, and stored times are our own ISO.
 */
function cmpTime(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? -1 : a > b ? 1 : 0;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Which of two edits to one entity wins. Order-independent: for any two edits A and B, applying A then B
 * leaves the same row as B then A. Content puts and deletes compete alike by edit time (latest edit wins;
 * a same-instant tie goes to the lexically greater device id; on the very same stamp a delete beats a put).
 * A tombstone is a row whose last edit was a delete: a newer delete replaces an older tombstone, an older
 * one leaves it. Revoking a device is monotonic: it always lands, once.
 */
export function decide(input: MergeInput): { apply: boolean; reason: MergeReason } {
  const { kind, current, op } = input;
  if (current === null) return { apply: true, reason: 'new' };

  if (kind === 'device.revoke') {
    return current.revokedAt ? { apply: false, reason: 'already_revoked' } : { apply: true, reason: 'newer' };
  }

  const tomb = current.deletedAt !== null && current.deletedAt !== undefined && current.deletedAt !== '';
  const c = cmpTime(op.editedAt, current.editedAt);
  if (c > 0) return { apply: true, reason: 'newer' };
  if (c === 0) {
    const mine = op.deviceId;
    const theirs = current.deviceId ?? '';
    if (mine > theirs) return { apply: true, reason: 'tie_won' };
    // The very same stamp (one device, one instant): a delete outranks a put, so both orders agree.
    if (mine === theirs && kind === 'content.delete' && !tomb) return { apply: true, reason: 'tie_won' };
  }
  if (tomb) return { apply: false, reason: 'tombstoned' };
  return { apply: false, reason: c < 0 ? 'older' : 'tie_lost' };
}

/** Sortable, human-readable revision of an edit. */
export function newRev(editedAt: string, deviceId: string): string {
  return `${editedAt}|${deviceId}`;
}
