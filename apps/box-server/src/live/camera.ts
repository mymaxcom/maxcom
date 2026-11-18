import { hkdfSync } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAMERA_PASSWORD_MASK, cameraUrlError, isMaskedCameraUrl, maskCameraUrl } from '@surau/core';
import { openSecret, sealSecret } from '../auth/crypto.ts';
import { loadBoxKey, secretDir } from '../auth/secrets.ts';
import type { LiveSecrets, MediamtxApi } from './mediamtx.ts';

/**
 * The external camera on the box (plan 4.2, 4.3, 6): the sealed address record, and the box's own "Uji sambungan".
 *
 * The address may carry the camera login. It is sealed on disk, handed to MediaMTX only as a JSON string through its
 * API (never YAML, never an ffmpeg argument), added to the log redactor before it is used, and never returned, logged
 * or audited unmasked. Error texts here never contain the address.
 */

/* ---------------------------------------------------------------- the sealed record */

export interface CameraRecord {
  /** The full address as typed (with or without a login). */
  url: string;
  /** Used only when the address carries no login. */
  username?: string;
  password?: string;
}

export interface CameraSaveInput {
  url: string;
  username?: string;
  password?: string;
}

export type CameraTestCode = 'ok' | 'unreachable' | 'login' | 'path' | 'codec' | 'busy' | 'not_configured' | 'bad_address' | 'unavailable';

/** What a box test found; stored with the record so the live screen knows before the live whether the camera has sound. */
export interface CameraTestResult {
  code: CameraTestCode;
  ok: boolean;
  at: string;
  /** null when the camera was not reached. */
  hasAudio: boolean | null;
  /** MediaMTX track names seen (H264, H265, MPEG-4 Audio, G711, ...). */
  codecs: string[];
  /** The transport that delivered the picture; null when none did. */
  transport: 'tcp' | 'udp' | null;
  /** Only with `bad_address`: which rule the address broke (never the address itself). */
  reason?: CameraAddressReason;
}

/** Why a camera address is refused: one word per rule of `cameraUrlError`, for the app to say in its own language. */
export type CameraAddressReason = 'not_rtsp' | 'not_ipv4' | 'not_private' | 'is_box' | 'bad_port' | 'bad_login_chars' | 'bad_path' | 'too_long';

/**
 * The reason a camera address is refused, or null when it is acceptable. Maps the core rule's short description to
 * one word (core says why in English; the app has the words in three languages).
 */
export function cameraAddressReason(url: string, boxIps: readonly string[] = []): CameraAddressReason | null {
  const e = cameraUrlError(url, boxIps);
  if (e === null) return null;
  if (e.startsWith('must be at most')) return 'too_long';
  if (e.startsWith('must start with rtsp')) return 'not_rtsp';
  if (e.startsWith('login ')) return 'bad_login_chars';
  if (e.startsWith('port ')) return 'bad_port';
  if (e.startsWith('must be an IPv4')) return 'not_ipv4';
  if (e.startsWith('must be a private')) return 'not_private';
  if (e.startsWith('must not be the box')) return 'is_box';
  if (e.startsWith('must include the camera address')) return 'not_ipv4';
  if (e === 'is required' || e === 'must be text') return 'not_rtsp';
  // spaces, quotes, control characters, a fragment, a path character that is not allowed
  return 'bad_path';
}

export interface MaskedCamera {
  configured: boolean;
  /** The address with the password replaced by dots. */
  url: string;
  username: string | null;
  hasPassword: boolean;
  lastTest: CameraTestResult | null;
}

export class CameraError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra facts for the app's own text (for `bad_address`: `{ reason }`); never the address. */
  readonly detail: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const CAMERA_MSG = {
  badAddress: 'Alamat kamera tidak sah. Gunakan alamat RTSP pada rangkaian surau, contohnya rtsp://10.168.1.20:554/stream1.',
  badLogin: 'Nama pengguna atau kata laluan kamera tidak sah.',
  maskedNoPassword: 'Kata laluan kamera tidak ditemui. Taip semula alamat dengan kata laluan.',
  nothing: 'Alamat kamera belum disimpan.',
  passwordAgain: 'Masukkan kata laluan semula.',
} as const;

const LOGIN_MAX = 128;
// no control characters in the separate login boxes
const LOGIN_OK = /^[^\u0000-\u001f\u007f]*$/;

/** Key for the camera file: HKDF of the box master key, its own domain. */
export function deriveCameraKey(boxKey: Buffer): Buffer {
  if (!Buffer.isBuffer(boxKey) || boxKey.length !== 32) throw new Error('camera: bad key');
  return Buffer.from(hkdfSync('sha256', boxKey, Buffer.alloc(0), 'live-camera', 32));
}

interface UrlParts {
  /** `rtsp://` */
  head: string;
  user: string | null;
  pass: string | null;
  /** host[:port] and the path and query. */
  rest: string;
}

/** Hand parse (like core's rules): the login is the part before the LAST `@` of the authority, split at the first `:`. */
function splitUrl(url: string): UrlParts | null {
  const scheme = 'rtsp://';
  if (typeof url !== 'string' || !url.startsWith(scheme)) return null;
  const body = url.slice(scheme.length);
  const cut = body.search(/[/?#]/);
  const authority = cut === -1 ? body : body.slice(0, cut);
  const tail = cut === -1 ? '' : body.slice(cut);
  const at = authority.lastIndexOf('@');
  if (at === -1) return { head: scheme, user: null, pass: null, rest: authority + tail };
  const info = authority.slice(0, at);
  const colon = info.indexOf(':');
  return {
    head: scheme,
    user: colon === -1 ? info : info.slice(0, colon),
    pass: colon === -1 ? null : info.slice(colon + 1),
    rest: authority.slice(at + 1) + tail,
  };
}

// encodeURIComponent leaves ! ' ( ) * which core's address rules refuse in a login ("'" is a quote)
const encLogin = (v: string): string => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The address a puller connects to: credentials in the address win; the separate boxes fill in only when it has none. */
export function cameraPullUrl(r: CameraRecord): string {
  const p = splitUrl(r.url);
  if (p === null || p.user !== null) return r.url;
  if (r.username === undefined || r.username === '') return r.url;
  const login = r.password !== undefined && r.password !== '' ? `${encLogin(r.username)}:${encLogin(r.password)}` : encLogin(r.username);
  return `${p.head}${login}@${p.rest}`;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Every spelling of the login that must never reach a log (the redactor adds the URL-encoded forms itself). */
export function cameraSecrets(r: CameraRecord): string[] {
  const out = new Set<string>();
  const p = splitUrl(r.url);
  const add = (v: string | null | undefined): void => {
    if (typeof v !== 'string' || v === '') return;
    out.add(v);
    out.add(safeDecode(v));
  };
  add(p?.user);
  add(p?.pass);
  add(r.username);
  add(r.password);
  if (p !== null && p.user !== null && p.pass !== null) add(`${p.user}:${p.pass}`);
  return [...out];
}

function parseRecord(text: string): { record: CameraRecord; lastTest: CameraTestResult | null } | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || o.url === '') return null;
  const record: CameraRecord = { url: o.url };
  if (typeof o.username === 'string' && o.username !== '') record.username = o.username;
  if (typeof o.password === 'string' && o.password !== '') record.password = o.password;
  return { record, lastTest: parseTest(o.lastTest) };
}

const CODES: readonly CameraTestCode[] = ['ok', 'unreachable', 'login', 'path', 'codec', 'busy', 'not_configured', 'bad_address', 'unavailable'];

function parseTest(v: unknown): CameraTestResult | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.code !== 'string' || !(CODES as readonly string[]).includes(o.code) || typeof o.at !== 'string') return null;
  return {
    code: o.code as CameraTestCode,
    ok: o.ok === true,
    at: o.at,
    hasAudio: typeof o.hasAudio === 'boolean' ? o.hasAudio : null,
    codecs: Array.isArray(o.codecs) ? o.codecs.filter((c): c is string => typeof c === 'string').slice(0, 8) : [],
    transport: o.transport === 'tcp' || o.transport === 'udp' ? o.transport : null,
  };
}

/** `<dataDir>/secret/live-camera.json`, AES-256-GCM sealed. A file that does not open reads as "no camera". */
export class CameraStore {
  private readonly dir: string;
  private readonly path: string;
  private readonly key: Buffer;
  private readonly boxIps: readonly string[];
  private readonly now: () => Date;

  constructor(dataDir: string, o: { boxIps?: readonly string[]; now?: () => Date } = {}) {
    this.dir = secretDir(dataDir);
    this.path = join(this.dir, 'live-camera.json');
    this.key = deriveCameraKey(loadBoxKey(dataDir));
    this.boxIps = o.boxIps ?? [];
    this.now = o.now ?? (() => new Date());
  }

  private load(): { record: CameraRecord; lastTest: CameraTestResult | null } | null {
    if (!existsSync(this.path)) return null;
    try {
      return parseRecord(openSecret(this.key, readFileSync(this.path, 'utf8').trim()));
    } catch {
      console.warn('live camera: the sealed address cannot be opened, treated as not set (reason: camera_unreadable)');
      return null;
    }
  }

  private write(record: CameraRecord, lastTest: CameraTestResult | null): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, sealSecret(this.key, JSON.stringify({ ...record, ...(lastTest !== null ? { lastTest } : {}) })), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* unsupported filesystem; on Windows the folder ACL protects it */
    }
    renameSync(tmp, this.path);
  }

  /** The full record, for the box's own pull and the phone's source read only. Never log it. */
  get(): CameraRecord | null {
    return this.load()?.record ?? null;
  }

  /** What a client may see: the address with the password as dots, and whether a password is held. */
  getMasked(): MaskedCamera {
    const l = this.load();
    if (l === null) return { configured: false, url: '', username: null, hasPassword: false, lastTest: null };
    const p = splitUrl(l.record.url);
    const user = p?.user ?? l.record.username ?? null;
    const hasPassword = p !== null && p.user !== null ? p.pass !== null && p.pass !== '' : l.record.password !== undefined;
    return { configured: true, url: maskCameraUrl(l.record.url), username: user !== '' ? user : null, hasPassword, lastTest: l.lastTest };
  }

  /** The last box test; null when none has run since the address last changed. */
  get lastTest(): CameraTestResult | null {
    return this.load()?.lastTest ?? null;
  }

  /**
   * Keeps the result with the record (no secret in it). Ignored when no camera is saved, or when `testedUrl` (the pull
   * address the test used) is no longer the saved one: a test can run for seconds while the address is changed.
   */
  setLastTest(result: CameraTestResult | null, testedUrl?: string): void {
    const l = this.load();
    if (l === null) return;
    if (testedUrl !== undefined && cameraPullUrl(l.record) !== testedUrl) return;
    this.write(l.record, result);
  }

  /**
   * Validates and seals an address. An address that still holds the dots keeps the stored password; a separate
   * password left out keeps the stored one, an empty one removes it. Refuses with a CameraError (400) and never
   * echoes what was typed.
   */
  save(input: CameraSaveInput): MaskedCamera {
    const prev = this.load();
    if (typeof input !== 'object' || input === null || typeof input.url !== 'string') throw new CameraError(400, 'bad_address', CAMERA_MSG.badAddress);
    let url = input.url.trim();
    const typed = splitUrl(url);

    if (isMaskedCameraUrl(url)) {
      // the dots stand for the stored password; it is put back only for the same login
      const old = prev === null ? null : splitUrl(prev.record.url);
      if (typed === null || old === null || old.user !== typed.user || old.pass === null || old.pass === '') {
        throw new CameraError(400, 'bad_address', CAMERA_MSG.maskedNoPassword);
      }
      // a changed host, port or path could send the stored password somewhere else: it is typed again then
      if (old.rest !== typed.rest) throw new CameraError(400, 'password_again', CAMERA_MSG.passwordAgain);
      url = `${typed.head}${typed.user ?? ''}:${old.pass}@${typed.rest}`;
    }
    const refused = cameraAddressReason(url, this.boxIps);
    if (refused !== null) throw new CameraError(400, 'bad_address', CAMERA_MSG.badAddress, { reason: refused });

    const record: CameraRecord = { url };
    const p = splitUrl(url);
    if (p !== null && p.user === null) {
      const username = input.username;
      if (username !== undefined && (typeof username !== 'string' || username.length > LOGIN_MAX || !LOGIN_OK.test(username))) {
        throw new CameraError(400, 'bad_login', CAMERA_MSG.badLogin);
      }
      let password = input.password;
      if (password !== undefined && (typeof password !== 'string' || password.length > LOGIN_MAX || !LOGIN_OK.test(password))) {
        throw new CameraError(400, 'bad_login', CAMERA_MSG.badLogin);
      }
      if (password === CAMERA_PASSWORD_MASK) {
        // the dots stand for the stored password; it is put back only for the same host, port and path
        const old = prev === null ? null : splitUrl(prev.record.url);
        if (prev?.record.password !== undefined && (old === null || old.rest !== p.rest)) {
          throw new CameraError(400, 'password_again', CAMERA_MSG.passwordAgain);
        }
      }
      if (password === CAMERA_PASSWORD_MASK || password === undefined) password = prev?.record.password;
      if (username !== undefined && username !== '') record.username = username;
      if (record.username !== undefined && password !== undefined && password !== '') record.password = password;
    }

    const changed = prev === null || cameraPullUrl(prev.record) !== cameraPullUrl(record);
    this.write(record, changed ? null : prev.lastTest);
    return this.getMasked();
  }

  clear(): void {
    rmSync(this.path, { force: true });
    rmSync(`${this.path}.tmp`, { force: true });
  }

  /** For the test result's timestamp. */
  stamp(): string {
    return this.now().toISOString();
  }
}

/* ---------------------------------------------------------------- the MediaMTX log, for failure reasons */

/** A reader of MediaMTX's own log, to learn why a pull failed (its API says only `ready: false`). */
export interface MediamtxLogTail {
  /** A position in the log now. */
  mark(): number;
  /** The log lines written after `mark`. */
  since(mark: number): string[];
}

const TAIL_MAX = 256 * 1024;

/** Reads `<dataDir>/live/mediamtx.out.log` (the supervisor's redacted copy of MediaMTX's output). */
export function fileLogTail(dataDir: string): MediamtxLogTail {
  const path = join(dataDir, 'live', 'mediamtx.out.log');
  const size = (): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  return {
    mark: size,
    since(mark: number): string[] {
      const now = size();
      if (now === 0) return [];
      // a smaller file than the mark means the log rotated: read the new file from its start
      const from = now < mark ? 0 : mark;
      const len = Math.min(now - from, TAIL_MAX);
      if (len <= 0) return [];
      let fd: number | null = null;
      try {
        fd = openSync(path, 'r');
        const buf = Buffer.alloc(len);
        const got = readSync(fd, buf, 0, len, now - len);
        return buf.subarray(0, got).toString('utf8').split(/\r?\n/);
      } catch {
        return [];
      } finally {
        if (fd !== null) closeSync(fd);
      }
    },
  };
}

export type PullFailure = 'login' | 'path' | 'port_closed' | 'no_answer' | 'unknown';

export const TEST_PATH = 'surau-uji';

const RTSP_SOURCE_LINE = /\[path surau-uji\] \[RTSP source\] (.*)$/;

/**
 * The reason a pull failed, from the MediaMTX lines of that attempt (T0, 2026-11-17): `bad status code: 401 (Unauthorized)`
 * is a wrong login, `404 (Not Found)` a wrong stream path, `connectex: ... actively refused` (or `connection refused`) a
 * closed port, `dial tcp ...: i/o timeout` no answer. The text is matched against these fixed patterns and never returned.
 * The newest recognised line decides.
 */
export function pullFailureReason(lines: readonly string[]): PullFailure {
  let found: PullFailure = 'unknown';
  for (const line of lines) {
    const m = RTSP_SOURCE_LINE.exec(line);
    if (m === null) continue;
    const text = m[1] ?? '';
    if (/bad status code: (401|403)\b/.test(text)) found = 'login';
    else if (/bad status code: 404\b/.test(text)) found = 'path';
    else if (/connectex|actively refused|connection refused/i.test(text)) found = 'port_closed';
    else if (/i\/o timeout|no route to host|network is unreachable|timed out/i.test(text)) found = 'no_answer';
  }
  return found;
}

/* ---------------------------------------------------------------- Uji sambungan */

export type PullMode = 'auto' | 'tcp' | 'udp';

export type PullOutcome =
  | { ready: true; transport: 'tcp' | 'udp'; tracks: string[] }
  | { ready: false; reason: PullFailure; transport: 'tcp' | 'udp' | null };

const VIDEO_TRACK = /^(H264|H265|H\.264|H\.265|AV1|VP8|VP9|MPEG-4 Video|MPEG-1\/2 Video|M-JPEG|Motion JPEG)$/i;

export interface CameraTesterOptions {
  /** The loopback MediaMTX client; null while MediaMTX is not running. Read at every test. */
  api: () => Pick<MediamtxApi, 'pathGet' | 'pathsPatch'> | null;
  log: MediamtxLogTail;
  /** The live session redactor: the camera login is added before the address leaves this module. */
  secrets?: LiveSecrets | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long one test waits for a picture (default 15 s; with Automatik TCP and UDP share it). */
  readyTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Drives the spare MediaMTX path `surau-uji` to the camera and reads what arrived. The path is put back to
 * `publisher` afterwards on every outcome, so the camera address stays in MediaMTX memory only while a test runs.
 */
export class CameraTester {
  private readonly o: CameraTesterOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private running = false;

  constructor(o: CameraTesterOptions) {
    this.o = o;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => new Date());
  }

  /** True while a test is in progress (one at a time). */
  get busy(): boolean {
    return this.running;
  }

  /** One pull attempt with one transport. Leaves the test path pointing at the camera; the caller restores it. */
  private async attempt(url: string, transport: 'tcp' | 'udp', timeoutMs: number): Promise<PullOutcome> {
    const api = this.o.api();
    if (api === null) return { ready: false, reason: 'unknown', transport };
    const mark = this.o.log.mark();
    await api.pathsPatch(TEST_PATH, { source: url, sourceOnDemand: false, rtspTransport: transport });
    const pollMs = this.o.pollMs ?? 250;
    const end = Date.now() + timeoutMs;
    for (;;) {
      const p = await api.pathGet(TEST_PATH);
      if (p.ready && p.source?.type === 'rtspSource') return { ready: true, transport, tracks: p.tracks };
      // a definite answer in the log ends the wait early (MediaMTX retries by itself, so waiting longer adds nothing)
      const reason = pullFailureReason(this.o.log.since(mark));
      if (reason === 'login' || reason === 'path' || reason === 'port_closed') return { ready: false, reason, transport };
      if (Date.now() >= end) return { ready: false, reason, transport };
      await this.sleep(pollMs);
    }
  }

  /**
   * Pulls the camera with one transport, or Automatik: TCP first, then UDP when TCP gave no picture. A wrong login or a
   * wrong stream path is not a transport problem, so Automatik does not retry those with UDP.
   */
  async pullWithTransport(url: string, mode: PullMode): Promise<PullOutcome> {
    const total = this.o.readyTimeoutMs ?? 15_000;
    if (mode === 'tcp' || mode === 'udp') return this.attempt(url, mode, total);
    const first = await this.attempt(url, 'tcp', Math.ceil(total / 2));
    if (first.ready || first.reason === 'login' || first.reason === 'path') return first;
    return this.attempt(url, 'udp', Math.floor(total / 2));
  }

  pullFailureReason(lines: readonly string[]): PullFailure {
    return pullFailureReason(lines);
  }

  /**
   * The box test. Never throws; the answer holds fixed codes only. A network failure of any kind (closed port, no
   * answer, anything unrecognised) shares the one code `unreachable`.
   */
  async testCamera(record: CameraRecord | null, mode: PullMode, boxIps: readonly string[] = []): Promise<CameraTestResult> {
    const at = this.now().toISOString();
    const done = (code: CameraTestCode, extra: Partial<CameraTestResult> = {}): CameraTestResult => ({
      code,
      ok: code === 'ok',
      at,
      hasAudio: null,
      codecs: [],
      transport: null,
      ...extra,
    });
    if (record === null) return done('not_configured');
    const url = cameraPullUrl(record);
    const refused = cameraAddressReason(url, boxIps);
    if (refused !== null) return done('bad_address', { reason: refused });
    if (this.o.api() === null) return done('unavailable');
    if (this.running) return done('busy');
    this.running = true;
    try {
      // the login must be scrubbed from the MediaMTX log before MediaMTX ever sees it
      this.o.secrets?.add(...cameraSecrets({ ...record, url }));
      const out = await this.pullWithTransport(url, mode);
      if (!out.ready) {
        return done(out.reason === 'login' ? 'login' : out.reason === 'path' ? 'path' : 'unreachable');
      }
      const video = out.tracks.filter((t) => VIDEO_TRACK.test(t));
      const hasAudio = out.tracks.some((t) => !VIDEO_TRACK.test(t));
      const extra = { hasAudio, codecs: out.tracks.slice(0, 8), transport: out.transport };
      // the box path can only decode H.264 (plan 3.3)
      return video.some((t) => /^(H264|H\.264)$/i.test(t)) ? done('ok', extra) : done('codec', extra);
    } catch {
      return done('unavailable');
    } finally {
      try {
        await this.o.api()?.pathsPatch(TEST_PATH, { source: 'publisher' });
      } catch {
        console.warn('live camera: the test path could not be put back (reason: restore_failed)');
      }
      this.running = false;
    }
  }
}
