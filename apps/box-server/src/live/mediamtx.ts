import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_MEDIAMTX_VERSION, liveTools } from './tools.ts';
import type { LiveTools } from './tools.ts';

/* ---------------------------------------------------------------- config rendering */

const TEMPLATE_PATH = fileURLToPath(new URL('./mediamtx.template.yml', import.meta.url));
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function yamlQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** MediaMTX accepts `sha256:<base64 of the SHA-256 digest>` in place of a clear password. */
export function mediamtxPasswordHash(password: string): string {
  return `sha256:${createHash('sha256').update(password).digest('base64')}`;
}

export interface RenderOptions {
  dataDir: string;
  /** LAN IP literals the box is reachable on (the certificate's IP SANs). */
  lanIps: string[];
  /** The box's own MediaMTX password (clear); only its hash is written into the file. */
  password: string;
  template?: string;
}

/** True for 127.0.0.0/8, ::1 and link-local addresses: never a candidate a phone or iPad can use. */
function isLocalOnly(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower.startsWith('127.') || lower === '::1' || lower.startsWith('169.254.') || lower.startsWith('fe80:');
}

/**
 * The addresses WebRTC advertises as ICE host candidates: exactly the LAN addresses the certificate names
 * (the ones the phone and the iPad reach the box on), never an interface the box merely has (a VPN, a
 * hotspot). Loopback is used only when the certificate names no LAN address at all (a development box).
 */
export function webrtcAdvertisedHosts(lanIps: string[]): string[] {
  const lan = [...new Set(lanIps.filter((ip) => !isLocalOnly(ip)))];
  return lan.length > 0 ? lan : ['127.0.0.1'];
}

/**
 * The host the two LAN UDP media sockets (WebRTC ICE 8189, SRT 8890) bind to: the certificate's single LAN
 * address, so no other interface (a VPN, a hotspot) can carry media. With zero or several LAN addresses the
 * sockets stay on every interface (empty host); the advertised ICE hosts are still only the certificate's.
 */
export function mediaBindHost(lanIps: string[]): string {
  const lan = webrtcAdvertisedHosts(lanIps).filter((ip) => !isLocalOnly(ip));
  if (lan.length !== 1) return '';
  const ip = lan[0] as string;
  return isIP(ip) === 6 ? `[${ip}]` : ip;
}

/** Renders the MediaMTX config. HTTP, RTSP and the API are loopback; only UDP 8189 and 8890 face the LAN. */
export function renderMediamtxConfig(o: RenderOptions): string {
  for (const ip of o.lanIps) {
    if (isIP(ip) === 0) throw new Error('mediamtx config: LAN address is not an IP literal');
  }
  const hosts = webrtcAdvertisedHosts(o.lanIps);
  const template = o.template ?? readFileSync(TEMPLATE_PATH, 'utf8');
  const values: Record<string, string> = {
    HOSTS: `[${hosts.map(yamlQuote).join(', ')}]`,
    BOX_PASS_HASH: yamlQuote(mediamtxPasswordHash(o.password)),
    MEDIA_HOST: mediaBindHost(o.lanIps),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`mediamtx config: unknown placeholder ${key}`);
    return value;
  });
}

/** The box's own MediaMTX credential: created once under <dataDir>/secret, never logged. */
export function ensureBoxPassword(dataDir: string): string {
  const dir = join(dataDir, 'secret');
  const path = join(dir, 'mediamtx.pass');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[A-Za-z0-9]{32}$/.test(existing)) return existing;
  }
  let pass = '';
  for (let i = 0; i < 32; i++) pass += ALNUM[randomInt(ALNUM.length)];
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, pass);
  } finally {
    closeSync(fd);
  }
  return pass;
}

/** Writes <dataDir>/live/mediamtx.yml and returns its path. */
export function writeMediamtxConfig(o: RenderOptions): string {
  const dir = join(o.dataDir, 'live');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mediamtx.yml');
  writeSecretFile(path, renderMediamtxConfig(o));
  return path;
}

function writeSecretFile(path: string, text: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/* ---------------------------------------------------------------- live secrets */

/**
 * Credentials that must never reach a log: the per-session publisher password, the SRT passphrase and the
 * relay read password. MediaMTX logs the whole SRT stream id (which carries the publisher password), so the
 * supervisor redacts every line against this set. Each value is also held URL-encoded when that differs.
 */
export interface LiveSecrets {
  add(...values: Array<string | null | undefined>): void;
  list(): string[];
}

const MAX_LIVE_SECRETS = 512;

export function createLiveSecrets(): LiveSecrets {
  const set = new Set<string>();
  return {
    add(...values): void {
      for (const v of values) {
        if (typeof v !== 'string' || v.length < 4) continue;
        for (const form of [v, encodeURIComponent(v)]) {
          set.delete(form);
          set.add(form);
        }
      }
      // bounded: the oldest sessions' values drop first
      while (set.size > MAX_LIVE_SECRETS) {
        const first = set.values().next().value;
        if (first === undefined) break;
        set.delete(first);
      }
    },
    list: () => [...set],
  };
}

/* ---------------------------------------------------------------- supervisor */

export interface MediamtxEvent {
  type: 'spawn' | 'exit' | 'backoff' | 'failed';
  pid?: number;
  code?: number | null;
  signal?: string | null;
  delayMs?: number;
}

export type SupervisorState = 'stopped' | 'running' | 'backoff' | 'failed';

export interface MediamtxStatus {
  running: boolean;
  pid: number | null;
  restarts: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  since: string | null;
  state: SupervisorState;
}

export interface MediamtxSupervisor {
  start(): void;
  stop(): Promise<void>;
  status(): MediamtxStatus;
}

export interface SupervisorOptions {
  exe: string;
  /** Config file passed as the only argument (production). */
  configPath?: string;
  /** Full argument list; overrides configPath (tests run a stub script). */
  args?: string[];
  dataDir: string;
  /** Strings that must never reach a log (the box password, live session credentials); a function is read per line. */
  redact?: string[] | (() => string[]);
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxRestarts?: number;
  windowMs?: number;
  killAfterMs?: number;
  logMaxBytes?: number;
  onEvent?: (event: MediamtxEvent) => void;
}

const STABLE_RUN_MS = 60_000;

class RotatingLog {
  private size: number;
  private readonly path: string;
  private readonly maxBytes: number;
  // no parameter properties: the box runs under Node's strip-only TypeScript mode
  constructor(path: string, maxBytes: number) {
    this.path = path;
    this.maxBytes = maxBytes;
    mkdirSync(dirname(path), { recursive: true });
    this.size = existsSync(path) ? statSync(path).size : 0;
  }
  write(text: string): void {
    const len = Buffer.byteLength(text);
    if (this.size > 0 && this.size + len > this.maxBytes) {
      try {
        renameSync(this.path, `${this.path}.1`);
      } catch {
        /* rotation is best effort */
      }
      this.size = 0;
    }
    try {
      appendFileSync(this.path, text, { mode: 0o600 });
      this.size += len;
    } catch {
      /* a full disk must not kill the supervisor */
    }
  }
}

export function startMediamtx(o: SupervisorOptions): MediamtxSupervisor {
  const baseMs = o.backoffBaseMs ?? 1000;
  const maxMs = o.backoffMaxMs ?? 60_000;
  const maxRestarts = o.maxRestarts ?? 10;
  const windowMs = o.windowMs ?? 600_000;
  const killAfterMs = o.killAfterMs ?? 3000;
  const redactSource = o.redact;
  const currentSecrets = (): string[] => {
    const list = typeof redactSource === 'function' ? redactSource() : (redactSource ?? []);
    // longest first so a secret that contains another is replaced whole
    return list.filter((x) => x.length > 0).sort((a, b) => b.length - a.length);
  };
  const liveDir = join(o.dataDir, 'live');
  const log = new RotatingLog(join(liveDir, 'mediamtx.out.log'), o.logMaxBytes ?? 5 * 1024 * 1024);
  const args = o.args ?? (o.configPath !== undefined ? [o.configPath] : []);

  let state: SupervisorState = 'stopped';
  let child: ChildProcess | null = null;
  let restarts = 0;
  let streak = 0;
  let recent: number[] = [];
  let lastExit: MediamtxStatus['lastExit'] = null;
  let since: string | null = null;
  let startedAt = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let exited: Promise<void> | null = null;

  const emit = (e: MediamtxEvent): void => {
    try {
      o.onEvent?.(e);
    } catch {
      /* observers never break supervision */
    }
  };
  const clean = (text: string): string => currentSecrets().reduce((acc, s) => acc.split(s).join('***'), text);

  function pipeLines(stream: NodeJS.ReadableStream, tag: string): () => void {
    let partial = '';
    stream.on('data', (chunk: Buffer) => {
      partial += chunk.toString('utf8');
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) log.write(`${tag} ${clean(line)}\n`);
    });
    return () => {
      if (partial !== '') log.write(`${tag} ${clean(partial)}\n`);
      partial = '';
    };
  }

  function spawnOnce(): void {
    timer = null;
    if (stopping) return;
    let proc: ChildProcess;
    try {
      // cwd is the live folder: MediaMTX drops auto.crt / auto.key into its working directory
      mkdirSync(liveDir, { recursive: true });
      proc = spawn(o.exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: liveDir });
    } catch {
      onGone(null, null);
      return;
    }
    child = proc;
    startedAt = Date.now();
    since = new Date(startedAt).toISOString();
    state = 'running';
    const flushOut = pipeLines(proc.stdout as NodeJS.ReadableStream, 'out');
    const flushErr = pipeLines(proc.stderr as NodeJS.ReadableStream, 'err');
    let done = false;
    let resolveExited: () => void = () => undefined;
    exited = new Promise<void>((r) => {
      resolveExited = r;
    });
    const finish = (code: number | null, signal: string | null): void => {
      if (done) return;
      done = true;
      flushOut();
      flushErr();
      child = null;
      since = null;
      resolveExited();
      onGone(code, signal);
    };
    proc.on('error', () => finish(null, null));
    proc.on('exit', (code, signal) => finish(code, signal));
    emit({ type: 'spawn', ...(proc.pid !== undefined ? { pid: proc.pid } : {}) });
  }

  function onGone(code: number | null, signal: string | null): void {
    lastExit = { code, signal, at: new Date().toISOString() };
    emit({ type: 'exit', code, signal });
    if (stopping) {
      state = 'stopped';
      return;
    }
    const now = Date.now();
    if (now - startedAt >= STABLE_RUN_MS) streak = 0;
    recent = recent.filter((t) => now - t < windowMs);
    if (recent.length >= maxRestarts) {
      state = 'failed';
      emit({ type: 'failed' });
      console.warn('MediaMTX keeps crashing and was given up on; live video is unavailable until the box restarts (the kiosk is unaffected)');
      return;
    }
    recent.push(now);
    const delayMs = Math.min(baseMs * 2 ** streak, maxMs);
    streak += 1;
    restarts += 1;
    state = 'backoff';
    emit({ type: 'backoff', delayMs });
    timer = setTimeout(spawnOnce, delayMs);
    timer.unref();
  }

  return {
    start(): void {
      if (child !== null || timer !== null || state === 'failed') return;
      stopping = false;
      spawnOnce();
    },
    async stop(): Promise<void> {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const proc = child;
      if (proc === null) {
        if (state !== 'failed') state = 'stopped';
        return;
      }
      const gone = exited;
      proc.kill('SIGTERM');
      const hard = setTimeout(() => proc.kill('SIGKILL'), killAfterMs);
      hard.unref();
      try {
        await gone;
      } finally {
        clearTimeout(hard);
      }
      state = 'stopped';
    },
    status(): MediamtxStatus {
      return {
        running: child !== null && state === 'running',
        pid: child?.pid ?? null,
        restarts,
        lastExit,
        since,
        state,
      };
    },
  };
}

/* ---------------------------------------------------------------- loopback API client */

export interface MediamtxApiOptions {
  port?: number;
  user: string;
  pass: string;
  timeoutMs?: number;
}

export interface MediamtxPath {
  ready: boolean;
  source: { type: string; id: string } | null;
  readers: number;
  bytesReceived: number;
  tracks: string[];
}

export interface MediamtxPermission {
  action: 'publish' | 'read' | 'api' | 'playback' | 'metrics' | 'pprof';
  path?: string;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_BODY = 1024 * 1024;

export class MediamtxApi {
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly auth: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: MediamtxApiOptions) {
    this.port = o.port ?? 9997;
    this.timeoutMs = o.timeoutMs ?? 2000;
    this.auth = `Basic ${Buffer.from(`${o.user}:${o.pass}`).toString('base64')}`;
  }

  /** The box's own Authorization header, for the WHEP proxy only (stays in this process). */
  basicAuthHeader(): string {
    return this.auth;
  }

  /** Plain loopback http (never guardedFetch, which refuses private addresses). Errors never carry the credential. */
  private request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          method,
          path,
          headers: {
            Authorization: this.auth,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
              req.destroy(new Error('mediamtx api: response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown = null;
            if (text !== '') {
              try {
                json = JSON.parse(text);
              } catch {
                json = null;
              }
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('mediamtx api: timeout')));
      req.on('error', (e: NodeJS.ErrnoException) => {
        reject(e.message.startsWith('mediamtx api') ? e : new Error(`mediamtx api: unreachable (${e.code ?? 'error'})`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async ok(method: string, path: string, body?: unknown): Promise<unknown> {
    const r = await this.request(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`mediamtx api: ${method} failed with status ${r.status}`);
    return r.json;
  }

  /** Runs read-modify-write sequences one at a time so concurrent user changes cannot lose an update. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async pathGet(name: string): Promise<MediamtxPath> {
    if (!NAME_RE.test(name)) throw new Error('mediamtx api: bad path name');
    const r = await this.request('GET', `/v3/paths/get/${name}`);
    if (r.status === 404) return { ready: false, source: null, readers: 0, bytesReceived: 0, tracks: [] };
    if (r.status < 200 || r.status >= 300) throw new Error(`mediamtx api: GET failed with status ${r.status}`);
    const j = (r.json ?? {}) as Record<string, unknown>;
    const src = j.source as { type?: unknown; id?: unknown } | null | undefined;
    const readers = Array.isArray(j.readers) ? j.readers.length : 0;
    const rawTracks = Array.isArray(j.tracks) ? j.tracks : Array.isArray(j.tracks2) ? j.tracks2 : [];
    const tracks = rawTracks
      .map((t: unknown) => (typeof t === 'string' ? t : typeof (t as { codec?: unknown })?.codec === 'string' ? (t as { codec: string }).codec : ''))
      .filter((t) => t !== '');
    return {
      ready: j.ready === true,
      source: src && typeof src.type === 'string' ? { type: src.type, id: typeof src.id === 'string' ? src.id : '' } : null,
      readers,
      bytesReceived: typeof j.bytesReceived === 'number' ? j.bytesReceived : 0,
      tracks,
    };
  }

  async pathsPatch(name: string, patch: Record<string, unknown>): Promise<void> {
    if (!NAME_RE.test(name)) throw new Error('mediamtx api: bad path name');
    await this.ok('PATCH', `/v3/config/paths/patch/${name}`, patch);
  }

  /**
   * Adds or replaces one internal user. `ips` limits where it may connect from: the box's own ffmpeg legs
   * pass loopback; omitted means any address (the phone publishes over the LAN). MediaMTX v1.21 reads a
   * user stored without `ips` back as `ips: null` and refuses a patch that carries a null slice, so every
   * user always carries real arrays (see `currentUsers`).
   */
  authUserAdd(u: { user: string; pass: string; permissions: MediamtxPermission[]; ips?: string[] }): Promise<void> {
    if (!NAME_RE.test(u.user) || u.user === 'box') return Promise.reject(new Error('mediamtx api: bad user name'));
    if (u.pass === '') return Promise.reject(new Error('mediamtx api: empty password'));
    if (u.ips !== undefined && u.ips.some((ip) => isIP(ip) === 0)) return Promise.reject(new Error('mediamtx api: bad ip'));
    return this.serial(async () => {
      const users = await this.currentUsers();
      const next = [...users.filter((x) => x.user !== u.user), { user: u.user, pass: u.pass, ips: u.ips ?? [], permissions: u.permissions }];
      await this.ok('PATCH', '/v3/config/global/patch', { authInternalUsers: next });
    });
  }

  authUserRemove(user: string): Promise<void> {
    if (!NAME_RE.test(user) || user === 'box') return Promise.reject(new Error('mediamtx api: bad user name'));
    return this.serial(async () => {
      const users = await this.currentUsers();
      if (!users.some((x) => x.user === user)) return;
      await this.ok('PATCH', '/v3/config/global/patch', { authInternalUsers: users.filter((x) => x.user !== user) });
    });
  }

  private async currentUsers(): Promise<Array<Record<string, unknown> & { user: string }>> {
    const g = (await this.ok('GET', '/v3/config/global/get')) as { authInternalUsers?: unknown } | null;
    const list = Array.isArray(g?.authInternalUsers) ? g.authInternalUsers : [];
    return list
      .filter((x): x is Record<string, unknown> & { user: string } => typeof (x as { user?: unknown })?.user === 'string')
      .map((x) => ({ ...x, ips: Array.isArray(x.ips) ? x.ips : [], permissions: Array.isArray(x.permissions) ? x.permissions : [] }));
  }

  /** Disconnects the current publisher (WHIP session or SRT connection); other source types are left alone. */
  async kickPublisher(source: { type: string; id: string }): Promise<void> {
    const kind = source.type === 'webRTCSession' ? 'webrtcsessions' : source.type === 'srtConn' ? 'srtconns' : null;
    if (kind === null || !ID_RE.test(source.id)) return;
    await this.ok('POST', `/v3/${kind}/kick/${source.id}`);
  }

  async health(): Promise<boolean> {
    try {
      await this.ok('GET', '/v3/config/global/get');
      return true;
    } catch {
      return false;
    }
  }
}

/* ---------------------------------------------------------------- box wiring */

export interface LiveToolsOption {
  dir: string;
  /** Test hook: replaces the executable, arguments and timings of the supervised process. */
  spawn?: Partial<SupervisorOptions>;
  /** Test hook: loopback API port (default 9997). */
  apiPort?: number;
  /** Test hook: loopback WHIP/WHEP port (default 8889). */
  webrtcPort?: number;
}

export interface LiveRuntime {
  tools: LiveTools;
  supervisor: MediamtxSupervisor | null;
  api: MediamtxApi | null;
  /** Loopback port of MediaMTX's WHIP/WHEP endpoint (the box server's proxies are its only clients). */
  webrtcPort: number;
  /** Live session credentials the MediaMTX log must be scrubbed of. */
  secrets: LiveSecrets;
  /** Called on every MediaMTX (re)spawn: its in-memory users and passphrase are gone and must be set again. */
  spawnListeners: Set<() => void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Live video tools state; null when the box was built without live tools. */
    liveRuntime: LiveRuntime | null;
  }
}

/**
 * Locates the tools now; start() renders the config and launches MediaMTX, stop() ends it. start()
 * never throws: a live problem must not stop the box (and so the kiosk) from serving.
 */
export function createLiveRuntime(o: { option: LiveToolsOption; dataDir: string; lanIps: string[] }): {
  runtime: LiveRuntime;
  start: () => void;
  stop: () => Promise<void>;
} {
  const runtime: LiveRuntime = { tools: liveTools(o.option.dir), supervisor: null, api: null, webrtcPort: o.option.webrtcPort ?? 8889, secrets: createLiveSecrets(), spawnListeners: new Set() };
  return {
    runtime,
    start(): void {
      const { tools } = runtime;
      if (tools.missing.length > 0) {
        console.warn(`Live tools missing (${tools.missing.join(', ')}): run scripts/install-live-tools.ps1; live video is unavailable, the kiosk is unaffected`);
      }
      if (tools.mediamtx === null) return;
      if (tools.mediamtxTooOld !== null) {
        console.warn(`MediaMTX ${tools.mediamtxTooOld} is older than ${MIN_MEDIAMTX_VERSION} (reason: mediamtx_version): run scripts/install-live-tools.ps1; live video is unavailable, the kiosk is unaffected`);
        return;
      }
      try {
        const password = ensureBoxPassword(o.dataDir);
        const configPath = writeMediamtxConfig({ dataDir: o.dataDir, lanIps: o.lanIps, password });
        runtime.api = new MediamtxApi({ user: 'box', pass: password, ...(o.option.apiPort !== undefined ? { port: o.option.apiPort } : {}) });
        const sup = startMediamtx({
          exe: tools.mediamtx,
          configPath,
          dataDir: o.dataDir,
          redact: () => [password, encodeURIComponent(password), ...runtime.secrets.list()],
          ...o.option.spawn,
          onEvent: (e) => {
            if (e.type === 'spawn') {
              console.log(`mediamtx started pid ${e.pid ?? 0}`);
              for (const l of [...runtime.spawnListeners]) {
                try {
                  l();
                } catch {
                  /* a broken listener never breaks the supervisor */
                }
              }
            }
            o.option.spawn?.onEvent?.(e);
          },
        });
        runtime.supervisor = sup;
        sup.start();
      } catch (error) {
        console.warn(`MediaMTX could not be started (${error instanceof Error ? error.message : 'error'}); live video is unavailable`);
      }
    },
    async stop(): Promise<void> {
      await runtime.supervisor?.stop();
    },
  };
}
