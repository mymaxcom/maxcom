import type { JsonWebKey } from '../auth/crypto.ts';
import { openWithBoxKey, sealToBoxKey, sealedRe } from './boxSeal.ts';

/**
 * The one value the cloud seals to ONE linked box for YouTube: the operator's OAuth client file (D2), delivered to a
 * linked box (`maxcom-youtube-client-v1|<boxId>`). SECURITY code. (Until 2026.11.15 the grant the cloud held was
 * handed over the same way, under its own label; the cloud holds none now, so that half is gone.)
 *
 * It has its own label (a different HKDF domain from the camera relay), so a value sealed for another use never opens
 * as this one, and the box id in the associated text keeps it from opening on another box.
 */

const CLIENT = 'maxcom-youtube-client-v1';

export const clientAad = (boxId: string): string => `${CLIENT}|${boxId}`;

/** The longest client file (plaintext bytes) the cloud seals and a box opens: one limit for both (M4). Well under the sealed cap. */
export const CLIENT_FILE_MAX = 4096;

/** The shape of a sealed YouTube value (an OAuth client file fits well under 8 KB). */
export const YOUTUBE_SEALED_RE = sealedRe(8192);

export const sealClient = (jwk: JsonWebKey, plaintext: string, boxId: string): string => sealToBoxKey(jwk, plaintext, CLIENT, clientAad(boxId));
export const openClient = (jwk: JsonWebKey, sealed: string, boxId: string): string => openWithBoxKey(jwk, sealed, CLIENT, clientAad(boxId), YOUTUBE_SEALED_RE);
