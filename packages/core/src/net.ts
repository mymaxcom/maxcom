/** Address rules for configurable internet sources. Pure string logic: no Node modules. */

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/** Eight 16-bit groups of an IPv6 literal (no brackets, no zone), or null when malformed. */
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.includes('%') || !/^[0-9a-f:.]+$/.test(s)) return null;
  // A trailing dotted quad stands for the last two groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[1] ?? '');
    if (!v4) return null;
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    s = `${s.slice(0, s.length - (tail[1] ?? '').length)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] ?? '');
  if (!rest || head.length + rest.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

function privateV4(o: number[]): boolean {
  const a = o[0] ?? 0;
  const b = o[1] ?? 0;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (o[2] ?? 0) === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True when `ip` (IPv4 or IPv6 text, brackets allowed) is private, loopback, link-local, mapped to one, or malformed. */
export function isBlockedIp(ip: string): boolean {
  const raw = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = parseV4(raw);
  if (v4) return privateV4(v4);
  const g = parseV6(raw);
  if (!g) return true;
  const g0 = g[0] ?? 0;
  const embedded = [(g[6] ?? 0) >> 8, (g[6] ?? 0) & 255, (g[7] ?? 0) >> 8, (g[7] ?? 0) & 255];
  const zeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (zeros(8) || (zeros(7) && g[7] === 1)) return true; // :: and ::1
  if (zeros(5) && g[5] === 0xffff) return privateV4(embedded); // ::ffff:a.b.c.d (mapped)
  if (zeros(6)) return true; // ::a.b.c.d (deprecated compatible form)
  if (g0 === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(embedded); // NAT64
  if (g0 === 0x2002) return privateV4([(g[1] ?? 0) >> 8, (g[1] ?? 0) & 255, (g[2] ?? 0) >> 8, (g[2] ?? 0) & 255]); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 (old site-local)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.localdomain', '.internal', '.lan', '.home', '.corp', '.intranet', '.home.arpa'];

/** True when a URL hostname (as `new URL().hostname` gives it) must not be contacted. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === '') return true;
  if (h.startsWith('[') || h.includes(':')) return isBlockedIp(h);
  if (/^[0-9.]+$/.test(h)) return isBlockedIp(h); // dotted quad (the URL parser already normalised odd spellings)
  if (!h.includes('.')) return true; // single-label names resolve on the local network
  if (h === 'localhost' || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h);
}

/** Error text for a source URL, or null when it is an acceptable public https address. */
export function sourceUrlError(value: string): string | null {
  if (value.length > 300) return 'must be at most 300 characters';
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return 'must not contain spaces or control characters';
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'must be a valid web address';
  }
  if (u.protocol !== 'https:') return 'must start with https://';
  if (u.username !== '' || u.password !== '') return 'must not contain a user name or password';
  if (u.hash !== '' || value.includes('#')) return 'must not contain a # fragment';
  if (isBlockedHost(u.hostname)) return 'must be a public internet address (not local or private)';
  return null;
}
