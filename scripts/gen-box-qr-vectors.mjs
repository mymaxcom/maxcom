// Regenerates packages/core/test/fixtures/box-qr-vectors.json (random TEST key, differs every run).
// Usage (worktree root): node scripts/gen-box-qr-vectors.mjs
// The Dart side copies the result through scripts/gen-app-fixtures.mjs.
import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, boxQrMessage, keyFingerprint, encodeBoxQr } from '../packages/core/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const priv = privateKey.export({ format: 'jwk' });
const pub = { kty: 'EC', crv: 'P-256', x: priv.x, y: priv.y };
const keyFp = keyFingerprint(pub);
const boxId = createHash('sha256').update('test-box-key').digest('hex').slice(0, 16);
const nonce = () => randomBytes(32).toString('base64url');

const cases = [
  ['setup, https, unlinked', { type: 'setup', name: 'MAXCOM 4F2A', box: 'https://10.168.0.20:8443', caSha256: 'a'.repeat(64), linked: false }],
  ['recovery, https, linked with cloud', { type: 'recovery', name: 'MAXCOM Dewan Utama', box: 'https://10.168.0.20:8443', caSha256: 'b'.repeat(64), linked: true, cloud: 'https://api.mymaxcom.my' }],
  ['probe, https, unlinked', { type: 'probe', name: 'MAXCOM 4F2A', box: 'https://10.0.0.5:8443', caSha256: 'c'.repeat(64), linked: false }],
  ['setup, unicode name', { type: 'setup', name: 'Surau Al-Ikhlās · Taman Ṣāliḥ 😀', box: 'https://10.168.1.2:8443', caSha256: 'd'.repeat(64), linked: false }],
  ['setup, box empty (no https), no CA', { type: 'setup', name: 'MAXCOM 0000', box: '', caSha256: null, linked: false }],
  ['recovery, box empty, linked with cloud', { type: 'recovery', name: 'MAXCOM 9A9A', box: '', caSha256: null, linked: true, cloud: 'https://api.mymaxcom.my' }],
  ['probe, no cloud key', { type: 'probe', name: 'x', box: 'https://box.local:8443', caSha256: 'e'.repeat(64), linked: false }],
  ['setup, name 60 chars', { type: 'setup', name: 'N'.repeat(60), box: 'https://10.168.0.20:8443', caSha256: 'f'.repeat(64), linked: false }],
  ['recovery, unlinked, cloud absent', { type: 'recovery', name: 'MAXCOM 1234', box: 'https://10.168.0.20:8443', caSha256: '0'.repeat(64), linked: false }],
  ['probe, linked', { type: 'probe', name: 'MAXCOM 4F2A', box: 'https://10.168.0.20:8443', caSha256: '1'.repeat(64), linked: true, cloud: 'https://api.mymaxcom.my' }],
];

const out = cases.map(([name, f], i) => {
  const base = { v: 1, boxId, keyFp, nonce: nonce(), iat: 1795000000 + i, exp: 1795000600 + i, pub, ...f };
  const message = boxQrMessage(base);
  const sig = sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const payload = { ...base, sig };
  return {
    name,
    payload,
    text: encodeBoxQr(payload),
    canonicalWithoutSig: canonicalJson(base),
    messageHex: Buffer.from(message).toString('hex'),
    keyFp,
  };
});

writeFileSync(
  join(root, 'packages', 'core', 'test', 'fixtures', 'box-qr-vectors.json'),
  JSON.stringify(
    {
      note: 'TEST KEY ONLY. Pinned by packages/core/test/boxQr.test.ts; the Dart side must verify the same bytes. iat/exp are Unix seconds. message = utf8("maxcom-qr\\n<boxId>\\n<type>\\n<sha256 hex of canonicalWithoutSig>"). sig = base64url ECDSA P-256 r||s (ieee-p1363).',
      testPrivateJwk: { ...pub, d: priv.d },
      cases: out,
    },
    null,
    2,
  ) + '\n',
);
console.log('wrote', out.length, 'vectors');
