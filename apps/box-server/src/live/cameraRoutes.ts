import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { actorOf, deviceOf } from '../actor.ts';
import type { Limiters } from '../auth/authz.ts';
import { reqSurau } from '../reqSurau.ts';
import { getSettings } from '../settingsStore.ts';
import { CAMERA_MSG, CameraError, cameraPullUrl } from './camera.ts';
import type { CameraStore, CameraTestCode, CameraTester, PullMode } from './camera.ts';
import type { LiveSessions } from './sessions.ts';
import { ONVIF_MSG, OnvifClient, OnvifError } from './onvif.ts';
import { maskCameraUrl } from '@surau/core';

export interface CameraRouteDeps {
  db: DatabaseSync;
  store: CameraStore;
  /** The box tester; null when the box has no MediaMTX client (the test then answers "unavailable"). */
  tester: CameraTester | null;
  sessions: Pick<LiveSessions, 'current'>;
  limiters: Pick<Limiters, 'cameraTest' | 'cameraSource' | 'cameraDiscover' | 'cameraFill'>;
  /** The box's own LAN addresses: an address pointing at the box itself is refused. */
  boxIps: readonly string[];
  /** ONVIF discovery (O1); the real network client when left out. */
  onvif?: OnvifClient;
}

/** Fixed result texts (BM); the box never returns anything MediaMTX or the camera said. */
export const CAMERA_TEST_MSG: Record<CameraTestCode, string> = {
  ok: 'Berjaya. Kotak menerima gambar dari kamera.',
  unreachable: 'Gagal: kamera tidak dapat dihubungi',
  login: 'Gagal: nama pengguna atau kata laluan salah',
  path: 'Gagal: alamat strim tidak dijumpai',
  codec: 'Gagal: codec tidak disokong, guna H.264',
  busy: 'Ujian lain sedang berjalan. Cuba sebentar lagi.',
  not_configured: CAMERA_MSG.nothing,
  bad_address: CAMERA_MSG.badAddress,
  unavailable: 'Alat siaran tidak tersedia di kotak.',
};

const TEST_BUSY_LIVE = 'Siaran sedang berjalan. Uji sambungan selepas siaran tamat.';
const TOO_MANY = 'Terlalu banyak percubaan. Cuba sebentar lagi.';

const MODES: readonly PullMode[] = ['auto', 'tcp', 'udp'];

/** Routes of the external camera; every one has a row in ROUTE_PERMISSIONS (auth/authz.ts). */
export function registerCameraRoutes(app: FastifyInstance, deps: CameraRouteDeps): void {
  const { store, tester } = deps;
  const onvif = deps.onvif ?? new OnvifClient({ boxIps: deps.boxIps });

  const audit = (request: FastifyRequest, entityId: string, after: Record<string, unknown>): void => {
    deps.db
      .prepare('INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(reqSurau(request), new Date().toISOString(), actorOf(request), 'live-camera', entityId, null, JSON.stringify(after), deviceOf(request) ?? null);
  };

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof CameraError) return reply.code(error.status).header('Cache-Control', 'no-store').send({ errors: [error.message], code: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}) });
    // never the error text: it could come from anywhere near the address
    return reply.code(500).header('Cache-Control', 'no-store').send({ errors: ['Kamera tidak dapat diproses.'], code: 'camera_error' });
  };

  const limitKey = (request: FastifyRequest): string => {
    const a = request.auth;
    return a != null && a.kind === 'user' ? `s:${a.sessionId}` : `ip:${request.ip}`;
  };

  app.get('/api/live/camera', async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').send(store.getMasked());
  });

  app.put('/api/live/camera', async (request, reply) => {
    try {
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new CameraError(400, 'bad_address', CAMERA_MSG.badAddress);
      const b = body as Record<string, unknown>;
      const masked = store.save({
        url: typeof b.url === 'string' ? b.url : '',
        ...(typeof b.username === 'string' ? { username: b.username } : {}),
        ...(typeof b.password === 'string' ? { password: b.password } : {}),
      });
      // masked address only: the password never enters the audit
      audit(request, 'save', { url: masked.url, hasPassword: masked.hasPassword });
      return reply.header('Cache-Control', 'no-store').send(masked);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/live/camera', async (request, reply) => {
    try {
      store.clear();
      audit(request, 'clear', {});
      return reply.header('Cache-Control', 'no-store').send(store.getMasked());
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/live/camera/test', async (request, reply) => {
    try {
      const hit = deps.limiters.cameraTest.hit(limitKey(request));
      if (!hit.ok) return reply.code(429).header('Retry-After', String(hit.retryAfterSec)).header('Cache-Control', 'no-store').send({ errors: [TOO_MANY], code: 'too_many' });
      if (deps.sessions.current() !== null) {
        return reply.code(409).header('Cache-Control', 'no-store').send({ errors: [TEST_BUSY_LIVE], code: 'live_busy' });
      }
      const asked = (request.body as { transport?: unknown } | null)?.transport;
      const setting = getSettings(deps.db, reqSurau(request)).liveCamera.transport;
      const mode = (MODES as readonly unknown[]).includes(asked) ? (asked as PullMode) : (MODES as readonly unknown[]).includes(setting) ? (setting as PullMode) : 'auto';
      const record = store.get();
      const result =
        tester === null
          ? { code: 'unavailable' as const, ok: false, at: new Date().toISOString(), hasAudio: null, codecs: [], transport: null }
          : await tester.testCamera(record, mode, deps.boxIps);
      // only a test that reached the camera or failed on the network is kept with the record
      if (result.code !== 'busy' && result.code !== 'not_configured' && result.code !== 'bad_address' && result.code !== 'unavailable') store.setLastTest(result, record === null ? undefined : cameraPullUrl(record));
      audit(request, 'test', { code: result.code });
      return reply.header('Cache-Control', 'no-store').send({ ...result, message: CAMERA_TEST_MSG[result.code] });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // The phone pulls the camera itself (hybrid topology): it reads the full address here, in memory only.
  app.get('/api/live/camera/source', async (request, reply) => {
    try {
      const hit = deps.limiters.cameraSource.hit(limitKey(request));
      if (!hit.ok) return reply.code(429).header('Retry-After', String(hit.retryAfterSec)).header('Cache-Control', 'no-store').send({ errors: [TOO_MANY], code: 'too_many' });
      const record = store.get();
      if (record === null) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [CAMERA_MSG.nothing], code: 'not_configured' });
      audit(request, 'source-read', { device: deviceOf(request) ?? null });
      return reply.header('Cache-Control', 'no-store').send({ url: cameraPullUrl(record) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // O1: "Cari kamera di rangkaian". The probe leaves from the box's LAN interfaces; the answer is name + IP only.
  app.post('/api/live/camera/discover', async (request, reply) => {
    try {
      const hit = deps.limiters.cameraDiscover.hit(limitKey(request));
      if (!hit.ok) return reply.code(429).header('Retry-After', String(hit.retryAfterSec)).header('Cache-Control', 'no-store').send({ errors: [TOO_MANY], code: 'too_many' });
      const cameras = await onvif.discover();
      audit(request, 'discover', { found: cameras.length });
      return reply.header('Cache-Control', 'no-store').send({ cameras });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // O1: asks one camera for its RTSP address. The answer holds the login typed here merged into the address, once, for
  // the person who typed it to save through PUT /api/live/camera; nothing of it is audited or logged.
  app.post('/api/live/camera/discover/fill', async (request, reply) => {
    try {
      const hit = deps.limiters.cameraFill.hit(limitKey(request));
      if (!hit.ok) return reply.code(429).header('Retry-After', String(hit.retryAfterSec)).header('Cache-Control', 'no-store').send({ errors: [TOO_MANY], code: 'too_many' });
      const b = request.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new OnvifError('bad_address');
      const { ip, username, password } = b as Record<string, unknown>;
      if (typeof ip !== 'string' || (username !== undefined && typeof username !== 'string') || (password !== undefined && typeof password !== 'string')) throw new OnvifError('bad_address');
      const url = await onvif.fill(ip, username ?? '', password ?? '');
      audit(request, 'discover-fill', { ip, hasLogin: (username ?? '') !== '' });
      return reply.header('Cache-Control', 'no-store').send({ url, masked: maskCameraUrl(url) });
    } catch (error) {
      if (error instanceof OnvifError) {
        const status = error.code === 'bad_address' ? 400 : 422; // never 401: the app reads that as an expired session
        return reply.code(status).header('Cache-Control', 'no-store').send({ errors: [ONVIF_MSG[error.code]], code: error.code });
      }
      return fail(reply, error);
    }
  });
}
