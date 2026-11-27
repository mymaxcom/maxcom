import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { actorOf, deviceOf } from '../actor.ts';
import type { Limiters } from '../auth/authz.ts';
import { reqSurau } from '../reqSurau.ts';
import { LOCAL_SURAU_ID } from '../tenant.ts';
import { getSettings } from '../settingsStore.ts';
import { CAMERA_MSG, CameraError, cameraHostOf, cameraPullUrl } from './camera.ts';
import type { CameraStore, CameraTestCode, CameraTester, PullMode } from './camera.ts';
import { LiveError } from './sessions.ts';
import type { LiveSessions } from './sessions.ts';
import { ONVIF_MSG, OnvifClient, OnvifError } from './onvif.ts';
import { maskCameraUrl, CAMERA_CONTROL_PROTOCOLS, parseCameraProfile } from '@surau/core';
import type { CameraControlSetting } from '@surau/core';
import { CameraController, CONTROL_MSG, parseControlRequest } from './cameraControl.ts';

export interface CameraRouteDeps {
  db: DatabaseSync;
  store: CameraStore;
  /** The box tester; null when the box has no MediaMTX client (the test then answers "unavailable"). */
  tester: CameraTester | null;
  /** `cameraAddressFor` decides who may read the full address during a live (C5, the "camera in use" flag); the box always passes its sessions (only a bare test stand-in leaves it out). */
  sessions: Pick<LiveSessions, 'current'> & Partial<Pick<LiveSessions, 'cameraAddressFor' | 'releaseCamera'>>;
  limiters: Pick<Limiters, 'cameraTest' | 'cameraSource' | 'cameraDiscover' | 'cameraFill' | 'cameraControl'>;
  /** The box's own LAN addresses: an address pointing at the box itself is refused. */
  boxIps: readonly string[];
  /** ONVIF discovery (O1); the real network client when left out. */
  onvif?: OnvifClient;
  /** Network control of the camera (Lane X); the real controller (fixed ports) when left out. */
  control?: CameraController;
  /** Called once after the camera record was removed (the link backup drops its copy); errors are swallowed. */
  onCameraRemoved?: () => void;
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
/** What the box can do with the camera outside a request. */
export interface CameraRouteHandle {
  /** Sends the saved profile once when the opt-in and the "apply when a live starts" switch are both on. Best effort: never throws, never waits longer than the camera's own timeouts. */
  applyOnLive(): Promise<void>;
}

export function registerCameraRoutes(app: FastifyInstance, deps: CameraRouteDeps): CameraRouteHandle {
  const { store, tester } = deps;
  const onvif = deps.onvif ?? new OnvifClient({ boxIps: deps.boxIps });
  const controller = deps.control ?? new CameraController({ boxIps: deps.boxIps });

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
      try {
        deps.onCameraRemoved?.();
      } catch {
        /* removing the camera never fails because of what listens to it */
      }
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
      // C5 and the "camera in use" flag: while a live holds the camera only the device that pulls it gets the address;
      // everyone else joins the shared picture through the box. The refusal is on record too.
      try {
        deps.sessions.cameraAddressFor?.(deviceOf(request) ?? null);
      } catch (error) {
        if (!(error instanceof LiveError)) throw error;
        audit(request, 'source-refused', { device: deviceOf(request) ?? null, code: error.code });
        return reply.code(error.status).header('Cache-Control', 'no-store').send({ errors: [error.message], code: error.code });
      }
      audit(request, 'source-read', { device: deviceOf(request) ?? null });
      return reply.header('Cache-Control', 'no-store').send({ url: cameraPullUrl(record) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  // O4: the device that pulled the camera lets go of it (its "camera in use" flag clears); only the live's own device may.
  app.post('/api/live/camera/release', async (request, reply) => {
    try {
      const a = request.auth;
      const deviceId = a != null && a.kind === 'user' ? a.deviceId : null;
      const b = request.body;
      const sessionId = typeof b === 'object' && b !== null && typeof (b as { sessionId?: unknown }).sessionId === 'string' ? (b as { sessionId: string }).sessionId : '';
      if (sessionId === '') return reply.code(400).header('Cache-Control', 'no-store').send({ errors: ['Sesi siaran tidak sah.'], code: 'bad_session' });
      try {
        deps.sessions.releaseCamera?.(deviceId, sessionId);
      } catch (error) {
        if (!(error instanceof LiveError)) throw error;
        return reply.code(error.status).header('Cache-Control', 'no-store').send({ errors: [error.message], code: error.code });
      }
      audit(request, 'source-release', { device: deviceId });
      return reply.code(204).header('Cache-Control', 'no-store').send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Lane X: the opt-in for network control of the camera and its profile (live:settings). The address is not touched.
  // Every field is optional but the body must change something; a field that is present must be valid.
  app.put('/api/live/camera/control', async (request, reply) => {
    try {
      const bad = (): FastifyReply => reply.code(400).header('Cache-Control', 'no-store').send({ errors: [CONTROL_MSG.badAction], code: 'bad_setting' });
      const b = request.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad();
      const o = b as { enabled?: unknown; protocol?: unknown; profile?: unknown; applyOnLive?: unknown };
      if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return bad();
      if (o.applyOnLive !== undefined && typeof o.applyOnLive !== 'boolean') return bad();
      if (o.protocol !== undefined && !(CAMERA_CONTROL_PROTOCOLS as readonly unknown[]).includes(o.protocol)) return bad();
      const profile = o.profile === undefined ? null : parseCameraProfile(o.profile);
      if (o.profile !== undefined && profile === null) return bad();
      if (o.enabled === undefined && o.protocol === undefined && o.profile === undefined && o.applyOnLive === undefined) return bad();
      const now = store.getMasked().control;
      const next: CameraControlSetting = {
        enabled: o.enabled ?? now.enabled,
        protocol: (o.protocol as CameraControlSetting['protocol'] | undefined) ?? now.protocol,
        profile: profile ?? now.profile,
        applyOnLive: o.applyOnLive ?? now.applyOnLive,
      };
      if (!store.setControl(next)) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: [CAMERA_MSG.nothing], code: 'not_configured' });
      audit(request, 'control-setting', { enabled: next.enabled, protocol: next.protocol, profile: next.profile, applyOnLive: next.applyOnLive });
      return reply.header('Cache-Control', 'no-store').send(store.getMasked());
    } catch (error) {
      return fail(reply, error);
    }
  });

  // Lane X: one fixed action to the saved camera (live:control). The target is ALWAYS the saved camera's host; with the
  // opt-in off (the default) the route does not exist as far as the caller can tell and nothing is sent.
  app.post('/api/live/camera/control', async (request, reply) => {
    try {
      const record = store.get();
      const setting = store.getMasked().control;
      if (record === null || !setting.enabled) return reply.code(404).header('Cache-Control', 'no-store').send({ errors: ['Kawalan kamera tidak dihidupkan.'], code: 'control_off' });
      const key = deviceOf(request) ?? limitKey(request);
      const hit = deps.limiters.cameraControl.hit(key);
      if (!hit.ok) return reply.code(429).header('Retry-After', String(hit.retryAfterSec)).header('Cache-Control', 'no-store').send({ errors: [TOO_MANY], code: 'too_many' });
      const action = parseControlRequest(request.body);
      if (action === null) return reply.code(400).header('Cache-Control', 'no-store').send({ errors: [CONTROL_MSG.badAction], code: 'bad_action' });
      const host = cameraHostOf(cameraPullUrl(record));
      if (host === null) throw new CameraError(400, 'bad_address', CAMERA_MSG.badAddress);
      // applyProfile sends the SAVED profile (never one from the request); it is one call for the limit
      const result = action.action === 'applyProfile' ? await controller.applyProfile(host, setting.protocol, setting.profile) : await controller.send(host, setting.protocol, action);
      // what was asked and whether it was answered; never the address
      audit(request, 'control', { ...action, protocol: setting.protocol, sent: result.sent, confirmed: result.confirmed, ...(result.steps !== undefined ? { steps: result.steps } : {}) });
      return reply.header('Cache-Control', 'no-store').send(result);
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
  return {
    async applyOnLive(): Promise<void> {
      try {
        const record = store.get();
        const setting = store.getMasked().control;
        if (record === null || !setting.enabled || !setting.applyOnLive) return;
        const host = cameraHostOf(cameraPullUrl(record));
        if (host === null) return;
        const result = await controller.applyProfile(host, setting.protocol, setting.profile);
        deps.db
          .prepare('INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(LOCAL_SURAU_ID, new Date().toISOString(), 'system', 'live-camera', 'control', null, JSON.stringify({ action: 'applyProfile', when: 'live-start', protocol: setting.protocol, sent: result.sent, confirmed: result.confirmed, steps: result.steps ?? [] }), null);
      } catch {
        /* a live never fails or waits because of the camera's profile */
      }
    },
  };
}
