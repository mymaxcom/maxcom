/**
 * The host exit bridge: lets an admin at the box leave the kiosk and reach the box OS.
 *
 * Android: the app's WebView offers `window.MaxcomHost.exit()`.
 * Windows: the kiosk start script opens a loopback listener and launches the page as
 * `http://127.0.0.1:<box port>/#mxhost=<port>.<token>`; a POST of the token to `/exit` closes the kiosk.
 * Anywhere else (hall displays, plain browsers) there is no bridge and nothing happens.
 */

const STORE_KEY = 'maxcom-mxhost';
const HASH_RE = /(?:^|[#&])mxhost=(\d{1,5})\.([0-9a-fA-F]{64})(?:&|$)/;

export interface HostBridgeWindow {
  MaxcomHost?: { exit?: () => void };
}

export interface HostTarget {
  port: number;
  token: string;
}

export type ExitOutcome = 'android' | 'windows' | 'none';

let windowsTarget: HostTarget | null = null;

/** Parse `#mxhost=<port>.<token>`: port 1024-65535, token 64 hex. Anything else is ignored. */
export function parseHostHash(hash: string): HostTarget | null {
  const m = HASH_RE.exec(hash);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return { port, token: m[2]!.toLowerCase() };
}

function parseStored(raw: string | null): HostTarget | null {
  if (!raw) return null;
  return parseHostHash(`#mxhost=${raw}`);
}

export interface CaptureDeps {
  location?: Pick<Location, 'hash' | 'pathname' | 'search'>;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  replaceState?: (url: string) => void;
}

/**
 * Read the hash once: keep the target in memory (and sessionStorage for reloads), then remove the hash from the
 * address bar. Without a valid hash the session copy is used. Never throws.
 */
export function captureHostBridge(deps: CaptureDeps = {}): HostTarget | null {
  try {
    const loc = deps.location ?? window.location;
    const found = parseHostHash(loc.hash ?? '');
    let storage: CaptureDeps['storage'] = null;
    try {
      storage = deps.storage === undefined ? window.sessionStorage : deps.storage;
    } catch {
      storage = null;
    }
    if (found) {
      windowsTarget = found;
      try {
        storage?.setItem(STORE_KEY, `${found.port}.${found.token}`);
      } catch {
        /* storage may be blocked */
      }
    } else if (windowsTarget === null) {
      try {
        windowsTarget = parseStored(storage?.getItem(STORE_KEY) ?? null);
      } catch {
        windowsTarget = null;
      }
    }
    if ((loc.hash ?? '') !== '' && /mxhost=/.test(loc.hash)) {
      const replace = deps.replaceState ?? ((url: string) => window.history.replaceState(window.history.state, '', url));
      replace(`${loc.pathname}${loc.search}`);
    }
  } catch {
    /* a broken environment just has no bridge */
  }
  return windowsTarget;
}

export function hasHostBridge(w: HostBridgeWindow = window as unknown as HostBridgeWindow): boolean {
  return typeof w.MaxcomHost?.exit === 'function' || windowsTarget !== null;
}

/** Ask the host to close the kiosk. Resolves to which bridge answered; never throws. */
export async function exitToHost(
  w: HostBridgeWindow = window as unknown as HostBridgeWindow,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<ExitOutcome> {
  try {
    if (typeof w.MaxcomHost?.exit === 'function') {
      w.MaxcomHost.exit();
      return 'android';
    }
  } catch {
    return 'none';
  }
  const target = windowsTarget;
  if (target === null) return 'none';
  try {
    await fetchImpl(`http://127.0.0.1:${target.port}/exit`, {
      method: 'POST',
      body: target.token,
      mode: 'no-cors',
      cache: 'no-store',
    });
    return 'windows';
  } catch {
    return 'none';
  }
}

export function resetHostBridgeForTest(): void {
  windowsTarget = null;
}
