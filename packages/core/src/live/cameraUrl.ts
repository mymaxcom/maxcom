/**
 * The external camera's RTSP address (plan 4.2): what is accepted, and how it is shown without its password.
 *
 * Parsed by hand, not with `URL`: non-special schemes keep odd host spellings (hex, octal, single numbers) as they
 * are, and the box, the phone's RTSP client and MediaMTX must all read the same address the same way.
 * Pure rules, no I/O. Error texts are short English descriptions for the box to map to its fixed result codes;
 * they never echo the address, so a password cannot reach a log through them.
 */

export const CAMERA_URL_MAX = 400;

/** Shown in place of the password when an address is read back; saving an address that still holds it keeps the stored password. */
export const CAMERA_PASSWORD_MASK = '••••••';

const SCHEME = 'rtsp://';
// Login characters: unreserved and sub-delims; '@', '/', '?', '#' and the rest must be percent-encoded. ':' splits user from password.
const USERINFO_CHARS = /^[A-Za-z0-9._~!$&*+,;=:%-]*$/;
// Path and query: a fixed safe set. No '#', no quotes, no spaces, no control or non-ASCII characters.
const PATH_CHARS = /^[A-Za-z0-9._~!$&*+,;=:@%/?-]*$/;
const PERCENT_OK = /^(?:[^%]|%[0-9A-Fa-f]{2})*$/;
const OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!OCTET.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function privateRange(o: number[]): boolean {
  const a = o[0] ?? 0;
  const b = o[1] ?? 0;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Error text for a camera address, or null when it is acceptable. `boxIps` are the box's own addresses, which are refused. */
export function cameraUrlError(url: string, boxIps: readonly string[] = []): string | null {
  if (typeof url !== 'string') return 'must be text';
  if (url.length === 0) return 'is required';
  if (url.length > CAMERA_URL_MAX) return `must be at most ${CAMERA_URL_MAX} characters`;
  if (/[\u0000- \u007f"'`<>\\]/.test(url)) return 'must not contain spaces, quotes or control characters';
  if (!url.startsWith(SCHEME)) return 'must start with rtsp://';
  const rest = url.slice(SCHEME.length);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? '' : rest.slice(cut);

  if (tail.includes('#')) return 'must not contain a fragment (#)';
  const at = authority.split('@');
  if (at.length > 2) return 'login must not contain @ (write it as %40)';
  const hostPort = at[at.length - 1] ?? '';
  if (at.length === 2) {
    const info = at[0] ?? '';
    const masked = info.endsWith(`:${CAMERA_PASSWORD_MASK}`);
    const plain = masked ? info.slice(0, -CAMERA_PASSWORD_MASK.length) : info;
    if (!USERINFO_CHARS.test(plain) || !PERCENT_OK.test(plain)) return 'login holds a character that must be percent-encoded';
  }

  const colon = hostPort.indexOf(':');
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  if (host === '') return 'must include the camera address';
  if (colon !== -1) {
    const port = hostPort.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(port)) return 'port must be a number 1 to 65535';
    const n = Number(port);
    if (n < 1 || n > 65535) return 'port must be a number 1 to 65535';
  }

  const octets = ipv4(host);
  if (octets === null) return 'must be an IPv4 address on the surau network (like 10.168.1.20), not a name';
  if (!privateRange(octets)) return 'must be a private network address (10.x.x.x, 172.16-31.x.x or 10.168.x.x)';
  if (boxIps.includes(host)) return 'must not be the box itself';

  if (!PATH_CHARS.test(tail) || !PERCENT_OK.test(tail)) return 'path holds a character that is not allowed';
  return null;
}

/**
 * The address with the password replaced by dots, for display and for reading back. Never throws and never returns the
 * password, even for an address that is not valid. An `@` after the first `/`, `?` or `#` belongs to the path, not the login.
 */
export function maskCameraUrl(url: string): string {
  if (typeof url !== 'string') return '';
  const s = url.indexOf('://');
  const head = s === -1 ? '' : url.slice(0, s + 3);
  const rest = s === -1 ? url : url.slice(s + 3);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? '' : rest.slice(cut);
  const at = authority.lastIndexOf('@');
  if (at === -1) return url;
  const info = authority.slice(0, at);
  const colon = info.indexOf(':');
  if (colon === -1) return url;
  return `${head}${info.slice(0, colon)}:${CAMERA_PASSWORD_MASK}${authority.slice(at)}${tail}`;
}

/** True when the address still holds the dots where the password was: saving it keeps the stored password. */
export function isMaskedCameraUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith(SCHEME)) return false;
  const rest = url.slice(SCHEME.length);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const at = authority.lastIndexOf('@');
  return at !== -1 && authority.slice(0, at).endsWith(`:${CAMERA_PASSWORD_MASK}`);
}
