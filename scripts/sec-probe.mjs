#!/usr/bin/env node
// Black-box security probes against a running box server (Plan 3 Task 10).
//
//   node scripts/sec-probe.mjs                      start a throw-away server on 127.0.0.1 and probe it
//   node scripts/sec-probe.mjs https://127.0.0.1:8443 [--ca data/pki/root-ca.cer] [--http http://127.0.0.1:8787]
//                                                    probe a running box (anonymous probes only; the
//                                                    signed-in probes need the self-started server)
//
// Prints a PASS/FAIL table; exit 1 on any FAIL. Only ever talks to loopback addresses.
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { connect as netConnect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a) => /^https?:\/\//.test(a));
const caFile = flag('--ca');
const httpOpt = flag('--http');

const results = [];
const check = (area, name, ok, detail = '') => results.push({ area, name, ok: Boolean(ok), detail: ok ? '' : String(detail) });

function assertLoopback(urlText) {
  const h = new URL(urlText).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(h)) throw new Error(`refusing to probe non-loopback host ${h}`);
}

/** Raw HTTP/1.1 request; nothing normalises the path or the headers. */
function raw(base, o) {
  const u = new URL(base);
  const secure = u.protocol === 'https:';
  const port = Number(u.port || (secure ? 443 : 80));
  return new Promise((resolveRes, reject) => {
    const lines = [`${o.method ?? 'GET'} ${o.path} HTTP/1.1`];
    if (o.host !== null) lines.push(`Host: ${o.host ?? u.hostname}`);
    for (const [k, v] of Object.entries(o.headers ?? {})) lines.push(`${k}: ${v}`);
    const body = o.body === undefined ? Buffer.alloc(0) : Buffer.from(o.body);
    if (body.length) lines.push(`Content-Length: ${body.length}`);
    lines.push('Connection: close', '', '');
    const head = Buffer.from(lines.join('\r\n'), 'latin1');
    const chunks = [];
    const sock = secure
      ? tlsConnect({ host: u.hostname, port, ...(caFile ? { ca: readFileSync(caFile) } : { rejectUnauthorized: false }) })
      : netConnect({ host: u.hostname, port });
    sock.setTimeout(15000, () => sock.destroy(new Error('timeout')));
    const go = () => {
      sock.write(head);
      if (body.length) sock.write(body);
    };
    sock.on(secure ? 'secureConnect' : 'connect', go);
    sock.on('data', (c) => chunks.push(c));
    let failure = null;
    sock.on('error', (e) => (failure = e));
    sock.on('close', () => {
      const all = Buffer.concat(chunks);
      if (all.length === 0 && failure) return reject(failure);
      const i = all.indexOf('\r\n\r\n');
      if (i < 0) return resolveRes({ status: 0, headers: {}, body: all });
      const hl = all.subarray(0, i).toString('latin1').split('\r\n');
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(hl[0])?.[1] ?? 0);
      const headers = {};
      for (const l of hl.slice(1)) {
        const k = l.indexOf(':');
        if (k > 0) headers[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim();
      }
      resolveRes({ status, headers, body: all.subarray(i + 4) });
    });
  });
}

const j = (r) => {
  try {
    return JSON.parse(r.body.toString());
  } catch {
    return {};
  }
};
const LEAK = /SQLITE|node:sqlite|node_modules|\bat (?:async )?[\w$.<>]+ \(|\b[A-Za-z]:[\\/][\w.-]+[\\/]|\/Users\/|\/home\/|\.(?:ts|js|mjs):\d+|\bENOENT\b/i;

async function main() {
  let base = target;
  let httpBase = httpOpt;
  let started = null;
  let dir = null;
  let seeded = null; // { signedIn(role) }

  if (!base) {
    const { startListeners } = await import(pathToFileURL(join(root, 'apps/box-server/src/main.ts')).href);
    const { loadTls } = await import(pathToFileURL(join(root, 'apps/box-server/src/tls.ts')).href);
    const { createUser } = await import(pathToFileURL(join(root, 'apps/box-server/src/auth/users.ts')).href);
    const { beginEnrolment } = await import(pathToFileURL(join(root, 'apps/box-server/src/auth/devices.ts')).href);
    dir = mkdtempSync(join(tmpdir(), 'surau-secprobe-'));
    mkdirSync(join(dir, 'secret'));
    mkdirSync(join(dir, 'pki'));
    const fx = join(root, 'apps/box-server/test/fixtures');
    cpSync(join(fx, 'test-box.pfx'), join(dir, 'secret', 'box.pfx'));
    writeFileSync(join(dir, 'secret', 'pfx.pass'), 'test');
    cpSync(join(fx, 'test-box-leaf.cer'), join(dir, 'pki', 'box-leaf.cer'));
    const staticDir = join(dir, 'dist');
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><body><div id="app"></div></body></html>');
    writeFileSync(join(staticDir, 'sw.js'), '// sw');
    const tls = loadTls(dir, new Date());
    started = await startListeners({
      dbPath: join(dir, 'surau.db'),
      dataDir: dir,
      staticDir,
      tls,
      plan: { http: { host: '127.0.0.1', port: 0 }, https: { host: '127.0.0.1', port: 0 }, warnings: [] },
      env: {},
    });
    base = `https://127.0.0.1:${started.httpsPort}`;
    httpBase = `http://127.0.0.1:${started.httpPort}`;
    const { completeEnrolment } = await import(pathToFileURL(join(root, 'apps/box-server/src/auth/devices.ts')).href);
    const { putFeature, getSettings } = await import(pathToFileURL(join(root, 'apps/box-server/src/settingsStore.ts')).href);
    const app = started.app;
    const PIN = '482916';
    let n = 0;
    seeded = {
      // Plan 5 Task 0A: with the app lock off, the device key alone must still be enough AND still be required.
      // Runs in-process (own client addresses) so the shared per-address limiter of the network probes is not used up.
      async appLockProbes() {
        const { db, boxId } = app.surau;
        let k = 0;
        const make = async (pin) => {
          k++;
          const ip = `10.99.1.${k}`;
          const user = createUser(db, { name: `Lock ${k}`, roles: ['ajk'] }, 'probe');
          const { code } = beginEnrolment(db, { userId: user.id, deviceName: `Lock ${k}` }, 'probe');
          const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
          const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
          const dev = completeEnrolment(db, { code, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, platform: 'web', ...(pin ? { pin } : {}) }, ip);
          const post = (url, payload) => app.inject({ method: 'POST', url, remoteAddress: ip, payload });
          const challenge = async () => (await post('/api/auth/challenge', { deviceId: dev.deviceId })).json().nonce;
          const sign = async (nonce) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`surau-unlock\n${boxId}\n${dev.deviceId}\n${nonce}`))).toString('base64url');
          const unlock = async (extra = {}, o = {}) => {
            const nonce = o.nonce ?? (await challenge());
            const signature = o.signature ?? (await sign(nonce));
            const r = await post('/api/auth/unlock', { deviceId: dev.deviceId, nonce, signature, ...extra });
            return { status: r.statusCode, body: r.json() };
          };
          const fails = () => Number(db.prepare('SELECT pin_fail_count AS n FROM users WHERE id = ?').get(user.id).n);
          return { dev, user, unlock, challenge, sign, fails };
        };
        const A = '4 app lock';
        check(A, 'the lock is off by default on a new box', getSettings(db).appLock.enabled === false, '');
        const d = await make(PIN);
        const ok = await d.unlock({});
        check(A, 'lock off: a good signature with no PIN opens a session', ok.status === 200 && typeof ok.body.token === 'string', ok.status);
        const nonce = await d.challenge();
        const first = await d.unlock({}, { nonce });
        const again = await d.unlock({}, { nonce });
        check(A, 'lock off: a replayed nonce is refused', first.status === 200 && again.status === 401 && !again.body.token, `${first.status}/${again.status}`);
        const n2 = await d.challenge();
        const good = Buffer.from(await d.sign(n2), 'base64url');
        good[7] ^= 0xff;
        const forged = await d.unlock({}, { nonce: n2, signature: good.toString('base64url') });
        check(A, 'lock off: a forged signature is refused', forged.status === 401 && !forged.body.token, forged.status);
        const other = await make(PIN);
        const n3 = await d.challenge();
        const cross = await d.unlock({}, { nonce: n3, signature: await other.sign(n3) });
        check(A, "lock off: another device's key cannot sign for this device", cross.status === 401 && !cross.body.token, cross.status);
        const rv = await make(PIN);
        const n4 = await rv.challenge();
        const sig4 = await rv.sign(n4);
        db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), rv.dev.deviceId);
        const revoked = await rv.unlock({}, { nonce: n4, signature: sig4 });
        check(A, 'lock off: a revoked device is refused', revoked.status === 401 && !revoked.body.token, revoked.status);
        const gone = await make(PIN);
        const n5 = await gone.challenge();
        const sig5 = await gone.sign(n5);
        db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone.user.id);
        const inactive = await gone.unlock({}, { nonce: n5, signature: sig5 });
        check(A, 'lock off: a deactivated user is refused', inactive.status === 401 && !inactive.body.token, inactive.status);
        const wrong = await make(PIN);
        await wrong.unlock({ pin: '000000' });
        check(A, 'lock off: no PIN attempt is counted', wrong.fails() === 0, wrong.fails());
        putFeature(db, 'appLock', { enabled: true }, 'probe');
        try {
          const need = await make(PIN);
          const miss = await need.unlock({});
          check(A, 'lock on: no PIN field is 401 pin_missing and is never counted', miss.status === 401 && miss.body.code === 'pin_missing' && need.fails() === 0, `${miss.status}/${miss.body.code}/${need.fails()}`);
          const bad = await need.unlock({ pin: '000000' });
          check(A, 'lock on: a wrong PIN is still counted', bad.status === 401 && need.fails() === 1, `${bad.status}/${need.fails()}`);
          const n6 = await need.challenge();
          const unsigned = await need.unlock({ pin: PIN }, { nonce: n6, signature: 'A'.repeat(86) });
          check(A, 'lock on: the right PIN without the device key is refused', unsigned.status === 401 && !unsigned.body.token, unsigned.status);
        } finally {
          putFeature(db, 'appLock', { enabled: false }, 'probe');
        }
      },
      // Plan 6 Task 3: signed device ops and site identity. In-process (own client addresses), like the app-lock probes.
      async syncProbes() {
        const { db, boxId } = app.surau;
        const { opMessage } = await import(pathToFileURL(join(root, 'packages/core/src/index.ts')).href);
        const S = '15 sync';
        let k = 0;
        const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        const ulid = () => Array.from(randomBytes(26), (b) => CROCK[b % 32]).join('');
        const make = async (role) => {
          k++;
          const ip = `10.98.1.${k}`;
          const user = createUser(db, { name: `Sync ${role} ${k}`, roles: [role] }, 'probe');
          const { code } = beginEnrolment(db, { userId: user.id, deviceName: `Sync ${k}` }, 'probe');
          const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
          const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
          const dev = completeEnrolment(db, { code, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, platform: 'web', pin: PIN }, ip);
          const post = (url, payload, headers = {}) => app.inject({ method: 'POST', url, remoteAddress: ip, headers, payload });
          const sign = async (msg) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, msg)).toString('base64url');
          const nonce = (await post('/api/auth/challenge', { deviceId: dev.deviceId })).json().nonce;
          const sig = await sign(new TextEncoder().encode(`surau-unlock\n${boxId}\n${dev.deviceId}\n${nonce}`));
          const token = (await post('/api/auth/unlock', { deviceId: dev.deviceId, nonce, signature: sig, pin: PIN })).json().token;
          const headers = { authorization: `Bearer ${token}` };
          const op = async (over = {}) => {
            const base = {
              v: 1, opId: ulid(), surauId: 'sdm', boxId, deviceId: dev.deviceId, userId: user.id, kind: 'content.put',
              entity: 'content:penceramah', entityId: `sp${k}`, baseRev: null, editedAt: new Date(Date.now() - 60_000).toISOString(),
              payload: { name: 'Probe' }, ...over,
            };
            return { ...base, sig: await sign(opMessage(base)) };
          };
          const send = (ops, h = headers) => app.inject({ method: 'POST', url: '/api/sync/ops', remoteAddress: ip, headers: h, payload: { ops } });
          return { dev, user, token, headers, op, send, ip };
        };
        const seen = (opId) => Number(db.prepare('SELECT COUNT(*) AS n FROM applied_ops WHERE op_id = ?').get(opId).n);
        const rows = () => Number(db.prepare("SELECT COUNT(*) AS n FROM auth_log WHERE event = 'sync_refused'").get().n);
        const first = (r) => r.json().results?.[0];

        const a = await make('admin');
        const good = await a.op();
        const r1 = await a.send([good]);
        check(S, 'a correctly signed op from a live device is applied', r1.statusCode === 200 && first(r1)?.status === 'applied', `${r1.statusCode}`);
        const r2 = await a.send([good]);
        check(S, 'the same signed op sent again is a duplicate (replay)', first(r2)?.status === 'duplicate', first(r2)?.status);

        const before = rows();
        const forged = await a.op();
        const raw64 = Buffer.from(forged.sig, 'base64url');
        raw64[3] ^= 0xff;
        const r3 = await a.send([{ ...forged, sig: raw64.toString('base64url') }]);
        check(S, 'a forged signature is refused bad_signature, nothing recorded, one auth_log row', first(r3)?.reason === 'bad_signature' && seen(forged.opId) === 0 && rows() === before + 1, `${first(r3)?.reason}/${rows() - before}`);

        const foreign = await a.op({ boxId: 'ffffffffffffffff' });
        const r4 = await a.send([foreign]);
        check(S, 'an op for another box id is refused and nothing is recorded', first(r4)?.status === 'refused' && seen(foreign.opId) === 0, first(r4)?.status);

        const b = await make('admin');
        const mine = await a.op();
        const r5 = await b.send([mine]);
        check(S, "ops signed by device A over device B's session: 403 device_mismatch, nothing recorded", r5.statusCode === 403 && r5.json().code === 'device_mismatch' && seen(mine.opId) === 0, `${r5.statusCode}`);

        const aj = await make('ajk');
        const forb = await aj.op({ kind: 'settings.put', entity: 'settings', entityId: 'clock', payload: { show24h: true } });
        const r6 = await aj.send([forb]);
        check(S, 'an AJK settings.put is refused forbidden and nothing is recorded', first(r6)?.reason === 'forbidden' && seen(forb.opId) === 0, first(r6)?.reason);

        // Plan 12: MAXCOM system values and the Pentadbir MAXCOM role are out of an ordinary admin's reach, signed or not
        const sysOp = await a.op({ kind: 'settings.put', entity: 'settings', entityId: 'system', payload: { noVideoSeconds: 60 } });
        const rs = await a.send([sysOp]);
        check(S, 'an admin settings.put on the system feature is refused forbidden and nothing is recorded', first(rs)?.reason === 'forbidden' && seen(sysOp.opId) === 0, first(rs)?.reason);
        const ljOp = await a.op({ kind: 'settings.put', entity: 'settings', entityId: 'liveYoutube', payload: { relayVideo: 'reencode' } });
        const rl = await a.send([ljOp]);
        check(S, 'an admin op writing a Lanjutan field (relayVideo) is refused and nothing is recorded', first(rl)?.reason === 'forbidden' && seen(ljOp.opId) === 0, first(rl)?.reason);
        const grantOp = await a.op({ kind: 'user.put', entity: 'user', entityId: b.user.id, payload: { name: 'Promoted', roles: ['admin', 'superadmin'], active: true } });
        const rg = await a.send([grantOp]);
        const bRoles = JSON.parse(db.prepare('SELECT roles_json AS r FROM users WHERE id = ?').get(b.user.id).r);
        check(S, 'an admin op granting superadmin is refused and the roles are unchanged', first(rg)?.reason === 'forbidden' && seen(grantOp.opId) === 0 && !bRoles.includes('superadmin'), `${first(rg)?.reason} ${bRoles}`);

        const rv = await make('admin');
        const queued = await rv.op();
        db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), rv.dev.deviceId);
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ?').run(new Date().toISOString(), rv.dev.deviceId);
        const before2 = rows();
        const r7 = await rv.send([queued]);
        check(S, 'a revoked device is told device_revoked (401), nothing is recorded, one auth_log row', r7.statusCode === 401 && r7.json().reason === 'device_revoked' && seen(queued.opId) === 0 && rows() === before2 + 1, `${r7.statusCode}`);

        // Plan 7: forged finance ops. A foreign device, the wrong role and a closed month are all refused and leave no ledger row.
        {
          const FS = '16 finance sync';
          const finRows = () => Number(db.prepare('SELECT COUNT(*) AS n FROM finance_entries').get().n);
          const tr = await make('treasurer');
          putFeature(db, 'finance', { enabled: true }, 'probe');
          await app.inject({ method: 'GET', url: '/api/finance/funds', remoteAddress: tr.ip, headers: tr.headers });
          const fundId = db.prepare('SELECT id FROM finance_funds ORDER BY sort_order LIMIT 1').get()?.id;
          const perIn = db.prepare("SELECT id FROM finance_perihal WHERE direction = 'in' ORDER BY sort_order LIMIT 1").get()?.id;
          // the previous month, so closing it cannot disturb the signed-in probes that post today
          const prevDay = new Date(Date.now() + 8 * 3600e3);
          prevDay.setUTCDate(1);
          prevDay.setUTCMonth(prevDay.getUTCMonth() - 1);
          prevDay.setUTCDate(15);
          const today = prevDay.toISOString().slice(0, 10);
          const body = (o = {}) => ({ kind: 'in', entryDate: today, fundId, perihalId: perIn, amountSen: 4200, method: 'bank', reference: 'FPX777', ...o });
          const fin = (o, over = {}) => tr.op({ kind: 'finance.append', entity: 'finance:entry', payload: body(o), ...over });
          const base = finRows();
          const ok = await fin({}, { entityId: 'fp1' });
          const rok = await tr.send([ok]);
          check(FS, 'a signed finance.append from a treasurer device is applied', first(rok)?.status === 'applied' && finRows() === base + 1, first(rok)?.status);
          const ajk = await make('ajk');
          const bad = await ajk.op({ kind: 'finance.append', entity: 'finance:entry', entityId: 'fp2', payload: body() });
          const rbad = await ajk.send([bad]);
          check(FS, 'an AJK finance.append is refused forbidden and no ledger row appears', first(rbad)?.reason === 'forbidden' && finRows() === base + 1 && seen(bad.opId) === 0, first(rbad)?.reason);
          const mine = await fin({}, { entityId: 'fp3' });
          const viaOther = await ajk.send([mine]);
          check(FS, "a treasurer's finance op over an AJK session is 403 device_mismatch and no row appears", viaOther.statusCode === 403 && finRows() === base + 1, `${viaOther.statusCode}`);
          const lk = await tr.op({ kind: 'finance.lookup.put', entity: 'finance:fund', entityId: 'fp-fund', payload: { name: 'Tabung Palsu' } });
          const rlk = await tr.send([lk]);
          check(FS, 'a treasurer lookup edit is refused forbidden (needs settings:write)', first(rlk)?.reason === 'forbidden' && db.prepare("SELECT 1 FROM finance_funds WHERE id = 'fp-fund'").get() === undefined, first(rlk)?.reason);
          const adm = await make('admin');
          const close = await adm.op({ kind: 'finance.month.put', entity: 'finance:month', entityId: today.slice(0, 7), payload: { status: 'closed' } });
          const rclose = await adm.send([close]);
          const late = await fin({}, { entityId: 'fp4' });
          const rlate = await tr.send([late]);
          check(FS, 'an admin closes the month; a later finance.append dated in it is refused month_closed and no row appears', first(rclose)?.status === 'applied' && first(rlate)?.reason === 'month_closed' && finRows() === base + 1, `${first(rclose)?.status}/${first(rlate)?.reason}`);
          const dup = await fin({ amountSen: 9999 }, { entityId: 'fp1' });
          const rdup = await tr.send([dup]);
          check(FS, 'a second op for an existing entry id is refused and the amount is unchanged', first(rdup)?.status === 'refused' && Number(db.prepare("SELECT amount_sen AS a FROM finance_entries WHERE id = 'fp1'").get().a) === 4200, first(rdup)?.status);
          const sneaky = await fin({ amountSen: '4200' }, { entityId: 'fp5' });
          const rsneaky = await tr.send([sneaky]);
          check(FS, 'a finance op whose amount is a string is refused and nothing is written', first(rsneaky)?.status === 'refused' && finRows() === base + 1, first(rsneaky)?.status);
        }

        // a site key (the box talking to the cloud)
        const siteKey = randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO sites (surau_id, box_id, name, token_hash, linked_at) VALUES (?, ?, ?, ?, ?)').run('sdm', 'probe-site-box', 'Probe', createHash('sha256').update(siteKey).digest('hex'), new Date().toISOString());
        const sh = { authorization: `Bearer ${siteKey}` };
        const probeSite = (method, url) => app.inject({ method, url, remoteAddress: '10.98.2.1', headers: sh, ...(method === 'GET' ? {} : { payload: {} }) });
        const snap = await probeSite('GET', '/api/sync/snapshot');
        check(S, 'a site key reads /api/sync/snapshot', snap.statusCode === 200, snap.statusCode);
        const stray = [];
        for (const [m, u] of [['GET', '/api/settings'], ['GET', '/api/users'], ['GET', '/api/devices'], ['GET', '/api/audit'], ['PUT', '/api/settings/clock'], ['POST', '/api/users'], ['GET', '/api/kiosk/events'], ['GET', '/api/content/kuliah'], ['POST', '/api/live/start'], ['GET', '/api/hadis/status'], ['POST', '/api/hadis/add']]) {
          const r = await probeSite(m, u);
          if (r.statusCode !== 403) stray.push(`${m} ${u} -> ${r.statusCode}`);
        }
        check(S, 'a site key is 403 everywhere outside /api/sync, /api/cloud/youtube and GET /assets', stray.length === 0, stray.join('; '));
        const link = await app.inject({ method: 'POST', url: '/api/sync/link', remoteAddress: '10.98.2.2', payload: {} });
        check(S, 'POST /api/sync/link does not exist on a box (404)', link.statusCode === 404, link.statusCode);
      },
      // Plan 14: a saved HadeethEnc hadis, written the way the box's own add path writes it
      async seedHadis() {
        const { putProviderItem } = await import(pathToFileURL(join(root, 'apps/box-server/src/content/store.ts')).href);
        putProviderItem(app.surau.db, {
          id: 'hadeethenc-66512', textMs: 'Islam itu dibina atas lima perkara.', textAr: 'بني الإسلام', source: 'Muttafaq alaih', grade: 'sahih',
          shown: true, order: 1000,
          ext: { provider: 'hadeethenc', id: '66512', attributionAr: 'رواه البخاري ومسلم', gradeAr: 'صحيح', categories: ['59'], fetchedAt: '2026-11-09T01:00:00.000Z', digest: 'a'.repeat(64) },
        }, 'probe');
      },
      async signedIn(role) {
        n++;
        const { db, boxId } = app.surau;
        const user = createUser(db, { name: `Probe ${role} ${n}`, roles: [role] }, 'probe');
        const { code } = beginEnrolment(db, { userId: user.id, deviceName: `Probe ${n}` }, 'probe');
        const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
        const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
        const post = (path, payload, headers = {}) =>
          raw(base, { method: 'POST', path, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
        const en = await post('/api/enrol/complete', { code, publicJwk, platform: 'web', pin: PIN });
        const deviceId = j(en).deviceId;
        const ch = await post('/api/auth/challenge', { deviceId });
        const nonce = j(ch).nonce;
        const msg = new TextEncoder().encode(`surau-unlock\n${boxId}\n${deviceId}\n${nonce}`);
        const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, msg)).toString('base64url');
        const un = await post('/api/auth/unlock', { deviceId, nonce, signature: sig, pin: PIN });
        return { token: j(un).token, deviceId, unlockBody: { deviceId, nonce, signature: sig, pin: PIN }, userId: user.id };
      },
    };
  }

  assertLoopback(base);
  if (httpBase) assertLoopback(httpBase);
  const bearer = (t) => ({ Authorization: `Bearer ${t}` });

  // ---- 1 unauthenticated surface
  const guarded = [
    ['GET', '/api/settings'], ['PUT', '/api/settings/clock'], ['GET', '/api/users'], ['POST', '/api/users'],
    ['GET', '/api/devices'], ['GET', '/api/audit'], ['GET', '/api/content/kuliah'], ['PUT', '/api/content/kuliah/x'],
    ['DELETE', '/api/content/kuliah/x'], ['POST', '/api/assets'], ['POST', '/api/islamic/fetch'], ['GET', '/api/islamic/status'],
    ['POST', '/api/prayer/import'], ['GET', '/api/auth/me'], ['POST', '/api/auth/logout'], ['POST', '/api/enrol/begin'],
    ['GET', '/api/kiosk/bundle'], ['GET', '/api/kiosk/content'], ['GET', '/api/kiosk/events'],
    ['GET', '/assets/' + 'a'.repeat(64)], ['GET', '/islamic/audio/x/1/001.mp3'],
    ['GET', '/api/hadis/status'], ['GET', '/api/hadis/search?q=amalan'], ['POST', '/api/hadis/add'], ['PUT', '/api/hadis/order'],
    ['POST', '/api/hadis/refresh'], ['GET', '/api/hadis/updates'],
    ['GET', '/api/finance/summary'], ['GET', '/api/finance/entries'], ['PUT', '/api/finance/entries/x'], ['PUT', '/api/finance/funds/x'],
    ['POST', '/api/finance/photos'], ['GET', '/api/finance/photos/' + 'a'.repeat(64)], ['GET', '/api/finance/audit'], ['GET', '/api/finance/report/2026-10.pdf'],
  ];
  let bad = [];
  for (const [m, p] of guarded) {
    for (const method of [m, 'HEAD', 'OPTIONS', 'PATCH']) {
      const r = await raw(base, { method, path: p, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' || method === 'PUT' || method === 'PATCH' ? '{}' : undefined });
      if (r.status !== 401) bad.push(`${method} ${p} -> ${r.status}`);
    }
  }
  check('1 routes', 'anonymous over HTTPS gets 401 on every guarded route for every verb', bad.length === 0, bad.slice(0, 3).join('; '));

  const tricks = ['/API/settings', '/api//settings', '/api/./settings', '/api/x/../settings', '/%61pi/settings', '/api/settings;.css', '/api%2fsettings', '/api\\settings'];
  bad = [];
  for (const p of tricks) {
    const r = await raw(base, { path: p });
    if (![400, 401, 404].includes(r.status) || r.body.toString().includes('"zone"')) bad.push(`${p} -> ${r.status}`);
  }
  check('1 routes', 'path tricks never reach a protected handler anonymously', bad.length === 0, bad.join('; '));

  // ---- 2 role matrix (self-started server only)
  if (seeded) {
    const expectMatrix = {
      admin: { settingsW: 200, users: 200, audit: 200 },
      media: { settingsW: 403, users: 403, audit: 403 },
      ajk: { settingsW: 403, users: 403, audit: 403 },
      treasurer: { settingsW: 403, users: 403, audit: 403 },
    };
    // (enrolment is limited to 5 per address per 10 minutes, so each role signs in exactly once)
    let adm = null;
    let ajkSession = null;
    let trSession = null;
    for (const role of Object.keys(expectMatrix)) {
      const s = await seeded.signedIn(role);
      if (role === 'admin') adm = s;
      if (role === 'ajk') ajkSession = s;
      if (role === 'treasurer') trSession = s;
      const e = expectMatrix[role];
      const w = await raw(base, { method: 'PUT', path: '/api/settings/hijriDate', headers: { ...bearer(s.token), 'Content-Type': 'application/json' }, body: '{"adjustDays":0}' });
      const u = await raw(base, { path: '/api/users', headers: bearer(s.token) });
      const a = await raw(base, { path: '/api/audit', headers: bearer(s.token) });
      const rd = await raw(base, { path: '/api/settings', headers: bearer(s.token) });
      check('2 roles', `${role}: settings write ${e.settingsW}, users ${e.users}, audit ${e.audit}, settings read 200`, w.status === e.settingsW && u.status === e.users && a.status === e.audit && rd.status === 200, `${w.status}/${u.status}/${a.status}/${rd.status}`);
    }
    // ---- Plan 12: system values and the superadmin role over HTTP, as an admin
    {
      const sysBefore = j(await raw(base, { path: '/api/settings', headers: bearer(adm.token) })).system;
      const ws = await raw(base, { method: 'PUT', path: '/api/settings/system', headers: { ...bearer(adm.token), 'Content-Type': 'application/json' }, body: '{"noVideoSeconds":59}' });
      const wl = await raw(base, { method: 'PUT', path: '/api/settings/cloudSync', headers: { ...bearer(adm.token), 'Content-Type': 'application/json' }, body: '{"enabled":false}' });
      const sysAfter = j(await raw(base, { path: '/api/settings', headers: bearer(adm.token) }));
      check('2 roles', 'an admin cannot write the system feature or switch cloud sync off, and nothing changes', ws.status === 403 && wl.status === 403 && sysAfter.system.noVideoSeconds === sysBefore.noVideoSeconds && sysAfter.cloudSync.enabled === true, `${ws.status}/${wl.status}`);
      const mk = await raw(base, { method: 'POST', path: '/api/users', headers: { ...bearer(adm.token), 'Content-Type': 'application/json' }, body: '{"name":"Penyamar","roles":["superadmin"]}' });
      const usersNow = j(await raw(base, { path: '/api/users', headers: bearer(adm.token) })).users;
      check('2 roles', 'creating a Pentadbir MAXCOM on a box is 403 and no user appears', mk.status === 403 && !usersNow.some((u) => u.roles.includes('superadmin')), mk.status);
    }
    // ---- 16 finance (Plan 7): forged money, roles and the photo store, over HTTP
    {
      const F = '16 finance';
      const json = { 'Content-Type': 'application/json' };
      const body = (o) => JSON.stringify(o);
      const on = await raw(base, { method: 'PUT', path: '/api/settings/finance', headers: { ...bearer(adm.token), ...json }, body: '{"enabled":true}' });
      const funds = j(await raw(base, { path: '/api/finance/funds', headers: bearer(trSession.token) })).funds ?? [];
      const per = j(await raw(base, { path: '/api/finance/perihal', headers: bearer(trSession.token) })).perihal ?? [];
      const fundId = funds[0]?.id;
      const perIn = per.find((p) => p.direction === 'in')?.id;
      check(F, 'with finance switched on the treasurer reads the starting lists', on.status === 200 && funds.length >= 3 && Boolean(perIn), `${on.status}/${funds.length}`);
      const cash = (o = {}) => ({ kind: 'in', entryDate: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), fundId, perihalId: perIn, amountSen: 12345, method: 'tunai', counters: [{ name: 'Satu' }, { name: 'Dua' }], ...o });
      const put = (tok, id, o) => raw(base, { method: 'PUT', path: `/api/finance/entries/${id}`, headers: { ...bearer(tok), ...json }, body: body(o) });
      const forged = [
        ['amount as a string', cash({ amountSen: '123' })], ['negative sen', cash({ amountSen: -5 })], ['fractional', cash({ amountSen: 1e5 + 0.5 })],
        ['2.5 sen', cash({ amountSen: 2.5 })], ['one counter', cash({ counters: [{ name: 'Satu' }] })], ['three counters', cash({ counters: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })],
        ['server field', cash({ refNo: 'K-9999' })], ['photo id of 63 hex', cash({ photoId: 'a'.repeat(63) })], ['unknown tabung', cash({ fundId: 'nope' })],
      ];
      const badForged = [];
      for (const [label, o] of forged) {
        const res = await put(trSession.token, 'probe1', o);
        if (res.status !== 400) badForged.push(`${label} -> ${res.status}`);
      }
      const listed = j(await raw(base, { path: '/api/finance/entries', headers: bearer(trSession.token) })).entries ?? [];
      check(F, 'forged amounts, counters and fields are all 400 and no row is written', badForged.length === 0 && listed.length === 0, badForged.join('; ') || `${listed.length} rows`);
      const trav = await raw(base, { method: 'PUT', path: '/api/finance/entries/..%2f..%2fapi%2fusers', headers: { ...bearer(trSession.token), ...json }, body: body(cash()) });
      check(F, 'an encoded path separator in the entry id is refused (400)', trav.status === 400, trav.status);
      const asAjk = await put(ajkSession.token, 'probe2', cash());
      check(F, 'an AJK cannot post an entry (403)', asAjk.status === 403, asAjk.status);
      const ok1 = await put(trSession.token, 'probe3', cash());
      const ok2 = await put(trSession.token, 'probe3', cash({ amountSen: 12346 }));
      check(F, 'a treasurer posts an entry (200); the same id with another amount is 409 and the ledger is unchanged', ok1.status === 200 && ok2.status === 409 && j(await raw(base, { path: '/api/finance/entries/probe3', headers: bearer(trSession.token) })).entry?.amountSen === 12345, `${ok1.status}/${ok2.status}`);
      const lookup = await raw(base, { method: 'PUT', path: '/api/finance/funds/probe-fund', headers: { ...bearer(trSession.token), ...json }, body: body({ name: 'Tabung Palsu' }) });
      check(F, 'a treasurer cannot create a tabung (403, settings:write)', lookup.status === 403, lookup.status);
      const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]), randomBytes(2000)]);
      const photoId = createHash('sha256').update(jpg).digest('hex');
      const up = await raw(base, { method: 'POST', path: '/api/finance/photos', headers: { ...bearer(trSession.token), 'Content-Type': 'image/jpeg', 'X-Entry-Id': 'probe3' }, body: jpg });
      check(F, 'a treasurer uploads a JPEG count sheet (200) and gets its id', up.status === 200 && j(up).id === photoId, up.status);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
      const upPng = await raw(base, { method: 'POST', path: '/api/finance/photos', headers: { ...bearer(trSession.token), 'Content-Type': 'image/jpeg', 'X-Entry-Id': 'probe3' }, body: png });
      check(F, 'a PNG sent as image/jpeg is refused (400)', upPng.status === 400, upPng.status);
      const upAjk = await raw(base, { method: 'POST', path: '/api/finance/photos', headers: { ...bearer(ajkSession.token), 'Content-Type': 'image/jpeg', 'X-Entry-Id': 'probe3' }, body: jpg });
      check(F, 'an AJK cannot upload a photo (403)', upAjk.status === 403, upAjk.status);
      const viaAssets = await raw(base, { path: `/assets/${photoId}`, headers: bearer(adm.token) });
      const viaAssetsAnon = await raw(base, { path: `/assets/${photoId}` });
      check(F, 'the photo is not served through /assets/ (404 signed in, 401 anonymous)', viaAssets.status === 404 && viaAssetsAnon.status === 401, `${viaAssets.status}/${viaAssetsAnon.status}`);
      const gAjk = await raw(base, { path: `/api/finance/photos/${photoId}`, headers: bearer(ajkSession.token) });
      const gAnon = await raw(base, { path: `/api/finance/photos/${photoId}` });
      const gTr = await raw(base, { path: `/api/finance/photos/${photoId}`, headers: bearer(trSession.token) });
      check(F, 'the photo is 403 for an AJK, 401 unsigned and 200 no-store for the treasurer', gAjk.status === 403 && gAnon.status === 401 && gTr.status === 200 && gTr.headers['cache-control'] === 'no-store' && gTr.body.length >= jpg.length, `${gAjk.status}/${gAnon.status}/${gTr.status}`);
      const entAjk = j(await raw(base, { path: '/api/finance/entries', headers: bearer(ajkSession.token) })).entries ?? [];
      check(F, 'an AJK reading the entries gets no photoId key', entAjk.length > 0 && entAjk.every((e) => !('photoId' in e)), JSON.stringify(Object.keys(entAjk[0] ?? {})));
    }
    // ---- 14 live (signed in): the WHIP proxy never opens without a session this device owns
    {
      const whip = await raw(base, { method: 'POST', path: '/api/live/whip', headers: { ...bearer(adm.token), 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' });
      check('14 live', 'WHIP without an open live session is refused (409), never forwarded', whip.status === 409, whip.status);
      const stp = await raw(base, { method: 'POST', path: '/api/live/stop', headers: { ...bearer(adm.token), 'Content-Type': 'application/json' }, body: '{}' });
      check('14 live', 'stop with no session is a harmless no-op and answers no credential', stp.status === 200 && !/pass|key|token/i.test(stp.body.toString()), stp.status);
    }
    // ---- 15 hadis (Plan 14): nothing reaches the TV under a HadeethEnc badge that HadeethEnc did not serve
    {
      const H = '15 hadis';
      await seeded.seedHadis();
      const json = { 'Content-Type': 'application/json' };
      const body = (o) => JSON.stringify(o);
      const item = { textMs: 'Islam itu dibina atas lima perkara.', textAr: 'بني الإسلام', source: 'Muttafaq alaih', grade: 'sahih', shown: true, order: 1000,
        ext: { provider: 'hadeethenc', id: '66512', attributionAr: 'رواه البخاري ومسلم', gradeAr: 'صحيح', categories: ['59'], fetchedAt: '2026-11-09T01:00:00.000Z', digest: 'a'.repeat(64) } };
      const put = (id, o) => raw(base, { method: 'PUT', path: `/api/content/hadis/${id}`, headers: { ...bearer(adm.token), ...json }, body: body(o) });
      const aSearch = await raw(base, { path: '/api/hadis/search?q=amalan', headers: bearer(ajkSession.token) });
      check(H, 'an AJK (content:read only) cannot search HadeethEnc (403)', aSearch.status === 403, aSearch.status);
      const aAdd = await raw(base, { method: 'POST', path: '/api/hadis/add', headers: { ...bearer(ajkSession.token), ...json }, body: body({ provider: 'hadeethenc', id: '66512' }) });
      check(H, 'an AJK cannot add a hadis (403)', aAdd.status === 403, aAdd.status);
      const forgedText = await put('hadeethenc-66512', { ...item, textMs: 'Kata yang direka.' });
      check(H, 'a PUT that changes the text of a saved HadeethEnc hadis is 400', forgedText.status === 400, forgedText.status);
      const forgedGrade = await put('hadeethenc-66512', { ...item, grade: 'hasan' });
      check(H, 'a PUT that changes its grade is 400', forgedGrade.status === 400, forgedGrade.status);
      const forgedNew = await put('forged-1', item);
      check(H, 'a PUT that creates a new hadis carrying a HadeethEnc ext is 400', forgedNew.status === 400, forgedNew.status);
      const forgedId = await put('hadeethenc-12', { textMs: 'x', source: 'y' });
      check(H, 'a PUT of an own hadis under a HadeethEnc row id is 400', forgedId.status === 400, forgedId.status);
      const toggle = await put('hadeethenc-66512', { ...item, shown: false });
      check(H, 'the same PUT with only shown changed is accepted (200)', toggle.status === 200 && j(toggle).item?.shown === false, toggle.status);
      const addBad = await raw(base, { method: 'POST', path: '/api/hadis/add', headers: { ...bearer(adm.token), ...json }, body: body({ provider: 'hadeethenc', id: '../x' }) });
      check(H, 'adding id ../x is 400, no request leaves the box', addBad.status === 400, addBad.status);
      const short = await raw(base, { path: '/api/hadis/search?q=a', headers: bearer(adm.token) });
      check(H, 'a one-letter search is 400', short.status === 400, short.status);
      const missing = await raw(base, { path: '/api/hadis/hadeethenc/..%2F..%2Fsettings', headers: bearer(adm.token) });
      check(H, 'an encoded path in the hadis id never reaches a handler (400/404)', [400, 404].includes(missing.status), missing.status);
    }
    // ---- 3 replay
    const s = adm;
    const replay = await raw(base, { method: 'POST', path: '/api/auth/unlock', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s.unlockBody) });
    check('3 replay', 'a captured unlock body resent is refused', replay.status === 401 && !replay.body.toString().includes('token'), replay.status);
    await seeded.appLockProbes();
    await seeded.syncProbes();
    // ---- 5 injection with a signed-in admin
    const evil = ["'", "' OR '1'='1", "'; DROP TABLE users; --", '../../etc/passwd', '%00', '%27%20OR%201=1', '__proto__', 'A'.repeat(10240)];
    bad = [];
    for (const e of evil) {
      const p = encodeURIComponent(e);
      for (const [method, path, body] of [
        ['GET', `/api/content/${p}`], ['GET', `/api/content/kuliah/${p}`], ['DELETE', `/api/content/kuliah/${p}`],
        ['PUT', `/api/settings/${p}`, '{}'], ['PUT', `/api/users/${p}/roles`, '{"roles":["ajk"]}'], ['POST', `/api/devices/${p}/revoke`, '{}'],
        ['GET', `/assets/${p}`], ['GET', `/islamic/audio/${p}/1/1.mp3`], ['GET', `/api/audit?limit=${p}`],
      ]) {
        const r = await raw(base, { method, path, headers: { ...bearer(adm.token), 'Content-Type': 'application/json' }, body });
        if (r.status >= 500 || (r.status >= 400 && LEAK.test(r.body.toString().replaceAll(e, '')))) bad.push(`${method} ${path.slice(0, 50)} -> ${r.status}`);
      }
    }
    check('5 injection', 'hostile ids and params give 4xx, never 5xx, no stack/SQL/path text', bad.length === 0, bad.slice(0, 3).join('; '));
    const users = await raw(base, { path: '/api/users', headers: bearer(adm.token) });
    check('5 injection', 'users table survived the injection payloads', users.status === 200 && Array.isArray(j(users).users), users.status);
    bad = [];
    for (const body of ['{"__proto__":{"admin":true}}', '{"constructor":{"prototype":{"x":1}}}', 'null', '[]', '{broken', '1e999']) {
      for (const [method, path] of [['PUT', '/api/settings/clock'], ['POST', '/api/users'], ['PUT', '/api/content/kuliah/pp'], ['POST', '/api/kiosk/pair/approve']]) {
        const r = await raw(base, { method, path, headers: { ...bearer(adm.token), 'Content-Type': 'application/json' }, body });
        if (r.status >= 500) bad.push(`${method} ${path} ${body.slice(0, 15)} -> ${r.status}`);
      }
    }
    check('5 injection', 'prototype keys and malformed JSON never give 5xx', bad.length === 0, bad.join('; '));

    // ---- 9 secrets
    const outputs = [];
    for (const p of ['/api/users', '/api/devices', '/api/audit?limit=1000', '/api/health', '/api/settings', '/api/auth/me']) {
      const r = await raw(base, { path: p, headers: bearer(adm.token) });
      outputs.push(r.body.toString(), JSON.stringify(r.headers));
    }
    const text = outputs.join('\n');
    check('9 secrets', 'no hash, key, PIN, nonce or passphrase in operator-readable output', !/pin_hash|pinHash|token_hash|code_hash|scrypt\$|PRIVATE KEY|passphrase|482916/i.test(text) && !text.includes(s.unlockBody.nonce) && !text.includes(adm.token), '');
    const out = await raw(base, { method: 'POST', path: '/api/auth/logout', headers: { ...bearer(adm.token), 'Content-Type': 'application/json' }, body: '{}' });
    const after = await raw(base, { path: '/api/auth/me', headers: bearer(adm.token) });
    check('3 replay', 'a bearer token is dead after logout', out.status === 200 && after.status === 401, `${out.status}/${after.status}`);

    // ---- Plan 14: first setup and recovery on a fresh throw-away box (in-process, own addresses)
    {
      const A = '15 setup';
      const { buildApp } = await import(pathToFileURL(join(root, 'apps/box-server/src/app.ts')).href);
      const { issueNonce } = await import(pathToFileURL(join(root, 'apps/box-server/src/setup/codes.ts')).href);
      const { parseBoxQr } = await import(pathToFileURL(join(root, 'packages/core/src/index.ts')).href);
      const { readdirSync } = await import('node:fs');
      const sdir = mkdtempSync(join(tmpdir(), 'surau-secprobe-setup-'));
      const sapp = buildApp(join(sdir, 'surau.db'), { dataDir: sdir });
      try {
        const PINX = '482916';
        const nonceOf = async () => {
          const v = (await sapp.inject({ method: 'GET', url: '/api/box/state', remoteAddress: '127.0.0.1' })).json();
          return v.qr ? parseBoxQr(v.qr.payload).nonce : null;
        };
        const device = async () => {
          const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
          const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
          return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
        };
        let ipn = 0;
        const post = async (url, payload, ip) => sapp.inject({ method: 'POST', url, remoteAddress: ip ?? `10.77.0.${++ipn}`, payload });
        const setupBody = async (nonce) => ({ nonce, surauName: 'Surau Probe', boxName: 'MAXCOM Probe', adminName: 'Probe', deviceName: 'probe', publicJwk: await device(), platform: 'android', pin: PINX });
        const nonce = await nonceOf();
        const first = await post('/api/setup/complete', await setupBody(nonce));
        check(A, 'the first phone sets the box up (201)', first.statusCode === 201, first.statusCode);
        check(A, 'the setup answer holds the recovery code once and no PIN', typeof first.json().recoveryCode === 'string' && !first.body.includes(PINX), '');
        const reuse = await post('/api/setup/complete', await setupBody(nonce));
        check(A, 'a consumed nonce is 401', reuse.statusCode === 401, reuse.statusCode);
        const late = await post('/api/setup/complete', await setupBody(issueNonce(sapp.surau.db, 'setup', new Date()).nonce));
        check(A, 'setup on a box with users is 409 even with a fresh nonce', late.statusCode === 409, late.statusCode);
        sapp.surau.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        const dump = readdirSync(sdir).filter((f) => /\.db(-wal|-shm)?$/.test(f)).map((f) => readFileSync(join(sdir, f)));
        const code = first.json().recoveryCode;
        check(A, 'the database holds neither the recovery code, the setup nonce nor the PIN', dump.every((b) => !b.includes(Buffer.from(code)) && !b.includes(Buffer.from(code.replaceAll('-', ''))) && !b.includes(Buffer.from(nonce)) && !b.includes(Buffer.from(PINX))), '');
        check(A, 'the box screen shows no setup QR any more', (await nonceOf()) === null, '');
        // recovery: lose the only admin device, then try wrong codes from one address
        sapp.surau.db.prepare("UPDATE devices SET revoked_at = ? WHERE platform <> 'kiosk'").run(new Date().toISOString());
        const same = '10.77.9.9';
        const rb = async (n) => ({ nonce: n, recoveryCode: 'AAAA-AAAA-AAAA-AAAA', adminName: 'Probe', deviceName: 'probe', publicJwk: await device(), platform: 'android', pin: PINX });
        const st = [];
        for (let i = 0; i < 4; i++) st.push((await post('/api/recovery/complete', await rb(await nonceOf()), same)).statusCode);
        check(A, 'four wrong recovery codes from one address: 401, 401, 401, then 429', st.join() === '401,401,401,429', st.join());
        const dead = await post('/api/recovery/complete', { ...(await rb(await nonceOf())), recoveryCode: code }, '10.77.9.10');
        check(A, 'the right code on a fresh nonce still works from another address (201)', dead.statusCode === 201, dead.statusCode);
        const noRecovery = await post('/api/recovery/complete', { ...(await rb(issueNonce(sapp.surau.db, 'recovery', new Date()).nonce)), recoveryCode: code }, '10.77.9.11');
        check(A, 'recovery on a box with an active Pentadbir is 409', noRecovery.statusCode === 409, noRecovery.statusCode);
        const logText = JSON.stringify(sapp.surau.db.prepare('SELECT detail FROM auth_log').all());
        check(A, 'the audit log holds reason codes only (no code, no nonce)', !logText.includes(code) && !logText.includes(nonce), '');
      } finally {
        await sapp.close();
        rmSync(sdir, { recursive: true, force: true, maxRetries: 5 });
      }
    }

  } else {
    check('2 roles', 'signed-in probes (role matrix, replay, injection, secrets)', true, 'skipped: need the self-started server');
  }

  // ---- 6 traversal
  const KEY = [
    '/data/secret/box.key', '/secret/box.key', '/../data/secret/box.key', '/%2e%2e/data/secret/box.key', '/..%2fdata%2fsecret%2fbox.key',
    '/%252e%252e/data/secret/box.key', '/..%5cdata%5csecret%5cbox.key', '/assets/../../data/secret/box.key', '/assets/..%2f..%2fdata%2fsecret%2fbox.key',
    '/assets/..%252f..%252fsecret%252fbox.key', '/islamic/audio/../../../../secret/box.key', '/islamic/audio/..%2f..%2f..%2fsecret%2fbox.key',
    '/.env', '/.git/config', '/data/surau.db', '/node_modules/fastify/package.json',
  ];
  bad = [];
  for (const p of KEY) {
    const r = await raw(base, { path: p });
    const t = r.body.toString('latin1');
    if (r.status >= 500 || t.includes('SQLite format') || (r.status === 200 && !t.includes('<div id="app">') && !/^<!doctype/i.test(t))) bad.push(`${p} -> ${r.status}`);
  }
  check('6 traversal', 'no traversal path returns a file; only 4xx or the SPA shell', bad.length === 0, bad.join('; '));

  // ---- 7 error leakage
  bad = [];
  for (const [method, path, ct, body] of [
    ['POST', '/api/auth/unlock', 'application/json', '{"a":'], ['POST', '/api/auth/unlock', 'text/plain', 'x'],
    ['POST', '/api/enrol/complete', 'application/json', '[]'], ['GET', '/api/%E0%A4%A', null, undefined], ['POST', '/api/kiosk/pair/poll', 'application/json', '{"pollToken":1}'],
  ]) {
    const r = await raw(base, { method, path, headers: ct ? { 'Content-Type': ct } : {}, body });
    if (r.status >= 500 || LEAK.test(r.body.toString())) bad.push(`${method} ${path} -> ${r.status}`);
  }
  check('7 errors', 'framework and validation errors leak no stack, SQL or path', bad.length === 0, bad.join('; '));

  // ---- 8 headers
  const hdrs = [];
  for (const p of ['/api/health', '/api/settings', '/api/nope', '/api/pki/root.cer']) hdrs.push([p, await raw(base, { path: p })]);
  bad = [];
  for (const [p, r] of hdrs) {
    const h = r.headers;
    if (!(h['cache-control'] ?? '').includes('no-store')) bad.push(`${p} cache-control`);
    if (h['x-content-type-options'] !== 'nosniff') bad.push(`${p} nosniff`);
    if (h['referrer-policy'] !== 'no-referrer') bad.push(`${p} referrer`);
    if (h.server) bad.push(`${p} server header`);
    if (Object.keys(h).some((k) => k.startsWith('access-control-'))) bad.push(`${p} CORS`);
  }
  check('8 headers', '/api: no-store, nosniff, no-referrer, no Server, no CORS', bad.length === 0, bad.join('; '));
  const page = await raw(base, { path: '/' });
  const csp = page.headers['content-security-policy'] ?? '';
  check('8 headers', 'kiosk page CSP: self-only, no inline script, no framing, no eval', page.status === 200 && ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'"].every((d) => csp.includes(d)) && !/unsafe-eval|script-src[^;]*unsafe-inline/.test(csp), csp || page.status);
  check('8 headers', 'HSTS on HTTPS', /max-age=\d{6,}/.test(hdrs[0][1].headers['strict-transport-security'] ?? ''), hdrs[0][1].headers['strict-transport-security']);
  const cors = await raw(base, { path: '/api/health', headers: { Origin: 'https://evil.example' } });
  check('8 headers', 'cross-origin request gets no CORS permission', !cors.headers['access-control-allow-origin'], '');

  // ---- 10 TLS
  const u = new URL(base);
  const hs = (o) =>
    new Promise((res) => {
      try {
        const s = tlsConnect({ host: u.hostname, port: Number(u.port), rejectUnauthorized: false, ...o }, () => {
          const r = { protocol: s.getProtocol(), cipher: s.getCipher().name, san: s.getPeerCertificate().subjectaltname ?? '' };
          s.destroy();
          res(r);
        });
        s.on('error', () => res(null));
      } catch {
        res(null); // this client cannot even offer the suite: nothing to accept
      }
    });
  const best = await hs({});
  check('10 tls', 'TLS 1.2 or 1.3 negotiated, certificate has the IP SAN', best && ['TLSv1.2', 'TLSv1.3'].includes(best.protocol) && best.san.includes('IP Address:'), JSON.stringify(best));
  check('10 tls', 'TLS 1.0 and 1.1 refused', (await hs({ minVersion: 'TLSv1', maxVersion: 'TLSv1', ciphers: 'ALL:@SECLEVEL=0' })) === null && (await hs({ minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'ALL:@SECLEVEL=0' })) === null, '');
  const weak = ['ECDHE-ECDSA-AES128-SHA', 'ECDHE-ECDSA-AES256-SHA', 'ECDHE-ECDSA-AES128-SHA256', 'AES128-SHA', 'AES256-GCM-SHA384', 'ECDHE-RSA-AES128-SHA', 'DES-CBC3-SHA'];
  const accepted = [];
  for (const c of weak) if (await hs({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: `${c}:@SECLEVEL=0` })) accepted.push(c);
  check('10 tls', 'no non-forward-secret or CBC cipher suite is accepted', accepted.length === 0, accepted.join(','));

  // ---- Host allowlist
  bad = [];
  for (const h of ['evil.example', '127.0.0.1.evil.example', '127.0.0.1@evil.example', '127.0.0.1:80@evil.example', '127.0.0.1:abc', '2130706433', 'localhost.evil.example']) {
    const r = await raw(base, { path: '/api/health', host: h });
    if (r.status !== 421) bad.push(`${h} -> ${r.status}`);
  }
  check('Host', 'foreign and look-alike Host headers get 421', bad.length === 0, bad.join('; '));
  const fwd = await raw(base, { path: '/api/health', host: 'evil.example', headers: { 'X-Forwarded-Host': '127.0.0.1' } });
  check('Host', 'X-Forwarded-Host does not replace Host', fwd.status === 421, fwd.status);

  // ---- loopback kiosk identity and plain HTTP
  if (httpBase) {
    const k = await raw(httpBase, { path: '/api/kiosk/bundle' });
    const w = await raw(httpBase, { method: 'PUT', path: '/api/settings/clock', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const s2 = await raw(httpBase, { path: '/api/settings' });
    const px = await raw(httpBase, { path: '/api/kiosk/bundle', headers: { 'X-Forwarded-For': '10.168.1.5' } });
    check('2 roles', 'loopback kiosk reads the display data only; never writes or reads settings; proxy headers drop it', k.status === 200 && w.status === 403 && s2.status === 403 && px.status === 401, `${k.status}/${w.status}/${s2.status}/${px.status}`);
    const sec = await raw(base, { path: '/api/kiosk/bundle' });
    check('2 roles', 'the same request over HTTPS (even from loopback) is anonymous', sec.status === 401, sec.status);
    const ph = await raw(httpBase, { path: '/api/health' });
    check('10 tls', 'loopback plain HTTP does not claim HSTS', ph.status === 200 && !ph.headers['strict-transport-security'], ph.status);
  }

  // ---- 14 live: MediaMTX is reachable only through the box server
  {
    const anon = [
      ['POST', '/api/live/start'],
      ['POST', '/api/live/stop'],
      ['GET', '/api/live/status'],
      ['POST', '/api/live/whip'],
      ['DELETE', '/api/live/whip/x'],
      ['GET', '/api/kiosk/live'],
      ['POST', '/api/kiosk/live/whep'],
      ['DELETE', '/api/kiosk/live/whep/x'],
      ['GET', '/api/live/youtube/status'],
    ];
    const bad14 = [];
    for (const [method, path] of anon) {
      const r = await raw(base, { method, path, headers: method === 'POST' ? { 'Content-Type': 'application/sdp' } : {}, body: method === 'POST' ? 'v=0\r\n' : undefined });
      if (r.status !== 401) bad14.push(`${method} ${path} -> ${r.status}`);
    }
    check('14 live', 'every /api/live and /api/kiosk/live route is 401 for an anonymous HTTPS caller', bad14.length === 0, bad14.join('; '));
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    const hosts = ['127.0.0.1', ...(lan ? [lan] : [])];
    const open14 = [];
    for (const host of hosts) {
      for (const port of [8889, 9997, 8554]) {
        // the box (and its MediaMTX) may or may not be running here: if a port answers, it must not give media or API data
        const res = await new Promise((resolveProbe) => {
          const sock = netConnect({ host, port }, () => {
            sock.write(`GET ${port === 9997 ? '/v3/config/global/get' : '/surau/whep'} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
          });
          let data = '';
          sock.setTimeout(3000, () => sock.destroy());
          sock.on('data', (c) => (data += c.toString('latin1')));
          sock.on('close', () => resolveProbe(data));
          sock.on('error', () => resolveProbe(null));
        });
        if (res === null || res === '') continue;
        const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(res)?.[1] ?? 0);
        if (code === 200) open14.push(`${host}:${port} -> 200`);
        if (host !== '127.0.0.1') open14.push(`${host}:${port} reachable from the LAN address`);
      }
    }
    check('14 live', 'MediaMTX HTTP, API and RTSP ports are never reachable on the LAN address and never serve data unauthenticated', open14.length === 0, open14.join('; '));
  }

  // ---- 12 body limits and slow clients
  const big = JSON.stringify({ label: 'x'.repeat(3 * 1024 * 1024) });
  const r413 = await raw(base, { method: 'POST', path: '/api/auth/unlock', headers: { 'Content-Type': 'application/json' }, body: big }).catch(() => ({ status: 0 }));
  check('12 limits', '3 MB JSON body refused (413, or the connection is cut)', r413.status === 413 || r413.status === 0, r413.status);
  const slow = await new Promise((res) => {
    const t0 = Date.now();
    const s = tlsConnect({ host: u.hostname, port: Number(u.port), rejectUnauthorized: false }, () => {
      s.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
      const drip = setInterval(() => !s.destroyed && s.write('X-Slow: 1\r\n'), 1000);
      s.on('close', () => {
        clearInterval(drip);
        res(Date.now() - t0);
      });
    });
    s.on('error', () => undefined);
    setTimeout(() => {
      s.destroy();
      res(Infinity);
    }, 30000).unref();
  });
  check('12 limits', 'slow-loris client (headers never finished) is cut off within 25 s', slow < 25000, `${slow} ms`);

  // ---- SSE slots
  if (httpBase) {
    const hu = new URL(httpBase);
    const open = () =>
      new Promise((res) => {
        const s = netConnect({ host: hu.hostname, port: Number(hu.port) }, () => s.write('GET /api/kiosk/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
        let buf = '';
        s.on('data', (d) => {
          buf += d.toString('latin1');
          const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
          if (m) res({ status: Number(m[1]), s });
        });
        s.on('error', () => res({ status: 0, s }));
      });
    const conns = [];
    for (let i = 0; i < 12; i++) conns.push(await open());
    const okN = conns.filter((c) => c.status === 200).length;
    check('13 sse', 'one address cannot hold all event-stream slots (cap < 20) and gets 429 beyond it', okN >= 2 && okN <= 8 && conns.some((c) => c.status === 429), `ok=${okN}`);
    conns.forEach((c) => c.s.destroy());
  }

  if (started) await started.app.close();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

  const w = Math.max(...results.map((r) => r.area.length));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.area.padEnd(w)}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('sec-probe crashed:', e instanceof Error ? e.message : String(e));
  process.exit(2);
});
void http;
