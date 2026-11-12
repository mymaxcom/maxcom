import { randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cleanYoutubeText, youtubeMetaFor } from '@surau/core';
import type { KioskLive, LiveOutputs, LiveSource, LiveStartRequest, LiveStatus, YoutubeMeta, YoutubeVia } from '@surau/core';
import { randomToken } from '../auth/crypto.ts';
import { getItem } from '../content/store.ts';
import { getSettings } from '../settingsStore.ts';
import type { FirewallState } from './firewall.ts';
import type { LiveRuntime, MediamtxPath } from './mediamtx.ts';
import { KIOSK_AUDIO_PATH, Relay } from './relay.ts';
import type { RelayOptions } from './relay.ts';

/** A refusal with the HTTP status and a stable code the app switches on. Messages carry no secret. */
export class LiveError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LiveError';
    this.status = status;
    this.code = code;
  }
}

export const LIVE_MSG = {
  liveOff: 'Siaran langsung di skrin dimatikan',
  toolsMissing: 'Perisian siaran belum dipasang di kotak',
  mediamtxDown: 'Pelayan siaran tidak berjalan',
  busy: 'Siaran sedang berjalan dari peranti lain',
  noKuliah: 'Kuliah tidak dijumpai',
  kuliahBatal: 'Kuliah ini telah dibatalkan',
  badRequest: 'Permintaan siaran tidak sah',
  noSession: 'Tiada siaran sedang berjalan',
  wrongSource: 'Siaran ini tidak dihantar dari pelayar',
  forbidden: 'Siaran ini dimulakan oleh peranti lain',
  rate: 'Terlalu banyak cubaan mula siaran. Cuba lagi sebentar lagi.',
  ytSignoutBusy: 'Siaran sedang berjalan. Hentikan siaran sebelum log keluar YouTube.',
} as const;

/** Start limiter: rolling hour. */
const START_WINDOW_MS = 3_600_000;
const START_MAX_PER_DEVICE = 6;
const START_MAX_PER_BOX = 12;

/** The warning code the app shows for a YouTube failure (the reason is a fixed vocabulary, never Google's text). */
function youtubeWarning(e: unknown): string {
  const reason = typeof e === 'object' && e !== null ? (e as { reason?: unknown }).reason : undefined;
  if (reason === 'quota') return 'youtube_quota';
  if (reason === 'reauthorise') return 'youtube_reauthorise';
  if (reason === 'forbidden') return 'youtube_forbidden';
  // the box's YouTube leg goes through the cloud (Plan 6): the cloud itself could not be reached
  if (reason === 'cloud_unreachable') return 'cloud_unreachable';
  return 'no_internet';
}

/** The YouTube side (Task 4 supplies the real one). Absent or signed out: the leg is skipped with a warning. */
export interface YoutubeLeg {
  signedIn(): boolean;
  /** Creates and binds the broadcast. The stream key it returns is held in memory only. */
  createBroadcastFor(req: { sessionId: string; meta: YoutubeMeta }): Promise<{ broadcastId: string; watchUrl: string; key: string }>;
  complete(broadcastId: string): Promise<void>;
  status(): LiveStatus['youtube'];
}

export interface LiveSessionsDeps {
  db: DatabaseSync;
  now: () => Date;
  runtime: LiveRuntime | null;
  /** Called with every new KioskLive (only when it differs from the previous one). */
  onKiosk: (live: KioskLive) => void;
  youtube?: YoutubeLeg | null;
  /** How often the ingest state is polled while a session is open (default 2000). */
  monitorMs?: number;
  /** No ingest for this long, at start or after it vanished, ends the session (default 10 min). */
  idleTimeoutMs?: number;
  /** The media-ports firewall check (cached by the check itself); without it the state is always unknown. */
  firewall?: { check(): Promise<FirewallState>; state(): FirewallState } | null;
  /** No picture for this long after the start (or after it vanished) shows `no_video_from_device` (default 12 s). */
  noVideoMs?: number | (() => number);
  /** Where relay.log is written; without it the box relay is not available. */
  dataDir?: string;
  /** Test hook: replaces the ffmpeg executable, arguments and timings of the relay. */
  relayOptions?: Partial<RelayOptions>;
  /** Pause between tries to set the publisher user and passphrase again after a MediaMTX respawn (default 500). */
  reprovisionMs?: number;
}

/** The credentials never leave this object except in the start answer to the owning device and in the proxies. */
interface Session {
  id: string;
  kuliahId: string | null;
  source: LiveSource;
  outputs: LiveOutputs;
  youtubeVia: YoutubeVia;
  startedAt: string;
  startedAtMs: number;
  startedBy: string;
  deviceId: string;
  kuliah: { label: string; penceramah: string; topic: string | null } | null;
  pubUser: string;
  pubPass: string;
  passphrase: string | null;
  broadcastId: string | null;
  watchUrl: string | null;
  youtubeKey: string | null;
  /** The broadcast is being created after the start answer (a sleeping cloud can take ~20 s). */
  ytPending: boolean;
  /** Why the YouTube leg could not start (a fixed warning code); shown through the status. */
  ytWarning: string | null;
  /** The ffmpeg relay of the box YouTube leg (youtubeVia 'box' with a key); null otherwise. */
  relay: Relay | null;
  /** The kiosk audio leg (ffmpeg: video copy + Opus republished to `surau-kiosk`); null while the kiosk audio is off. */
  audioLeg: Relay | null;
  /** The ingest dropped after the audio leg failed: the next return of the picture may replace the failed leg. */
  audioRetryArmed: boolean;
  /** WHIP session ids created through the proxy (only these may be deleted through it). */
  whipIds: Set<string>;
  lastReadyAtMs: number;
  everReadyAtMs: number | null;
  readySince: string | null;
  ready: boolean;
  ingestSource: MediamtxPath['source'];
  bitrateKbps: number;
  lastBytes: number;
  lastBytesAtMs: number;
  ingestMs: number;
  /** MediaMTX has not had the publisher path ready for `noVideoMs`: the app shows `no_video_from_device`. */
  noVideo: boolean;
}

export interface StartResult {
  session: NonNullable<LiveStatus['session']>;
  ingest: {
    whip: string;
    srt: { host: string; port: number; streamId: string; passphrase: string } | null;
  };
  /** `state: 'starting'` (additive): the broadcast is still being created; the box relay starts by itself when it is ready. */
  youtube: { via: YoutubeVia; ingest: string | null; key: string | null; state?: 'starting' } | null;
  kiosk: KioskLive;
  warnings?: string[];
}

/** Warning codes the app switches on (see LiveStatus.warnings and StartResult.warnings). */
export const MEDIA_PORTS_BLOCKED = 'media_ports_blocked';
export const NO_VIDEO_FROM_DEVICE = 'no_video_from_device';
const NO_VIDEO_MS = 12_000;
const isBlocked = (s: FirewallState): boolean => s === 'missing' || s === 'wrong';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PATH = 'surau';
const YOUTUBE_INGEST = 'rtmps://a.rtmps.youtube.com:443/live2';

/** Crypto-random alphanumeric string (rejection-free: randomInt is uniform). */
function randomAlnum(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[randomInt(ALNUM.length)];
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates the body of POST /api/live/start. Throws 400 on anything unexpected. */
export function parseStartRequest(body: unknown): LiveStartRequest {
  const bad = (): never => {
    throw new LiveError(400, 'bad_request', LIVE_MSG.badRequest);
  };
  if (!isRecord(body)) return bad();
  const { kuliahId, source, outputs, youtubeVia } = body;
  if (kuliahId !== null && (typeof kuliahId !== 'string' || kuliahId === '' || kuliahId.length > 100)) return bad();
  if (source !== 'android' && source !== 'web') return bad();
  if (!isRecord(outputs) || outputs.kiosk !== true || typeof outputs.youtube !== 'boolean') return bad();
  if (youtubeVia !== 'device' && youtubeVia !== 'box') return bad();
  // a browser cannot push RTMPS itself: its YouTube leg is always the box relay
  if (source === 'web' && outputs.youtube && youtubeVia !== 'box') return bad();
  return { kuliahId: kuliahId as string | null, source, outputs: { kiosk: true, youtube: outputs.youtube }, youtubeVia };
}

export class LiveSessions {
  private session: Session | null = null;
  private starting: Promise<StartResult> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastKiosk = '';
  private ticking = false;
  /** Slow MediaMTX/ffmpeg/YouTube clean-up of ended sessions and legs; a new start waits for it. */
  private cleanup: Promise<void> = Promise.resolve();
  private readonly monitorMs: number;
  private readonly idleMs: number;
  /** Bumped by every respawn so an older re-provision loop ends. */
  private provisionGen = 0;
  /** Starts of the last hour (device and time) for the limiter. */
  private starts: Array<{ at: number; deviceId: string }> = [];

  private readonly d: LiveSessionsDeps;

  /** How long without a picture before `no_video_from_device`: read fresh each check, so a settings change applies at once. */
  private noVideoMs(): number {
    const v = this.d.noVideoMs;
    const n = typeof v === 'function' ? v() : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : NO_VIDEO_MS;
  }

  constructor(deps: LiveSessionsDeps) {
    this.d = deps;
    this.monitorMs = deps.monitorMs ?? 2000;
    this.idleMs = deps.idleTimeoutMs ?? 600_000;
    // MediaMTX keeps the publisher user and the SRT passphrase in memory only: a respawn loses them
    deps.runtime?.spawnListeners.add(() => this.reprovision());
  }

  /** Sets the session's publisher user and SRT passphrase in MediaMTX. */
  private async provision(s: Session, api: NonNullable<LiveRuntime['api']>): Promise<void> {
    await api.authUserAdd({ user: s.pubUser, pass: s.pubPass, permissions: [{ action: 'publish', path: PATH }] });
    await api.pathsPatch(PATH, { srtPublishPassphrase: s.passphrase ?? '' });
  }

  /**
   * MediaMTX was (re)spawned while a session is open: set its credentials again, retrying until the API
   * answers (the process is up before its API is). The relays re-add their own read users every loop.
   */
  private reprovision(): void {
    const s = this.session;
    const api = this.d.runtime?.api;
    if (s === null || !api) return;
    const gen = ++this.provisionGen;
    const pause = this.d.reprovisionMs ?? 500;
    void (async () => {
      for (let i = 0; i < 120; i++) {
        if (this.session !== s || gen !== this.provisionGen) return;
        try {
          await this.provision(s, api);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, pause).unref());
        }
      }
      console.warn('live: the publisher credentials could not be restored after a MediaMTX restart (reason: mediamtx_unreachable)');
    })();
  }

  /** The limiter: false when this device or the box started too often in the last hour. */
  private startAllowed(deviceId: string): boolean {
    const nowMs = this.d.now().getTime();
    this.starts = this.starts.filter((x) => nowMs - x.at < START_WINDOW_MS);
    return this.starts.length < START_MAX_PER_BOX && this.starts.filter((x) => x.deviceId === deviceId).length < START_MAX_PER_DEVICE;
  }

  /* ------------------------------------------------------------------ reads */

  current(): { id: string; deviceId: string; source: LiveSource } | null {
    const s = this.session;
    return s === null ? null : { id: s.id, deviceId: s.deviceId, source: s.source };
  }

  /** The state the kiosk shows. Computed on every call from the cached ingest state and the live settings. */
  kioskLive(): KioskLive {
    const settings = getSettings(this.d.db).liveOnKiosk;
    const s = this.session;
    const audio = settings.audio === true;
    const volume = typeof settings.volume === 'number' ? settings.volume : 50;
    const path = this.kioskPath();
    if (s === null || !s.ready || settings.enabled !== true) {
      return { live: false, since: null, kuliah: s?.kuliah ?? null, audio, volume, path };
    }
    return { live: true, since: s.readySince, kuliah: s.kuliah, audio, volume, path };
  }

  /** The media-ports firewall state (a cached read-only check); unknown when no check is wired. Never throws. */
  async checkFirewall(): Promise<FirewallState> {
    try {
      return (await this.d.firewall?.check()) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Asks the firewall check for a fresh state without waiting (the check itself reuses a result under 60 s old). */
  private refreshFirewall(): void {
    void this.checkFirewall();
  }

  /** Standing warnings for the app: the firewall state and the no-picture watchdog. */
  private warnings(): string[] {
    const out: string[] = [];
    if (isBlocked(this.d.firewall?.state() ?? 'unknown')) out.push(MEDIA_PORTS_BLOCKED);
    if (this.session?.noVideo === true) out.push(NO_VIDEO_FROM_DEVICE);
    if (this.session?.ytWarning != null) out.push(this.session.ytWarning);
    return out;
  }

  status(): LiveStatus {
    const rt = this.d.runtime;
    const s = this.session;
    const yt = this.d.youtube?.status();
    return {
      session:
        s === null
          ? null
          : { id: s.id, kuliahId: s.kuliahId, source: s.source, outputs: s.outputs, youtubeVia: s.youtubeVia, startedAt: s.startedAt, startedBy: s.startedBy },
      mediamtx: {
        running: rt?.supervisor?.status().running === true,
        tools: { mediamtx: rt?.tools.mediamtx != null, ffmpeg: rt?.tools.ffmpeg != null },
      },
      warnings: this.warnings(),
      ingest: {
        ready: s?.ready === true,
        protocol: s?.ready !== true ? null : s.ingestSource?.type === 'webRTCSession' ? 'whip' : s.ingestSource?.type === 'srtConn' ? 'srt' : null,
        bitrateKbps: s?.ready === true ? s.bitrateKbps : 0,
        since: s?.ready === true ? s.readySince : null,
      },
      relay: s?.relay?.status() ?? { state: 'off', restarts: 0, lastError: null },
      youtube: yt ?? { signedIn: false, channelTitle: null, broadcastId: s?.broadcastId ?? null, state: 'none', health: null, watchUrl: s?.watchUrl ?? null, lastError: null },
    };
  }

  /** Health block for the admin answer. */
  healthBlock(): {
    tools: { mediamtx: boolean; ffmpeg: boolean };
    mediamtx: { running: boolean; restarts: number; reason?: 'mediamtx_version'; version?: string };
    /** `ok`, `missing`, `wrong` (the media-port rules) or `unknown` (not Windows, not checked, query failed). */
    firewall: FirewallState;
    session: string | null;
  } {
    const rt = this.d.runtime;
    const st = rt?.supervisor?.status();
    return {
      tools: { mediamtx: rt?.tools.mediamtx != null, ffmpeg: rt?.tools.ffmpeg != null },
      mediamtx: {
        running: st?.running === true,
        restarts: st?.restarts ?? 0,
        // an installed MediaMTX older than the template needs is never started: say why
        ...(rt?.tools.mediamtxTooOld != null ? { reason: 'mediamtx_version' as const, version: rt.tools.mediamtxTooOld } : {}),
      },
      firewall: this.d.firewall?.state() ?? 'unknown',
      session: this.session?.id ?? null,
    };
  }

  /** Credentials for the WHIP proxy; null unless this device owns the open session. Throws the right refusal otherwise. */
  publisherFor(deviceId: string): { sessionId: string; authorization: string; whipIds: Set<string> } {
    const s = this.session;
    if (s === null) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    if (s.deviceId !== deviceId) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    if (s.source !== 'web') throw new LiveError(409, 'wrong_source', LIVE_MSG.wrongSource);
    return { sessionId: s.id, authorization: `Basic ${Buffer.from(`${s.pubUser}:${s.pubPass}`).toString('base64')}`, whipIds: s.whipIds };
  }

  /** The stream key held for the box relay (Task 5); null when the leg is not via the box. */
  relayKey(): string | null {
    const s = this.session;
    return s !== null && s.youtubeVia === 'box' ? s.youtubeKey : null;
  }

  /**
   * The phone's own YouTube leg (youtubeVia 'device') after a start that answered before the broadcast existed:
   * only the owning device may read it, for as long as the session is open (it may read it again, for example
   * after the app restarts mid-live). `starting` while pending, `failed` when the warning is set.
   */
  deviceYoutubeFor(deviceId: string): { state: 'none' | 'starting' | 'ready' | 'failed'; ingest: string | null; key: string | null } {
    const s = this.session;
    if (s === null) throw new LiveError(409, 'no_session', LIVE_MSG.noSession);
    if (s.deviceId !== deviceId) throw new LiveError(403, 'not_owner', LIVE_MSG.forbidden);
    if (s.youtubeVia !== 'device') return { state: 'none', ingest: null, key: null };
    if (s.ytPending) return { state: 'starting', ingest: null, key: null };
    if (s.youtubeKey === null) return { state: s.ytWarning !== null ? 'failed' : 'none', ingest: null, key: null };
    return { state: 'ready', ingest: YOUTUBE_INGEST, key: s.youtubeKey };
  }

  /** Starts ffmpeg for the box YouTube leg. It waits for the picture itself; a problem shows in the status, never in the start. */
  private startRelay(s: Session, yt: { relayVideo: unknown; maxBitrateKbps: unknown }): void {
    const key = this.relayKey();
    const rt = this.d.runtime;
    if (key === null || s.relay !== null || this.d.dataDir === undefined || rt?.api == null) return;
    const ffmpegPath = this.d.relayOptions?.ffmpegPath ?? rt.tools.ffmpeg;
    if (ffmpegPath == null) return;
    try {
      const relay = new Relay({ ...this.d.relayOptions, ffmpegPath, api: rt.api, dataDir: this.d.dataDir, sessionId: s.id, path: PATH });
      s.relay = relay;
      relay.start({
        key,
        relayVideo: yt.relayVideo === 'reencode' ? 'reencode' : 'copy',
        maxBitrateKbps: typeof yt.maxBitrateKbps === 'number' ? yt.maxBitrateKbps : 2500,
      });
      rt.secrets.add(relay.readPassword());
    } catch {
      console.warn('live: the YouTube relay could not be started (reason: relay_error)');
    }
  }

  /** Resolves when every clean-up left running by an earlier stop has finished (tests, shutdown, the next start). */
  settled(): Promise<void> {
    return this.cleanup;
  }

  private track(job: Promise<unknown>): void {
    this.cleanup = this.cleanup.then(
      () => job.then(() => undefined, () => undefined),
      () => job.then(() => undefined, () => undefined),
    );
  }

  /**
   * The MediaMTX path the kiosk's WHEP reads. WebRTC cannot carry the phone's AAC sound, so while the
   * kiosk audio is ON and the audio leg is actually `running` the kiosk reads the Opus copy `surau-kiosk`.
   * While the leg starts or retries, after it failed, and with the audio OFF, it reads `surau` directly,
   * so the kiosk always has a picture. A change of this value is part of the kiosk live event.
   */
  kioskPath(): 'surau' | 'surau-kiosk' {
    const leg = this.session?.audioLeg;
    if (leg == null) return PATH;
    return leg.status().state === 'running' ? KIOSK_AUDIO_PATH : PATH;
  }

  /** Starts or ends the kiosk audio leg so it matches the live settings and the open session. */
  private syncAudioLeg(): void {
    const s = this.session;
    if (s === null) return;
    const settings = getSettings(this.d.db).liveOnKiosk;
    const want = settings.enabled === true && settings.audio === true;
    if (!want) {
      const leg = s.audioLeg;
      if (leg !== null) {
        s.audioLeg = null;
        this.track(leg.stop());
      }
      return;
    }
    if (s.audioLeg !== null) {
      // a leg that gave up while the ingest was down is replaced as soon as the picture is back
      if (s.audioLeg.status().state !== 'failed' || !s.ready || !s.audioRetryArmed) return;
      s.audioRetryArmed = false;
      const dead = s.audioLeg;
      s.audioLeg = null;
      this.track(dead.stop());
    }
    const rt = this.d.runtime;
    if (this.d.dataDir === undefined || rt?.api == null) return;
    const ffmpegPath = this.d.relayOptions?.ffmpegPath ?? rt.tools.ffmpeg;
    if (ffmpegPath == null) return;
    try {
      const leg = new Relay({
        ...this.d.relayOptions,
        ffmpegPath,
        api: rt.api,
        dataDir: this.d.dataDir,
        sessionId: s.id,
        path: PATH,
        kind: 'kioskAudio',
        logName: 'kiosk-audio.log',
      });
      s.audioLeg = leg;
      // a leg ended a moment ago removes its own user: start after that so the new user is not removed under it
      void this.cleanup.then(() => {
        if (s.audioLeg !== leg) return;
        leg.start({ key: '', relayVideo: 'copy', maxBitrateKbps: 0 });
        rt.secrets.add(leg.readPassword());
      });
    } catch {
      console.warn('live: the kiosk audio leg could not be started (reason: relay_error)');
    }
  }

  /* ------------------------------------------------------------------ start */

  start(req: LiveStartRequest, actor: string, deviceId: string, lanHost: string): Promise<StartResult> {
    const existing = this.session;
    if (existing !== null) {
      if (existing.deviceId !== deviceId) return Promise.reject(this.busy(existing));
      // the same device asking again gets its own session back (a reconnect after an app restart)
      // (a reconnect is not counted by the start limiter)
      this.refreshFirewall();
      return (this.starting ?? Promise.resolve(null)).then(() => this.answer(existing, lanHost, isBlocked(this.d.firewall?.state() ?? 'unknown') ? [MEDIA_PORTS_BLOCKED] : []));
    }
    if (!this.startAllowed(deviceId)) return Promise.reject(new LiveError(429, 'live_rate', LIVE_MSG.rate));
    const job = this.doStart(req, actor, deviceId, lanHost);
    this.starting = job;
    const clear = (): void => {
      if (this.starting === job) this.starting = null;
    };
    job.then(clear, clear);
    return job;
  }

  private busy(s: Session): LiveError {
    const row = this.d.db.prepare('SELECT name FROM devices WHERE id = ?').get(s.deviceId) as { name?: unknown } | undefined;
    const name = typeof row?.name === 'string' && row.name !== '' ? ` (${row.name})` : '';
    return new LiveError(409, 'live_busy', `${LIVE_MSG.busy}${name}`);
  }

  private async doStart(req: LiveStartRequest, actor: string, deviceId: string, lanHost: string): Promise<StartResult> {
    const rt = this.d.runtime;
    const settings = getSettings(this.d.db);
    if (settings.liveOnKiosk.enabled !== true) throw new LiveError(409, 'live_off', LIVE_MSG.liveOff);
    const needsFfmpeg = req.outputs.youtube && req.youtubeVia === 'box';
    if (rt === null || rt.tools.mediamtx === null || (needsFfmpeg && rt.tools.ffmpeg === null)) {
      throw new LiveError(503, 'tools_missing', LIVE_MSG.toolsMissing);
    }
    if (rt.supervisor?.status().running !== true || rt.api === null) throw new LiveError(503, 'mediamtx_down', LIVE_MSG.mediamtxDown);
    const api = rt.api;

    let kuliah: Session['kuliah'] = null;
    let meta: YoutubeMeta | null = null;
    const surauName = settings.surauInfo.name.trim();
    if (req.kuliahId !== null) {
      const k = getItem(this.d.db, 'kuliah', req.kuliahId);
      if (k === null) throw new LiveError(404, 'kuliah_not_found', LIVE_MSG.noKuliah);
      if (k.status !== 'aktif') throw new LiveError(409, 'kuliah_batal', LIVE_MSG.kuliahBatal);
      const p = getItem(this.d.db, 'penceramah', k.penceramahId);
      kuliah = { label: k.label, penceramah: p?.name ?? '', topic: k.topic !== undefined && k.topic !== '' ? k.topic : null };
      if (p !== null) {
        const kitab = k.kitabId !== undefined ? getItem(this.d.db, 'kitab', k.kitabId) : null;
        meta = youtubeMetaFor({ kuliah: k, penceramah: p, kitab, surauName, settings: settings.liveYoutube, now: this.d.now() });
      }
    }

    const nowMs = this.d.now().getTime();
    const id = randomToken(12);
    const session: Session = {
      id,
      kuliahId: req.kuliahId,
      source: req.source,
      outputs: req.outputs,
      youtubeVia: req.youtubeVia,
      startedAt: new Date(nowMs).toISOString(),
      startedAtMs: nowMs,
      startedBy: actor,
      deviceId,
      kuliah,
      pubUser: `pub-${id}`,
      pubPass: randomAlnum(32),
      passphrase: req.source === 'android' ? randomAlnum(24) : null,
      broadcastId: null,
      watchUrl: null,
      youtubeKey: null,
      ytPending: false,
      ytWarning: null,
      relay: null,
      audioLeg: null,
      audioRetryArmed: false,
      whipIds: new Set(),
      lastReadyAtMs: nowMs,
      everReadyAtMs: null,
      readySince: null,
      ready: false,
      ingestSource: null,
      bitrateKbps: 0,
      lastBytes: 0,
      lastBytesAtMs: nowMs,
      ingestMs: 0,
      noVideo: false,
    };
    // claim the box before any await: a second start now sees the session and is refused
    this.session = session;
    this.starts.push({ at: nowMs, deviceId });
    // MediaMTX logs the SRT stream id: its log is scrubbed of these for good
    this.d.runtime?.secrets.add(session.pubPass, session.passphrase);
    try {
      // an earlier session's clean-up must finish first: it clears the shared passphrase and its own user
      await this.cleanup;
      await this.provision(session, api);
    } catch {
      await this.release(session);
      if (this.session === session) this.session = null;
      throw new LiveError(503, 'mediamtx_down', LIVE_MSG.mediamtxDown);
    }

    const warnings: string[] = [];
    let pendingYoutube: (() => void) | null = null;
    try {
      // the phone's video needs the two UDP rules: live still starts without them (the phone records), but says so
      if (isBlocked(await this.checkFirewall())) warnings.push(MEDIA_PORTS_BLOCKED);
      if (req.outputs.youtube) {
        const yt = this.d.youtube;
        if (settings.liveYoutube.enabled !== true) warnings.push('youtube_off');
        else if (!yt || !yt.signedIn()) warnings.push('youtube_not_signed_in');
        else {
          // the broadcast is made after the answer: a sleeping cloud must not delay the phone or the kiosk
          session.ytPending = true;
          pendingYoutube = () =>
            this.createBroadcastLater(session, yt, meta ?? { title: Array.from(cleanYoutubeText(`Kuliah ${surauName}`).trim()).slice(0, 100).join('').trim(), description: '', privacy: settings.liveYoutube.privacy }, settings.liveYoutube);
        }
      }

      this.startRelay(session, settings.liveYoutube);
      this.audit('live', id, actor, null, {
        kuliahId: session.kuliahId,
        source: session.source,
        outputs: session.outputs,
        youtubeVia: session.youtubeVia,
        broadcastId: session.broadcastId,
      });
      // the no-picture window starts now, when the phone is about to get its ingest URL, not when the session was claimed
      session.lastReadyAtMs = this.d.now().getTime();
      this.startMonitor();
      this.publishKiosk();
      const answer = this.answer(session, lanHost, warnings);
      pendingYoutube?.();
      return answer;
    } catch (error) {
      // a throw after the claim must not leave a half-open session that blocks every later start
      if (this.session === session) {
        this.session = null;
        this.stopMonitor();
        this.track(this.teardown(session));
        this.publishKiosk();
      }
      throw error;
    }
  }

  /** Creates the broadcast after the start answer; completes it when the session is gone by then, warns when it fails. */
  private createBroadcastLater(s: Session, yt: YoutubeLeg, meta: YoutubeMeta, settings: { relayVideo: unknown; maxBitrateKbps: unknown }): void {
    // not tracked as a whole: a broadcast that never answers must not hold up the box shutdown
    void (async (): Promise<void> => {
      let made: { broadcastId: string; watchUrl: string; key: string };
      try {
        made = await yt.createBroadcastFor({ sessionId: s.id, meta });
      } catch (e) {
        if (this.session === s) {
          s.ytPending = false;
          s.ytWarning = youtubeWarning(e);
        }
        return;
      }
      if (this.session !== s) {
        // the session ended while the broadcast was being made: never leave it open
        this.track(yt.complete(made.broadcastId).catch(() => undefined));
        return;
      }
      s.broadcastId = made.broadcastId;
      s.watchUrl = made.watchUrl;
      s.youtubeKey = made.key;
      s.ytPending = false;
      this.startRelay(s, settings);
    })();
  }

  private answer(s: Session, lanHost: string, warnings: string[]): StartResult {
    const hasKey = s.youtubeKey !== null;
    const result: StartResult = {
      session: { id: s.id, kuliahId: s.kuliahId, source: s.source, outputs: s.outputs, youtubeVia: s.youtubeVia, startedAt: s.startedAt, startedBy: s.startedBy },
      ingest: {
        whip: '/api/live/whip',
        srt:
          s.passphrase === null
            ? null
            : { host: lanHost, port: 8890, streamId: `publish:${PATH}:${s.pubUser}:${s.pubPass}`, passphrase: s.passphrase },
      },
      youtube: s.ytPending
        ? { via: s.youtubeVia, ingest: null, key: null, state: 'starting' }
        : !hasKey
        ? null
        : s.youtubeVia === 'device'
          ? { via: 'device', ingest: YOUTUBE_INGEST, key: s.youtubeKey }
          : { via: 'box', ingest: null, key: null },
      kiosk: this.kioskLive(),
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  /* ------------------------------------------------------------------ stop */

  /**
   * Ends the session (when `id` is given it must match). Safe to call twice. The session is gone for every
   * caller at once; with `background` the slow clean-up (ffmpeg, MediaMTX users, YouTube) runs after this
   * returns (the HTTP stop answers promptly) and a new start waits for it.
   */
  async stop(id: string | undefined, actor: string, reason = 'stopped', opts: { background?: boolean } = {}): Promise<{ stopped: boolean }> {
    const s = this.session;
    if (s === null || (id !== undefined && id !== s.id)) return { stopped: false };
    // a session still being created is waited for so its credentials are not orphaned
    await this.starting?.catch(() => undefined);
    if (this.session !== s) return { stopped: false };
    this.session = null;
    this.stopMonitor();
    const stoppedMs = this.d.now().getTime();
    this.audit('live', s.id, actor, null, {
      kuliahId: s.kuliahId,
      source: s.source,
      outputs: s.outputs,
      youtubeVia: s.youtubeVia,
      broadcastId: s.broadcastId,
      stoppedAt: new Date(stoppedMs).toISOString(),
      reason,
      ingestSeconds: Math.round(s.ingestMs / 1000),
    });
    // the kiosk goes dark at once; the box clean-up follows
    this.publishKiosk();
    const job = this.teardown(s);
    this.track(job);
    if (opts.background !== true) await job;
    return { stopped: true };
  }

  /** Everything slow about ending a session; never throws. */
  private async teardown(s: Session): Promise<void> {
    // the relays go first: ffmpeg must not outlive the credentials it reads with
    const legs = [s.relay, s.audioLeg];
    s.audioLeg = null;
    await Promise.all(legs.map((leg) => leg?.stop().catch(() => undefined)));
    await this.release(s);
    if (s.broadcastId !== null) {
      try {
        await this.d.youtube?.complete(s.broadcastId);
      } catch {
        /* the YouTube state shows the error; stopping the local side never waits on the internet */
      }
    }
  }

  /** Removes the per-session MediaMTX user and passphrase and disconnects the publisher. Best effort. */
  private async release(s: Session): Promise<void> {
    const api = this.d.runtime?.api;
    if (!api) return;
    try {
      const p = await api.pathGet(PATH);
      if (p.source !== null) await api.kickPublisher(p.source);
    } catch {
      /* MediaMTX may already be gone */
    }
    try {
      await api.authUserRemove(s.pubUser);
    } catch {
      console.warn('live: could not remove the publisher user (reason: mediamtx_unreachable)');
    }
    if (s.passphrase !== null) {
      try {
        await api.pathsPatch(PATH, { srtPublishPassphrase: '' });
      } catch {
        /* the user is gone, so the passphrase alone opens nothing */
      }
    }
  }

  /** Stops the session if one is open and the box is closing. */
  async shutdown(): Promise<void> {
    this.stopMonitor();
    await this.stop(undefined, 'system', 'shutdown');
    await this.cleanup;
  }

  /* ------------------------------------------------------------------ monitor */

  private startMonitor(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.monitorMs);
    this.timer.unref();
  }

  private stopMonitor(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One monitor round: poll MediaMTX, update readiness, end an idle session, announce a changed KioskLive. */
  async tick(): Promise<void> {
    const s = this.session;
    if (s === null || this.ticking) return;
    this.ticking = true;
    try {
      this.refreshFirewall();
      let path: MediamtxPath | null = null;
      try {
        path = (await this.d.runtime?.api?.pathGet(PATH)) ?? null;
      } catch {
        path = null;
      }
      if (this.session !== s) return;
      const nowMs = this.d.now().getTime();
      const ready = path?.ready === true;
      if (ready) {
        if (!s.ready) {
          s.readySince = new Date(nowMs).toISOString();
          s.lastBytes = path!.bytesReceived;
          s.lastBytesAtMs = nowMs;
        } else {
          const dt = nowMs - s.lastBytesAtMs;
          if (dt >= 1000) {
            s.bitrateKbps = Math.max(0, Math.round(((path!.bytesReceived - s.lastBytes) * 8) / dt));
            s.lastBytes = path!.bytesReceived;
            s.lastBytesAtMs = nowMs;
          }
          s.ingestMs += Math.max(0, nowMs - s.lastReadyAtMs);
        }
        s.everReadyAtMs ??= nowMs;
        s.lastReadyAtMs = nowMs;
        s.ingestSource = path!.source;
      } else {
        s.readySince = null;
        s.bitrateKbps = 0;
        s.ingestSource = null;
        if (s.audioLeg?.status().state === 'failed') s.audioRetryArmed = true;
      }
      s.ready = ready;
      // the watchdog: no picture for noVideoMs since the start (or since it vanished); cleared when it returns
      s.noVideo = !ready && nowMs - s.lastReadyAtMs >= this.noVideoMs();
      if (!ready && nowMs - s.lastReadyAtMs >= this.idleMs) {
        await this.stop(s.id, 'system', 'timeout');
        return;
      }
      this.publishKiosk();
    } finally {
      this.ticking = false;
    }
  }

  /** Emits a `live` event when the kiosk-visible state changed (also called when the settings change). */
  publishKiosk(): void {
    this.syncAudioLeg();
    const k = this.kioskLive();
    const text = JSON.stringify(k);
    if (text === this.lastKiosk) return;
    this.lastKiosk = text;
    try {
      this.d.onKiosk(k);
    } catch {
      /* a broken listener never breaks live */
    }
  }

  /* ------------------------------------------------------------------ audit */

  private audit(entity: string, entityId: string, actor: string, before: unknown, after: Record<string, unknown>): void {
    this.d.db
      .prepare('INSERT INTO change_log (at, actor, entity, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.d.now().toISOString(), actor, entity, entityId, before === null ? null : JSON.stringify(before), JSON.stringify(after));
  }
}
