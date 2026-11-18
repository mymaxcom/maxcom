#!/usr/bin/env node
/**
 * MAXCOM cloud isolation probe (Plan 14 Task 12; the sibling of scripts/sec-probe.mjs, which probes a single box): the black-box subset of apps/box-server/test/tenantIsolation.test.ts,
 * run over HTTP against a running cloud, with a pass/fail table.
 *
 *   node scripts/sec-probe-cloud.mjs --base https://staging.example [--write] [--json] [--allow-real-host]
 *
 * Read-only by default (GET only). `--write` adds the throwaway write probes (each one is expected to be REFUSED; they only
 * change anything if the server has a hole).
 *
 * Credentials come from the environment, never from the command line:
 *   SECPROBE_TOKEN_A, SECPROBE_TOKEN_B      session tokens of an admin of surau A and of surau B (Bearer)
 *   SECPROBE_SITE_A, SECPROBE_SITE_B        the site keys of the boxes of A and B
 *   SECPROBE_SURAU_A, SECPROBE_SURAU_B      the surau ids
 *   SECPROBE_BOX_A, SECPROBE_BOX_B          the box ids (16 hex)
 *   SECPROBE_TOKEN_PUBSA     (optional) session of a Pentadbir MAXCOM on a PUBLIC device
 *   SECPROBE_TOKEN_OPS       (optional) session of a Pentadbir MAXCOM on an OPS device (positive control and --write approvals)
 *   SECPROBE_STAR_IDS        (optional) comma list of the user and device ids of the Pentadbir/Sokongan MAXCOM (must be hidden)
 *   SECPROBE_MARKERS_A       (optional) comma list of strings that only surau A's data contains
 * A / B can be any two suraus; the probe never uses a real person's data beyond what the tokens can read.
 *
 * NEVER point it at the production cloud (api.mymaxcom.my): hosts under mymaxcom.my are refused unless --allow-real-host.
 * Exit code 0: every check passed (skips are listed); 1: at least one FAIL; 2: bad usage.
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

function usage(msg) {
  if (msg) console.error(`sec-probe: ${msg}`);
  console.error('usage: node scripts/sec-probe-cloud.mjs --base <url> [--write] [--json] [--allow-real-host]   (credentials in SECPROBE_* env, see the header of this file)');
  process.exit(2);
}

const baseArg = opt('--base');
if (!baseArg) usage('--base is required');
let base;
try {
  base = new URL(baseArg);
} catch {
  usage('--base is not a URL');
}
if (!/^https?:$/.test(base.protocol)) usage('--base must be http or https');
if (/(^|\.)mymaxcom\.my$/i.test(base.hostname) && !flag('--allow-real-host')) {
  usage(`${base.hostname} is a real MAXCOM host: refused (this probe is for a test cloud; --allow-real-host overrides on purpose)`);
}
const WRITE = flag('--write');
const AS_JSON = flag('--json');

const env = (k) => (process.env[k] ?? '').trim();
const need = ['TOKEN_A', 'TOKEN_B', 'SITE_A', 'SITE_B', 'SURAU_A', 'SURAU_B', 'BOX_A', 'BOX_B'];
const missing = need.filter((k) => env(`SECPROBE_${k}`) === '');
if (missing.length > 0) usage(`missing environment: ${missing.map((k) => `SECPROBE_${k}`).join(', ')}`);
const C = {
  tokenA: env('SECPROBE_TOKEN_A'),
  tokenB: env('SECPROBE_TOKEN_B'),
  siteA: env('SECPROBE_SITE_A'),
  siteB: env('SECPROBE_SITE_B'),
  surauA: env('SECPROBE_SURAU_A'),
  surauB: env('SECPROBE_SURAU_B'),
  boxA: env('SECPROBE_BOX_A'),
  boxB: env('SECPROBE_BOX_B'),
  pubsa: env('SECPROBE_TOKEN_PUBSA'),
  ops: env('SECPROBE_TOKEN_OPS'),
  star: env('SECPROBE_STAR_IDS').split(',').map((s) => s.trim()).filter(Boolean),
  markersA: env('SECPROBE_MARKERS_A').split(',').map((s) => s.trim()).filter(Boolean),
};

// ---------------------------------------------------------------------------------------------------------------

async function call(method, path, { token, headers = {}, body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(new URL(path, base), { method, headers: h, body: payload, redirect: 'manual', signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, text, json };
  } catch (e) {
    return { status: 0, text: String(e?.message ?? e), json: null };
  } finally {
    clearTimeout(timer);
  }
}

const rows = [];
function record(status, id, what, detail = '') {
  rows.push({ status, id, what, detail });
}
const pass = (id, what) => record('PASS', id, what);
const fail = (id, what, detail) => record('FAIL', id, what, detail);
const skip = (id, what, why) => record('SKIP', id, what, why);
function check(id, what, ok, detail = '') {
  if (ok) pass(id, what);
  else fail(id, what, detail);
}

const hit = (res, tokens, own = '') => tokens.filter((t) => t !== '' && res.text.includes(t) && !own.includes(t));

// ---------------------------------------------------------------------------------------------------------------
// what is A's and what is B's: read with their own tokens (the positive control of every later check)

async function ownTokens(token, surauId, boxId, extra) {
  const tokens = new Set([surauId, boxId, ...extra]);
  for (const path of ['/api/users', '/api/devices']) {
    const res = await call('GET', path, { token });
    for (const k of ['users', 'devices']) for (const r of res.json?.[k] ?? []) if (typeof r.id === 'string') tokens.add(r.id);
  }
  return [...tokens].filter((t) => t.length >= 4);
}

const LIST_ROUTES = [
  '/api/users',
  '/api/devices',
  '/api/settings',
  '/api/content/penceramah',
  '/api/content/hadis',
  '/api/finance/entries',
  '/api/finance/funds',
  '/api/finance/perihal',
  '/api/sync/snapshot',
  '/api/sync/changes?since=0',
  '/api/kiosk/bundle',
  '/api/prayer/days',
  '/api/prayer/status',
  '/api/hadis/status',
  '/api/audit',
  '/api/finance/audit',
  '/api/assets',
  '/api/auth/me',
  '/api/health',
];

async function main() {
  // ---- positive controls: the probe can see each surau's own data ----
  const tokA = await ownTokens(C.tokenA, C.surauA, C.boxA, C.markersA);
  const tokB = await ownTokens(C.tokenB, C.surauB, C.boxB, []);
  const meA = await call('GET', '/api/users', { token: C.tokenA });
  const meB = await call('GET', '/api/users', { token: C.tokenB });
  check('P1', "A's admin lists A's users (positive control)", meA.status === 200 && tokA.length > 3, `status ${meA.status}`);
  check('P2', "B's admin lists B's users (positive control)", meB.status === 200 && tokB.length > 3, `status ${meB.status}`);
  const aOnly = tokA.filter((t) => !tokB.includes(t));
  const bOnly = tokB.filter((t) => !tokA.includes(t));
  check('P3', 'the two suraus share no user, device, surau or box id', aOnly.length === tokA.length && bOnly.length === tokB.length, 'the two credentials look like one surau');

  // ---- B reads and lists: nothing of A, whatever the headers ----
  for (const route of LIST_ROUTES) {
    const plain = await call('GET', route, { token: C.tokenB });
    check(`L:${route}`, `B reads ${route}: no byte of A's data`, hit(plain, aOnly).length === 0, `leaks ${hit(plain, aOnly).slice(0, 4).join(', ')} (status ${plain.status})`);
    const forged = await call('GET', route, { token: C.tokenB, headers: { 'x-maxcom-surau': C.surauA } });
    const tenant = !['/api/auth/me', '/api/health'].includes(route);
    check(
      `H:${route}`,
      `B + X-Maxcom-Surau: A on ${route}: ${tenant ? 'refused' : 'no byte of A'}`,
      hit(forged, aOnly).length === 0 && (!tenant || [403, 404].includes(forged.status)),
      `status ${forged.status}, leaks ${hit(forged, aOnly).slice(0, 4).join(', ')}`,
    );
    const viaBox = await call('GET', route, { token: C.tokenB, headers: { 'x-maxcom-box': C.boxA } });
    check(`B:${route}`, `B + X-Maxcom-Box: A's box on ${route}: no byte of A`, hit(viaBox, aOnly).length === 0, `leaks ${hit(viaBox, aOnly).slice(0, 4).join(', ')}`);
  }

  // ---- B's site key ----
  for (const route of ['/api/users', '/api/settings', '/api/finance/entries', '/api/audit', '/api/devices']) {
    const res = await call('GET', route, { token: C.siteB, headers: { 'x-maxcom-surau': C.surauA } });
    check(`S:${route}`, `B's site key on ${route}: refused`, res.status === 403 || res.status === 404, `status ${res.status}`);
  }
  for (const route of ['/api/sync/snapshot', '/api/sync/changes?since=0']) {
    const res = await call('GET', route, { token: C.siteB, headers: { 'x-maxcom-surau': C.surauA, 'x-maxcom-box': C.boxA } });
    // a site's feed carries the Pentadbir MAXCOM's rows by design; A's own data it never carries
    check(`S:${route}`, `B's site key on ${route}: none of A's data`, res.status === 200 && hit(res, aOnly.filter((t) => !C.star.includes(t))).length === 0, `status ${res.status}, leaks ${hit(res, aOnly).slice(0, 4).join(', ')}`);
  }
  const ownSite = await call('GET', '/api/sync/snapshot', { token: C.siteA });
  check('S:own', "A's site key reads A's snapshot (positive control)", ownSite.status === 200, `status ${ownSite.status}`);

  // ---- id guessing: ids read with A's token, asked for with B's ----
  const aEntries = await call('GET', '/api/finance/entries', { token: C.tokenA });
  const aItems = await call('GET', '/api/content/penceramah', { token: C.tokenA });
  const aEntry = aEntries.json?.entries?.[0];
  const aItem = aItems.json?.items?.[0];
  if (aEntry?.id) {
    const own = await call('GET', `/api/finance/entries/${aEntry.id}`, { token: C.tokenA });
    const other = await call('GET', `/api/finance/entries/${aEntry.id}`, { token: C.tokenB });
    check('G:entry', "B asks for A's finance entry id: 404 (and A can read it: positive control)", own.status === 200 && other.status === 404, `A ${own.status}, B ${other.status}`);
    if (aEntry.photoId) {
      const ph = await call('GET', `/api/finance/photos/${aEntry.photoId}`, { token: C.tokenB });
      check('G:photo', "B asks for A's receipt photo: 404", ph.status === 404, `status ${ph.status}`);
    }
  } else skip('G:entry', "B asks for A's finance entry id", 'A has no finance entry');
  if (aItem?.id) {
    const other = await call('GET', `/api/content/penceramah/${aItem.id}`, { token: C.tokenB });
    check('G:content', "B asks for A's content item id: 404", other.status === 404, `status ${other.status}`);
  } else skip('G:content', "B asks for A's content item id", 'A has no penceramah item');

  // ---- public routes ----
  const info = await call('GET', '/api/surau/info', { headers: { 'x-maxcom-box': 'ffffffffffffffff' } });
  check('U:info', 'an unknown box id gets the neutral public answer (no byte of A or B)', info.status === 200 && hit(info, [...aOnly, ...bOnly]).length === 0, `status ${info.status}`);
  const health = await call('GET', '/api/health');
  check('U:health', 'anonymous /api/health lists no site, box or surau of A or B', hit(health, [...aOnly, ...bOnly]).length === 0, `leaks ${hit(health, [...aOnly, ...bOnly]).join(', ')}`);
  for (const route of ['/api/suraus', '/api/fleet/pending']) {
    const anon = await call('GET', route);
    check(`U:${route}`, `${route} without a session`, anon.status === 401 || anon.status === 403, `status ${anon.status}`);
    const surauAdmin = await call('GET', route, { token: C.tokenA });
    check(`U:${route}:a`, `${route} as a surau admin`, surauAdmin.status === 403, `status ${surauAdmin.status}`);
  }

  // ---- the Pentadbir MAXCOM on a public device ----
  if (C.pubsa) {
    for (const route of ['/api/users', '/api/settings', '/api/content/penceramah', '/api/finance/entries', '/api/sync/snapshot']) {
      const res = await call('GET', route, { token: C.pubsa, headers: { 'x-maxcom-surau': C.surauB } });
      check(`M:${route}`, `public-device Pentadbir + X-Maxcom-Surau: B on ${route}: 403`, res.status === 403 && hit(res, bOnly).length === 0, `status ${res.status}`);
    }
    for (const route of ['/api/suraus', '/api/fleet/pending', `/api/suraus/${C.surauB}`]) {
      const res = await call('GET', route, { token: C.pubsa });
      check(`M:${route}`, `public-device Pentadbir on the fleet route ${route}: 403`, res.status === 403, `status ${res.status}`);
    }
    const me = await call('GET', '/api/auth/me', { token: C.pubsa });
    check('M:me', 'the public-device Pentadbir is told no ops role (no superadmin in /api/auth/me, ops false)', me.status === 200 && !(me.json?.roles ?? []).includes('superadmin') && me.json?.ops === false, `roles ${JSON.stringify(me.json?.roles)} ops ${me.json?.ops}`);
  } else skip('M', 'public-device Pentadbir MAXCOM checks', 'SECPROBE_TOKEN_PUBSA not set');

  // ---- the ops device (positive control: the same call works for the right actor) ----
  if (C.ops) {
    const noHeader = await call('GET', '/api/users', { token: C.ops });
    check('O:header', 'ops device without X-Maxcom-Surau: 400 surau_required', noHeader.status === 400, `status ${noHeader.status}`);
    const inB = await call('GET', '/api/users', { token: C.ops, headers: { 'x-maxcom-surau': C.surauB } });
    check('O:read', "ops device acting in B reads B's users and nothing of A (positive control)", inB.status === 200 && tokB.some((t) => inB.text.includes(t)) && hit(inB, aOnly).length === 0, `status ${inB.status}`);
    const list = await call('GET', '/api/suraus', { token: C.ops });
    check('O:fleet', 'ops device lists the fleet (positive control)', list.status === 200, `status ${list.status}`);
  } else skip('O', 'ops device positive controls', 'SECPROBE_TOKEN_OPS not set');

  // ---- decision 22: the `*` rows are hidden from a surau ----
  if (C.star.length > 0) {
    for (const route of ['/api/users', '/api/devices', '/api/sync/changes?since=0', '/api/sync/snapshot']) {
      const res = await call('GET', route, { token: C.tokenA });
      const rowTokens = route.startsWith('/api/sync') ? C.star.map((i) => `"entityId":"${i}"`) : C.star;
      check(`X:${route}`, `${route} for a surau admin lists no Pentadbir/Sokongan MAXCOM row`, hit(res, rowTokens).length === 0, `shows ${hit(res, rowTokens).join(', ')}`);
    }
  } else skip('X', 'hidden Pentadbir MAXCOM rows', 'SECPROBE_STAR_IDS not set');

  // ---- throwaway write probes: every one must be REFUSED ----
  if (!WRITE) {
    skip('W', 'write probes (header forgery writes, foreign entity ids from a site, approval without a target)', 'run with --write');
    return;
  }
  const aUsers = meA.json?.users ?? [];
  const aUserId = aUsers[0]?.id;
  if (aUserId) {
    const before = JSON.stringify((await call('GET', '/api/users', { token: C.tokenA })).json?.users ?? []);
    const de = await call('POST', `/api/users/${aUserId}/deactivate`, { token: C.tokenB, body: {} });
    check('W:deactivate', "B deactivates A's user: 404", de.status === 404, `status ${de.status}`);
    const roles = await call('PUT', `/api/users/${aUserId}/roles`, { token: C.tokenB, body: { roles: ['ajk'] } });
    check('W:roles', "B changes A's user roles: 404", roles.status === 404, `status ${roles.status}`);
    const forged = await call('PUT', `/api/users/${aUserId}/roles`, { token: C.tokenB, headers: { 'x-maxcom-surau': C.surauA }, body: { roles: ['ajk'] } });
    check('W:roles-header', "B + X-Maxcom-Surau: A changes A's user roles: 403", forged.status === 403, `status ${forged.status}`);
    const entry = { seq: 1, entity: 'user', entityId: aUserId, rev: '2026-11-13T00:00:00.000Z|probe', editedAt: '2026-11-13T00:00:00.000Z', syncedAt: '2026-11-13T00:00:00.000Z', actor: 'local', deviceId: null, origin: 'local', opId: null, after: { name: 'Dirampas', roles: ['admin'], active: false } };
    const push = await call('POST', '/api/sync/ops', { token: C.siteB, body: { entries: [entry] } });
    // the site is told plain `invalid` (it cannot probe which ids exist); the cloud's own log keeps `foreign_id`
    check('W:foreign-id', "B's site pushes A's user id: refused as invalid (never named foreign_id)", push.status === 200 && push.json?.refused === 1 && (push.json?.reasons ?? []).includes('invalid') && !(push.json?.reasons ?? []).includes('foreign_id'), `status ${push.status} ${push.text.slice(0, 120)}`);
    const origin = await call('POST', '/api/sync/ops', { token: C.siteB, body: { entries: [{ ...entry, entityId: 'probe-origin', entity: 'content:penceramah', origin: `box:${C.boxA}`, after: { id: 'probe-origin', name: 'Sondaan' } }] } });
    check('W:origin', "B's site claims A's box as origin: refused", origin.status === 200 && origin.json?.refused === 1 && origin.json?.applied === 0, `status ${origin.status} ${origin.text.slice(0, 120)}`);
    const ops = { ...entry, entity: 'device', entityId: 'probe-ops-device', after: { id: 'probe-ops-device', userId: aUserId, name: 'Sondaan', platform: 'web', ops: true } };
    const opsPush = await call('POST', '/api/sync/ops', { token: C.siteB, body: { entries: [ops] } });
    check('W:ops-flag', "a site entry carrying after.ops: refused", opsPush.status === 200 && opsPush.json?.refused === 1 && opsPush.json?.applied === 0, `status ${opsPush.status} ${opsPush.text.slice(0, 120)}`);
    const after = JSON.stringify((await call('GET', '/api/users', { token: C.tokenA })).json?.users ?? []);
    check('W:unchanged', "A's user list is byte-identical after the write probes", before === after, 'A changed');
  } else skip('W', 'write probes against a user of A', 'A has no readable user');
  if (aItem?.id) {
    const before = JSON.stringify((await call('GET', `/api/content/penceramah/${aItem.id}`, { token: C.tokenA })).json);
    await call('PUT', `/api/content/penceramah/${aItem.id}`, { token: C.tokenB, body: { name: 'Sondaan penyerang' } });
    await call('DELETE', `/api/content/penceramah/${aItem.id}`, { token: C.tokenB });
    const forged = await call('PUT', `/api/content/penceramah/${aItem.id}`, { token: C.tokenB, headers: { 'x-maxcom-surau': C.surauA }, body: { name: 'Sondaan penyerang' } });
    check('W:content-header', "B + X-Maxcom-Surau: A writes A's content: 403", forged.status === 403, `status ${forged.status}`);
    const after = JSON.stringify((await call('GET', `/api/content/penceramah/${aItem.id}`, { token: C.tokenA })).json);
    check('W:content', "A's content item is byte-identical after B's PUT and DELETE with its id", before === after, 'A changed');
  } else skip('W:content', "B writes A's content item id", 'A has no penceramah item');
  if (C.pubsa) {
    const grant = await call('PUT', `/api/users/${aUserId ?? 'x'}/roles`, { token: C.pubsa, body: { roles: ['admin', 'superadmin'] } });
    check('W:grant', 'a public-device Pentadbir grants superadmin by the route: refused', [400, 403, 404].includes(grant.status), `status ${grant.status}`);
    const approve = await call('POST', '/api/fleet/pending/0123456789abcdef/approve', { token: C.pubsa, body: {} });
    check('W:fleet', 'a public-device Pentadbir approves a box: 403', approve.status === 403, `status ${approve.status}`);
    const suspend = await call('POST', `/api/suraus/${C.surauB}/suspend`, { token: C.pubsa, body: { reason: 'sondaan' } });
    check('W:suspend', 'a public-device Pentadbir suspends a surau: 403', suspend.status === 403, `status ${suspend.status}`);
  }
  if (C.ops) {
    const noTarget = await call('POST', '/api/fleet/pending/0123456789abcdef/approve', { token: C.ops, body: {} });
    check('W:no-target', 'an approval without a target is refused (400 surau_required or 404 not_registered), never 200', noTarget.status === 400 || noTarget.status === 404, `status ${noTarget.status} ${noTarget.text.slice(0, 100)}`);
    const grant = await call('PUT', `/api/users/${aUserId ?? 'x'}/roles`, { token: C.ops, headers: { 'x-maxcom-surau': C.surauA }, body: { roles: ['admin', 'superadmin'] } });
    check('W:cli-only', 'an ops device grants superadmin by the route: 403 (CLI only)', grant.status === 403, `status ${grant.status}`);
  }
  skip('W:signed', 'signed op naming another surau / unlock with another box id / ops code without client', 'needs a device private key: covered in test/tenantIsolation.test.ts');
}

try {
  await main();
} catch (e) {
  fail('ERR', 'the probe itself failed', String(e?.stack ?? e));
}

const failed = rows.filter((r) => r.status === 'FAIL');
if (AS_JSON) {
  console.log(JSON.stringify({ base: base.origin, write: WRITE, rows, failed: failed.length }, null, 2));
} else {
  const w = Math.max(...rows.map((r) => r.id.length), 4);
  console.log(`MAXCOM isolation probe against ${base.origin} (${WRITE ? 'write probes ON' : 'read-only'})`);
  for (const r of rows) console.log(`${r.status}  ${r.id.padEnd(w)}  ${r.what}${r.detail && r.status !== 'PASS' ? `   <- ${r.detail}` : ''}`);
  console.log(`\n${rows.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${rows.filter((r) => r.status === 'SKIP').length} skipped`);
}
process.exit(failed.length > 0 ? 1 : 0);
