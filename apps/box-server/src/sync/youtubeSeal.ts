import type { JsonWebKey } from '../auth/crypto.ts';
import { openWithBoxKey, sealToBoxKey, sealedRe } from './boxSeal.ts';

/**
 * The two values the cloud seals to ONE linked box for YouTube (release 2026.11.13). SECURITY code.
 *
 *  - the grant the cloud held before this release, handed over once (`maxcom-youtube-handover-v1|<boxId>|<handoverId>`);
 *  - the operator's OAuth client file (D2), delivered to a linked box (`maxcom-youtube-client-v1|<boxId>`).
 *
 * Each has its own label (a different HKDF domain from the camera relay and from each other), so a value sealed for
 * one use never opens as another, and the box id in the associated text keeps it from opening on another box.
 */

const HANDOVER = 'maxcom-youtube-handover-v1';
const CLIENT = 'maxcom-youtube-client-v1';

export const handoverAad = (boxId: string, handoverId: string): string => `${HANDOVER}|${boxId}|${handoverId}`;
export const clientAad = (boxId: string): string => `${CLIENT}|${boxId}`;

/** The longest client file (plaintext bytes) the cloud seals and a box opens: one limit for both (M4). Well under the sealed cap. */
export const CLIENT_FILE_MAX = 4096;

/** The shape of a sealed YouTube value (a refresh token or an OAuth client file fit well under 8 KB). */
export const YOUTUBE_SEALED_RE = sealedRe(8192);

export const sealHandover = (jwk: JsonWebKey, plaintext: string, boxId: string, handoverId: string): string => sealToBoxKey(jwk, plaintext, HANDOVER, handoverAad(boxId, handoverId));
export const openHandover = (jwk: JsonWebKey, sealed: string, boxId: string, handoverId: string): string => openWithBoxKey(jwk, sealed, HANDOVER, handoverAad(boxId, handoverId), YOUTUBE_SEALED_RE);
export const sealClient = (jwk: JsonWebKey, plaintext: string, boxId: string): string => sealToBoxKey(jwk, plaintext, CLIENT, clientAad(boxId));
export const openClient = (jwk: JsonWebKey, sealed: string, boxId: string): string => openWithBoxKey(jwk, sealed, CLIENT, clientAad(boxId), YOUTUBE_SEALED_RE);
