import type { JsonWebKey } from '../auth/crypto.ts';
import { SEAL_VERSION, openWithBoxKey, sealToBoxKey } from './boxSeal.ts';

/**
 * The seal of a camera address sent to a box through the cloud ("Kamera luaran" set from anywhere). SECURITY code.
 *
 * ECIES on the box's own P-256 sync key pair (`boxSeal.ts`, shared with the YouTube handover under another label):
 * the public half is already on the cloud's site row, the private half is sealed in the box's `sync.key`. The cloud
 * stores and relays the value only; it holds no key that opens it. The associated text binds the value to one box
 * and one number (`maxcom-camera-relay-v1|<boxId>|<seq>`), so a blob cannot be played to another box or under
 * another number.
 *
 * Wire form `e1.<ephemeral public point, 65 bytes>.<iv, 12>.<ciphertext>.<tag, 16>`, each part base64url.
 * The phone's Dart twin is `lib/sync/camera_relay_seal.dart`; a fixed vector keeps the two honest.
 */

export const RELAY_VERSION = SEAL_VERSION;
const INFO = 'maxcom-camera-relay-v1';

export const relayAad = (boxId: string, seq: number): string => `${INFO}|${boxId}|${seq}`;

/** The shape of a sealed value, checked by the cloud without opening it. */
export const SEALED_RE = /^e1\.[A-Za-z0-9_-]{87}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,1400}\.[A-Za-z0-9_-]{22}$/;

/** Seals [plaintext] to the box's public JWK. Tests and tools; the phone has its own twin. */
export function sealToBox(publicJwk: JsonWebKey, plaintext: string, aad: string): string {
  return sealToBoxKey(publicJwk, plaintext, INFO, aad);
}

/** Opens a sealed value with the box's private JWK. Throws a fixed `relay: cannot open` on any fault. Never logs. */
export function openFromCloud(privateJwk: JsonWebKey, sealed: string, aad: string): string {
  try {
    return openWithBoxKey(privateJwk, sealed, INFO, aad, SEALED_RE);
  } catch {
    throw new Error('relay: cannot open');
  }
}
