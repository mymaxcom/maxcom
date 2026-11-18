import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { getSettings } from './settingsStore.ts';
import { shortNameOf } from './surauLogo.ts';
import { NEUTRAL_SURAU_ID, publicSurauOf } from './reqSurau.ts';

/** The cloud web app used when the box has no linked cloud address. */
export const DEFAULT_CLOUD_ORIGIN = 'https://api.mymaxcom.my';
const FALLBACK_HOST = 'box.surau.local';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export interface IosProfileDeps {
  /** Which server this is; the cloud names the surau of the linked box, a box its own. Default `box`. */
  role?: 'box' | 'cloud';
  db: DatabaseSync;
  boxId: string;
  httpsPort: number;
  /** The box's own LAN IP addresses (its certificate IP SANs). */
  lanIps: readonly string[];
  /** The box's numbered local name (`box1-surau.local`) from the live certificate, or null on a legacy root. */
  boxName?: () => string | null;
  /** The Host allowlist right now (live: a renewed certificate may add an address). */
  allowedHosts: () => ReadonlySet<string>;
  /** https origin of the cloud web app this box links to, or '' when none is known. */
  cloudOrigin: () => string;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // characters XML 1.0 cannot carry at all
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '');
}

/** Deterministic UUID (v5 layout) from the box id, so a re-install replaces the profile instead of adding another. */
export function profileUuid(boxId: string, tag: string): string {
  const h = createHash('sha256').update(`my.maxcom.box.ios|${boxId}|${tag}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex').toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Host name part of a Host header, lowercased, without port or IPv6 brackets; '' when absent. */
function hostnameOf(header: string | undefined): string {
  if (typeof header !== 'string') return '';
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? '' : h.slice(1, end);
  }
  const colon = h.lastIndexOf(':');
  return colon >= 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

const urlHost = (host: string): string => (isIP(host) === 6 ? `[${host}]` : host);

/** The host the web clip points at: the box's numbered name when it has one, else the request's own Host when it is one of the box's names, else the first LAN IP. */
export function pickBoxHost(hostHeader: string | undefined, deps: Pick<IosProfileDeps, 'lanIps' | 'allowedHosts' | 'boxName'>): string {
  // a root made for the numbered names: the name is the address that survives a new DHCP lease
  const named = deps.boxName?.() ?? null;
  if (named !== null) return named;
  const own = [...deps.allowedHosts()].filter((h) => !LOOPBACK.has(h));
  const asked = hostnameOf(hostHeader);
  if (asked !== '' && !LOOPBACK.has(asked) && own.includes(asked)) return asked;
  return deps.lanIps[0] ?? own[0] ?? FALLBACK_HOST;
}

function asciiFileName(shortName: string): string {
  const cleaned = shortName.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'surau' : cleaned;
}

function plistString(key: string, value: string, indent: string): string {
  return `${indent}<key>${key}</key>\n${indent}<string>${xmlEscape(value)}</string>\n`;
}

function plistData(key: string, bytes: Buffer, indent: string): string {
  return `${indent}<key>${key}</key>\n${indent}<data>${bytes.toString('base64')}</data>\n`;
}

function plistBool(key: string, value: boolean, indent: string): string {
  return `${indent}<key>${key}</key>\n${indent}<${value ? 'true' : 'false'}/>\n`;
}

/** The common name iOS lists the root by (Certificate Trust Settings), or null when the bytes are not a certificate or carry no CN. */
export function rootCommonName(der: Buffer | null): string | null {
  if (der === null) return null;
  try {
    const subject = new X509Certificate(der).subject;
    for (const line of subject.split(/\r?\n/)) {
      const m = /^CN=(.+)$/.exec(line.trim());
      if (m !== null && m[1]!.trim() !== '') return m[1]!.trim();
    }
  } catch {
    // not a parseable certificate: callers fall back to the surau-based name
  }
  return null;
}

export interface ProfileInput {
  boxId: string;
  surauName: string;
  label: string;
  url: string;
  rootDer: Buffer | null;
  icon: Buffer | null;
  /** The root certificate's own CN: the name iOS shows. Defaults to `MAXCOM <surau> CA`. */
  rootName?: string | null;
}

/** The unsigned configuration profile (XML plist). Every string is escaped. */
export function buildProfile(input: ProfileInput): string {
  const { boxId, surauName, label, url, rootDer, icon } = input;
  const rootName = input.rootName ?? `MAXCOM ${surauName} CA`;
  const dict = (inner: string): string => `\t\t<dict>\n${inner}\t\t</dict>\n`;
  const i3 = '\t\t\t';
  let payloads = '';
  if (rootDer !== null) {
    payloads += dict(
      plistData('PayloadContent', rootDer, i3) +
        plistString('PayloadDescription', 'Sijil akar kotak MAXCOM surau ini.', i3) +
        plistString('PayloadDisplayName', rootName, i3) +
        plistString('PayloadIdentifier', `my.maxcom.box.${boxId}.ios.root`, i3) +
        plistString('PayloadType', 'com.apple.security.root', i3) +
        plistString('PayloadUUID', profileUuid(boxId, 'root'), i3) +
        `${i3}<key>PayloadVersion</key>\n${i3}<integer>1</integer>\n`,
    );
  }
  payloads += dict(
    plistBool('FullScreen', true, i3) +
      (icon !== null ? plistData('Icon', icon, i3) : '') +
      plistBool('IsRemovable', true, i3) +
      plistString('Label', label, i3) +
      plistString('PayloadDescription', 'Ikon aplikasi MAXCOM pada skrin utama.', i3) +
      plistString('PayloadDisplayName', `MAXCOM ${label}`, i3) +
      plistString('PayloadIdentifier', `my.maxcom.box.${boxId}.ios.webclip`, i3) +
      plistString('PayloadType', 'com.apple.webClip.managed', i3) +
      plistString('PayloadUUID', profileUuid(boxId, 'webclip'), i3) +
      `${i3}<key>PayloadVersion</key>\n${i3}<integer>1</integer>\n` +
      plistBool('Precomposed', true, i3) +
      plistString('URL', url, i3),
  );
  const i1 = '\t';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    `${i1}<key>PayloadContent</key>\n${i1}<array>\n${payloads}${i1}</array>\n` +
    plistString('PayloadDescription', 'Pasang sijil kotak MAXCOM surau ini dan ikon aplikasi pentadbiran pada skrin utama.', i1) +
    plistString('PayloadDisplayName', `MAXCOM ${surauName}`, i1) +
    plistString('PayloadIdentifier', `my.maxcom.box.${boxId}.ios`, i1) +
    plistString('PayloadOrganization', 'MAXCOM', i1) +
    plistBool('PayloadRemovalDisallowed', false, i1) +
    plistString('PayloadType', 'Configuration', i1) +
    plistString('PayloadUUID', profileUuid(boxId, 'profile'), i1) +
    `${i1}<key>PayloadVersion</key>\n${i1}<integer>1</integer>\n` +
    '</dict>\n</plist>\n'
  );
}

const helpPage = (rootName: string | null): string => `<!doctype html>
<html lang="ms"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAXCOM iPhone / iPad</title>
<style>
body{margin:0;font:17px/1.5 -apple-system,system-ui,sans-serif;background:#06302b;color:#f2f7f5}
main{max-width:34rem;margin:0 auto;padding:24px 20px 40px}
h1{font-size:1.5rem;margin:0 0 4px}
p.sub{margin:0 0 20px;opacity:.8}
a.btn{display:block;margin:10px 0;padding:14px 16px;border-radius:12px;background:#f2c14e;color:#06302b;font-weight:700;text-align:center;text-decoration:none}
a.btn.alt{background:transparent;color:#f2f7f5;border:2px solid #f2f7f5}
ol{padding-left:1.3rem}li{margin:12px 0}
small{display:block;margin-top:2px;opacity:.75}
p.warn{margin:20px 0 0;padding:12px 14px;border-radius:12px;border:2px solid #f2c14e}
</style></head><body><main>
<h1>MAXCOM untuk iPhone / iPad</h1>
<p class="sub">Setup MAXCOM on iPhone / iPad in one profile.</p>
<a class="btn" href="/app/ios.mobileconfig">Muat turun profil (kotak surau)<small>Download profile (surau box)</small></a>
<a class="btn alt" href="/app/ios.mobileconfig?via=cloud">Muat turun profil (awan)<small>Download profile (cloud)</small></a>
<ol>
<li>Muat turun profil.<small>Download the profile.</small></li>
<li>Tetapan &gt; Profil dimuat turun &gt; Pasang.<small>Settings &gt; Profile Downloaded &gt; Install.</small></li>
<li>Tetapan &gt; Umum &gt; Perihal &gt; Tetapan Kepercayaan Sijil &gt; hidupkan sijil ${rootName === null ? 'MAXCOM' : `<b>${xmlEscape(rootName)}</b>`} (varian kotak sahaja).<small>Settings &gt; General &gt; About &gt; Certificate Trust Settings &gt; switch on ${rootName === null ? 'the MAXCOM certificate' : `<b>${xmlEscape(rootName)}</b>`} (box profile only). iOS does not let a profile switch this on for you.</small></li>
<li>Buka ikon MAXCOM pada skrin utama sekali semasa di Wi-Fi surau, supaya aplikasi disimpan untuk luar talian, kemudian daftar peranti di dalamnya.<small>Open the MAXCOM icon once on the surau Wi-Fi so the app is saved for offline use, then register the device inside it.</small></li>
</ol>
<p class="warn">Pasang profil MAXCOM hanya untuk kotak surau anda sendiri. Apabila kotak diganti atau kuncinya dijana semula, buang profil MAXCOM yang lama di Tetapan &gt; Umum &gt; VPN &amp; Pengurusan Peranti.<small>Install a MAXCOM profile only for your own surau box. When a box is replaced or re-keyed, remove the old MAXCOM profiles in Settings &gt; General &gt; VPN &amp; Device Management.</small></p>
</main></body></html>
`;

/** Public routes: `GET /app/ios.mobileconfig` (the profile) and `GET /app/ios` (the help page). */
export function registerIosProfileRoutes(app: FastifyInstance, deps: IosProfileDeps): void {
  // Same bytes the public PKI route serves (404 in domain mode or without a CA: nothing to install then).
  const fetchRoot = async (): Promise<Buffer | null> => {
    const root = await app.inject({ method: 'GET', url: '/api/pki/root.cer', headers: { host: 'localhost' } });
    return root.statusCode === 200 ? root.rawPayload : null;
  };

  app.get('/app/ios', async (_request, reply) =>
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(helpPage(rootCommonName(await fetchRoot()))),
  );

  app.get('/app/ios.mobileconfig', async (request, reply) => {
    const via = (request.query as { via?: unknown } | undefined)?.via;
    const cloud = via === 'cloud';
    const info = getSettings(deps.db, publicSurauOf(deps.db, request, deps.role ?? 'box') ?? NEUTRAL_SURAU_ID).surauInfo;
    const surauName = info.name.trim() !== '' ? info.name.trim() : 'MAXCOM';
    const shortStored = info.shortName.trim();
    const label = shortStored !== '' ? shortStored : shortNameOf(surauName);

    let url: string;
    if (cloud) {
      const origin = deps.cloudOrigin();
      url = `${/^https:\/\/[A-Za-z0-9.[\]:-]+$/.test(origin) ? origin : DEFAULT_CLOUD_ORIGIN}/app/`;
    } else {
      const host = pickBoxHost(request.headers.host, deps);
      url = `https://${urlHost(host)}:${deps.httpsPort}/app/`;
    }

    const rootDer = cloud ? null : await fetchRoot();

    // The app icon the box serves for the home screen: the opaque one first.
    let icon: Buffer | null = null;
    for (const path of ['/app/icons/Icon-maskable-192.png', '/app/icons/Icon-192.png']) {
      const r = await app.inject({ method: 'GET', url: path, headers: { host: 'localhost' } });
      if (r.statusCode === 200 && String(r.headers['content-type'] ?? '').startsWith('image/png')) {
        icon = r.rawPayload;
        break;
      }
    }

    const body = buildProfile({ boxId: deps.boxId, surauName, label, url, rootDer, icon, rootName: rootCommonName(rootDer) });
    return reply
      .header('Content-Type', 'application/x-apple-aspen-config')
      .header('Content-Disposition', `attachment; filename="MAXCOM-${asciiFileName(label)}.mobileconfig"`)
      .header('Cache-Control', 'no-store')
      .send(body);
  });
}
