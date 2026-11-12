/**
 * Device client: enrolment, key-bound unlock and authenticated fetch for the Surau box.
 * Runs in the browser (IndexedDB key store, non-extractable key) and in Node (tests).
 * No dependencies; only WebCrypto, fetch and base64 helpers.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface KeyStore {
  get(): Promise<CryptoKeyPair | null>;
  set(k: CryptoKeyPair): Promise<void>;
  clear(): Promise<void>;
}

export type DevicePlatform = 'android' | 'ios-web' | 'web' | 'kiosk';

export interface EnrolPayload {
  v: 1;
  mode: 'ip' | 'domain';
  box: string;
  boxId: string;
  caSha256: string | null;
  code: string;
  user: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export interface Session {
  token: string;
  expiresAt: string;
  user: { id: string; name: string; roles: string[] };
  box: string;
  fetchImpl?: FetchLike;
}

export class ClientError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
  }
}

/**
 * Thrown by `unlock` with a PIN when the box answers 409 `pinRequired`: an admin reset the PIN, so
 * call `unlock(..., { newPin })` with a new one. The box says this only to a verified device key.
 */
export class PinRequiredError extends ClientError {
  constructor(message: string) {
    super(409, message);
    this.name = 'PinRequiredError';
  }
}

export class SessionExpiredError extends Error {
  constructor(message = 'Sesi tamat. Sila buka kunci semula') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

const PREFIX = 'surau1:';

// ---------- base64url ----------

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('bad base64url');
  const std = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- key stores ----------

export function memoryKeyStore(): KeyStore {
  let pair: CryptoKeyPair | null = null;
  return {
    get: async () => pair,
    set: async (k) => {
      pair = k;
    },
    clear: async () => {
      pair = null;
    },
  };
}

const IDB_STORE = 'keys';
const IDB_KEY = 'device-key';

/** Browser store. CryptoKey objects are structured-cloned, so a non-extractable key stays unreadable. */
export function indexedDbKeyStore(dbName = 'surau-device'): KeyStore {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (idb === undefined) {
        reject(new Error('IndexedDB tidak tersedia'));
        return;
      }
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('IndexedDB tidak dapat dibuka'));
    });
  }
  async function run<T>(mode: IDBTransactionMode, make: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction(IDB_STORE, mode);
        const req = make(t.objectStore(IDB_STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(new Error('IndexedDB gagal'));
        t.onabort = () => reject(new Error('IndexedDB gagal'));
      });
    } finally {
      db.close();
    }
  }
  return {
    get: async () => ((await run('readonly', (s) => s.get(IDB_KEY))) as CryptoKeyPair | undefined) ?? null,
    set: async (k) => {
      await run('readwrite', (s) => s.put(k, IDB_KEY));
    },
    clear: async () => {
      await run('readwrite', (s) => s.delete(IDB_KEY));
    },
  };
}

// ---------- payload ----------

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost';
}

/** Parse and validate a `surau1:` enrolment payload (the QR text). Throws Error on any defect. */
export function parseEnrolPayload(s: string): EnrolPayload {
  const bad = (): Error => new Error('Kod QR pendaftaran tidak sah');
  if (typeof s !== 'string' || !s.startsWith(PREFIX) || s.length > 4096) throw bad();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(s.slice(PREFIX.length))));
  } catch {
    throw bad();
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || (p.mode !== 'ip' && p.mode !== 'domain')) throw bad();
  if (typeof p.box !== 'string' || typeof p.boxId !== 'string' || !/^[0-9a-f]{16}$/.test(p.boxId)) throw bad();
  if (typeof p.code !== 'string' || !/^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$/.test(p.code)) throw bad();
  if (typeof p.user !== 'string' || p.user.length > 80) throw bad();
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) throw bad();
  if (p.caSha256 !== null && !(typeof p.caSha256 === 'string' && /^[0-9a-f]{64}$/i.test(p.caSha256))) throw bad();
  let url: URL;
  try {
    url = new URL(p.box);
  } catch {
    throw bad();
  }
  const okScheme = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
  if (!okScheme || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw bad();
  if (url.pathname !== '/') throw bad();
  return {
    v: 1,
    mode: p.mode,
    box: url.origin,
    boxId: p.boxId,
    caSha256: p.caSha256 === null ? null : p.caSha256.toLowerCase(),
    code: p.code,
    user: p.user,
    exp: p.exp,
  };
}

// ---------- http helpers ----------

function resolveFetch(f: FetchLike | undefined): FetchLike {
  return f ?? ((input, init) => fetch(input, init));
}

async function failure(res: Response): Promise<ClientError> {
  let message = 'Permintaan gagal';
  let pinRequired = false;
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === 'object') {
      const b = body as { message?: unknown; error?: unknown; errors?: unknown; pinRequired?: unknown };
      pinRequired = b.pinRequired === true;
      if (typeof b.message === 'string') message = b.message;
      else if (typeof b.error === 'string') message = b.error;
      else if (Array.isArray(b.errors) && typeof b.errors[0] === 'string') message = b.errors[0];
    }
  } catch {
    /* keep the generic message */
  }
  return res.status === 409 && pinRequired ? new PinRequiredError(message) : new ClientError(res.status, message);
}

async function postJson<T>(f: FetchLike, url: string, body: unknown): Promise<T> {
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

// ---------- enrol / unlock ----------

export interface EnrolOptions {
  deviceName: string;
  platform: DevicePlatform;
  pin?: string;
  fetchImpl?: FetchLike;
  keys: KeyStore;
}

export interface EnrolResult {
  deviceId: string;
  userId: string;
  roles: string[];
  pinRequired: boolean;
}

/** Generate a non-extractable P-256 key, send only its public JWK with the one-time code. */
export async function enrol(payload: EnrolPayload, opts: EnrolOptions): Promise<EnrolResult> {
  if (payload.exp <= Date.now()) throw new Error('Kod pendaftaran telah tamat');
  const f = resolveFetch(opts.fetchImpl);
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const body: Record<string, unknown> = {
    code: payload.code,
    publicJwk,
    deviceName: opts.deviceName,
    platform: opts.platform,
  };
  if (opts.pin !== undefined) body.pin = opts.pin;
  const out = await postJson<EnrolResult>(f, `${payload.box}/api/enrol/complete`, body);
  await opts.keys.set(pair); // stored only once the box accepted the key
  return { deviceId: out.deviceId, userId: out.userId, roles: out.roles, pinRequired: out.pinRequired };
}

export interface UnlockOptions {
  /** The box id from the enrolment payload; it is part of the signed message. */
  boxId: string;
  /**
   * The enrolment payload this device was enrolled from. When given, `box` must be the same origin
   * as the payload's box and the boxId must match, so a stored or tampered address cannot make
   * the device sign an unlock for a different box.
   */
  payload?: Pick<EnrolPayload, 'box' | 'boxId'>;
  /** Set the first PIN after an admin reset (the `pin` argument is then ignored). */
  newPin?: string;
  fetchImpl?: FetchLike;
  keys: KeyStore;
}

/** Challenge -> sign "surau-unlock\n<boxId>\n<deviceId>\n<nonce>" (P1363, base64url) -> unlock. */
export async function unlock(box: string, deviceId: string, pin: string, opts: UnlockOptions): Promise<Session> {
  const base = box.replace(/\/+$/, '');
  if (opts.payload !== undefined) {
    if (originOf(base) !== originOf(opts.payload.box) || opts.payload.boxId !== opts.boxId) {
      throw new Error('Alamat peti tidak sepadan dengan pendaftaran peranti ini');
    }
  }
  const credential = opts.newPin !== undefined ? { newPin: opts.newPin } : { pin };
  const f = resolveFetch(opts.fetchImpl);
  const pair = await opts.keys.get();
  if (pair === null) throw new Error('Kunci peranti tiada. Daftar semula peranti ini');
  const ch = await postJson<{ nonce: string }>(f, `${base}/api/auth/challenge`, { deviceId });
  const message = new TextEncoder().encode(`surau-unlock\n${opts.boxId}\n${deviceId}\n${ch.nonce}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message));
  const out = await postJson<{ token: string; expiresAt: string; user: Session['user'] }>(
    f,
    `${base}/api/auth/unlock`,
    { deviceId, nonce: ch.nonce, signature: toBase64Url(sig), ...credential },

  );
  const session: Session = { token: out.token, expiresAt: out.expiresAt, user: out.user, box: base };
  if (opts.fetchImpl !== undefined) session.fetchImpl = opts.fetchImpl;
  return session;
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

/**
 * Fetch with the Bearer token. A path starting with "/" is resolved against the session's box. The
 * token is only ever sent to the session's own box: any URL on another origin is refused before a
 * request is made.
 */
export async function authedFetch(session: Session, input: string, init: RequestInit = {}): Promise<Response> {
  const url = input.startsWith('/') ? `${session.box}${input}` : input;
  const boxOrigin = originOf(session.box);
  if (boxOrigin === null || originOf(url) !== boxOrigin) {
    throw new Error('Token hanya boleh dihantar ke peti sesi ini');
  }
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.token}`);
  const res = await resolveFetch(session.fetchImpl)(url, { ...init, headers });
  if (res.status === 401) throw new SessionExpiredError();
  return res;
}
