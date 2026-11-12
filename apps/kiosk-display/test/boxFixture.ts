import { encodeBoxQr, keyFingerprint } from '@surau/core';
import type { BoxQrPayload, BoxStateView } from '@surau/core';

const pub = { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43) } as const;
export const KEY_FP = keyFingerprint(pub);

/** A payload the strict parser accepts. The signature is never checked on the kiosk, so any 86 symbols do. */
export function qrPayload(over: Partial<BoxQrPayload> = {}): string {
  return encodeBoxQr({
    v: 1,
    type: 'setup',
    boxId: '4f2a9c1e77b0d3a1',
    keyFp: KEY_FP,
    name: 'MAXCOM 4F2A',
    box: 'https://10.168.1.20:8443',
    caSha256: 'c'.repeat(64),
    linked: false,
    nonce: 'n'.repeat(43),
    iat: 1_795_000_000,
    exp: 1_795_000_600,
    pub,
    sig: 's'.repeat(86),
    ...over,
  });
}

export function boxView(over: Partial<BoxStateView> = {}): BoxStateView {
  return {
    boxId: '4f2a9c1e77b0d3a1',
    keyFp: KEY_FP,
    pub,
    name: 'MAXCOM 4F2A',
    state: 'setup',
    reason: 'none',
    linked: false,
    https: true,
    caSha256: 'c'.repeat(64),
    serverTime: '2026-11-03T07:52:00Z',
    surauName: null,
    appDownloadUrl: '',
    ...over,
  };
}
