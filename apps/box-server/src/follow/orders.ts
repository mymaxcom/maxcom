import type { FollowRecord } from './store.ts';
import type { BoxIdentity } from '../setup/identity.ts';
import { verifyLink } from '../link/sign.ts';
import { openWithBoxKey, sealedRe } from '../sync/boxSeal.ts';
import { ORDER_LABEL, orderAad } from '../link/unlink.ts';
import type { OrderSecret } from '../link/unlink.ts';

/**
 * The orders a follower accepts from its master. SECURITY code.
 *
 * A follower obeys nothing but TV data it asked for and an order signed by the identity key it stored at link time,
 * for its own box id and its own link. The answer of an unknown or copied master cannot pass: the signature is checked
 * against `masterPub` from the sealed follow record, never against a key the answer brings along.
 *
 * - `forget`: "you were taken off this surau: empty yourself and return to first setup" (also the unlink's "Kosongkan
 *   kotak ini" for a follower that was a new box). No data.
 * - `revert` ("Kembali ke data sebelum dipautkan") and `standalone` ("Teruskan dengan data sekarang"), from an unlink:
 *   the body names the unlink and carries, sealed to THIS box's identity key, the join ticket of the person who answered
 *   for this box (`OrderSecret`). A body that does not open with this box's key is no order.
 */
export type FollowOrder =
  | { order: 'forget'; linkId: string }
  | { order: 'revert' | 'standalone'; linkId: string; unlinkId: string; secret: OrderSecret };

const SEALED = sealedRe(16 * 1024);
const HEX32 = /^[0-9a-f]{32}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseSecret(v: unknown, choice: 'back' | 'carry-on', masterBoxId: string): OrderSecret | null {
  if (!isObj(v) || v.v !== 1 || v.choice !== choice || typeof v.ticket !== 'string' || v.ticket.length < 6 || v.ticket.length > 20) return null;
  if (typeof v.ticketExpiresAt !== 'string' || Number.isNaN(Date.parse(v.ticketExpiresAt)) || typeof v.dropYoutube !== 'boolean') return null;
  const p = v.person;
  if (!isObj(p) || typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 120) return null;
  if (p.peerUserId !== null && (typeof p.peerUserId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.peerUserId))) return null;
  if (p.phone !== null && (typeof p.phone !== 'string' || p.phone.length > 32)) return null;
  const m = v.master;
  if (!isObj(m) || m.boxId !== masterBoxId || typeof m.name !== 'string' || !Array.isArray(m.addresses) || m.addresses.length > 8) return null;
  const addresses = m.addresses.filter((a): a is string => typeof a === 'string' && /^https:\/\/[^\s/]{1,200}$/.test(a));
  return {
    v: 1, choice, ticket: v.ticket, ticketExpiresAt: v.ticketExpiresAt, dropYoutube: v.dropYoutube,
    person: { peerUserId: p.peerUserId as string | null, name: p.name, phone: p.phone as string | null },
    master: { boxId: masterBoxId, name: m.name.slice(0, 60), addresses },
  };
}

export function verifyOrder(rec: FollowRecord, ownBoxId: string, answer: unknown, identity?: BoxIdentity): FollowOrder | null {
  if (!isObj(answer)) return null;
  const a = answer;
  const body = a.body;
  if (!isObj(body)) return null;
  const b = body;
  if (a.order === 'forget') {
    // Exactly the three fields the master signs: this box, this link, that master.
    if (Object.keys(b).sort().join() !== 'boxId,linkId,masterBoxId') return null;
    if (b.boxId !== ownBoxId || b.linkId !== rec.linkId || b.masterBoxId !== rec.masterBoxId) return null;
    if (!verifyLink(rec.masterPub, 'order-forget', rec.linkId, body, a.sig)) return null;
    return { order: 'forget', linkId: rec.linkId };
  }
  if ((a.order !== 'revert' && a.order !== 'standalone') || identity === undefined) return null;
  if (Object.keys(b).sort().join() !== 'boxId,linkId,masterBoxId,sealed,unlinkId') return null;
  if (b.boxId !== ownBoxId || b.linkId !== rec.linkId || b.masterBoxId !== rec.masterBoxId) return null;
  if (typeof b.unlinkId !== 'string' || !HEX32.test(b.unlinkId) || typeof b.sealed !== 'string') return null;
  const step = a.order === 'revert' ? 'order-revert' : 'order-standalone';
  if (!verifyLink(rec.masterPub, step, rec.linkId, body, a.sig)) return null;
  let secret: OrderSecret | null;
  try {
    secret = parseSecret(
      JSON.parse(openWithBoxKey(identity.privateJwk, b.sealed, ORDER_LABEL, orderAad(b.unlinkId, ownBoxId, rec.masterBoxId), SEALED)),
      a.order === 'revert' ? 'back' : 'carry-on', rec.masterBoxId,
    );
  } catch {
    return null;
  }
  if (secret === null) return null;
  return { order: a.order, linkId: rec.linkId, unlinkId: b.unlinkId, secret };
}
