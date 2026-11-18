/**
 * ONVIF discovery of the external camera (plan 4.3, task O1), on the box.
 *
 * Two jobs: a WS-Discovery probe (UDP multicast 239.255.255.250:3702) that lists the cameras of the surau network
 * (name + IP), and `fill`: ask one camera for its RTSP address (`GetCapabilities`, `GetProfiles`, `GetStreamUri`
 * over SOAP with a WS-UsernameToken digest) and return the address with the login merged in.
 *
 * Hard limits, all here: every datagram and every HTTP answer is size capped; every wait has a timeout; the XML is read
 * by a small parser of our own that refuses any DOCTYPE or entity declaration (no external fetch is even possible);
 * only private IPv4 addresses that pass the core camera-address rule are ever contacted, and the media service the
 * camera names is used only when it sits on that same address. A camera login is held in memory for one call: it is
 * never logged, never put in an error and never returned except inside the address handed back to the person who typed it.
 *
 * The network is behind [OnvifTransport], so tests feed recorded probe and SOAP answers.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import { cameraUrlError } from '@surau/core';

export type OnvifCode = 'bad_address' | 'unreachable' | 'not_onvif' | 'login' | 'no_stream' | 'username_missing';

/** The box's fixed words (BM); nothing a camera said is ever returned. */
export const ONVIF_MSG: Record<OnvifCode, string> = {
  bad_address: 'Alamat kamera tidak sah.',
  unreachable: 'Kamera tidak dapat dihubungi. Pastikan kamera hidup pada rangkaian surau.',
  not_onvif: 'Alamat tidak dapat diisi secara automatik. Semak nama pengguna dan kata laluan, pastikan ONVIF dihidupkan pada kamera, atau tampal alamat RTSP.',
  login: 'Alamat tidak dapat diisi secara automatik. Semak nama pengguna dan kata laluan, pastikan ONVIF dihidupkan pada kamera, atau tampal alamat RTSP.',
  no_stream: 'Kamera tidak menyediakan strim H.264 yang boleh diisi. Tampal alamat RTSP.',
  username_missing: 'Masukkan nama pengguna bersama kata laluan.',
};

export class OnvifError extends Error {
  readonly code: OnvifCode;
  constructor(code: OnvifCode) {
    super(ONVIF_MSG[code]);
    this.code = code;
  }
}

export const PROBE_TIMEOUT_MS = 2500;
export const SOAP_TIMEOUT_MS = 4000;
export const MAX_DATAGRAM_CHARS = 32 * 1024;
export const MAX_SOAP_BYTES = 256 * 1024;
export const MAX_DEVICES = 64;
const MAX_DATAGRAMS = 256;
const KNOWN_TTL_MS = 10 * 60_000;
const NAME_MAX = 40;
const LOGIN_MAX = 128;

export interface DiscoveredCamera {
  name: string;
  ip: string;
}

export interface ProbeReply {
  /** The sender's address as the socket saw it. */
  from: string;
  text: string;
}

export interface SoapAnswer {
  status: number;
  text: string;
}

export interface OnvifTransport {
  /** Sends the probe on every LAN interface and returns the datagrams that came back before the timeout. */
  probe(message: string): Promise<ProbeReply[]>;
  /** One SOAP POST to a private address; rejects on a network failure or an answer above the size cap. */
  post(ip: string, port: number, path: string, body: string): Promise<SoapAnswer>;
}

// ---------------------------------------------------------------------------------------------------------------
// XML: a small reader that cannot resolve entities or fetch anything.

export interface XNode {
  /** Local name, prefix removed. */
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XNode[];
}

const XML_MAX_DEPTH = 40;
const XML_MAX_NODES = 20_000;
const XML_MAX_TAG = 4096;
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeText(s: string): string {
  return s.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return safeCodePoint(parseInt(ref.slice(2), 16), whole);
    if (ref.startsWith('#')) return safeCodePoint(parseInt(ref.slice(1), 10), whole);
    return ENTITIES[ref] ?? whole; // a declared entity cannot exist (DOCTYPE is refused); an unknown one stays as written
  });
}

function safeCodePoint(n: number, whole: string): string {
  if (!Number.isFinite(n) || n < 0x20 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return whole;
  return String.fromCodePoint(n);
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]{0,64})\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) out[local(m[1] ?? '')] = decodeText(m[2] ?? m[3] ?? '');
  return out;
}

function local(qname: string): string {
  const i = qname.lastIndexOf(':');
  return i === -1 ? qname : qname.slice(i + 1);
}

/** Parses an XML document into nodes. Throws on anything malformed, any DOCTYPE or entity declaration, or excess size. */
export function parseXml(src: string): XNode {
  if (typeof src !== 'string' || src.length === 0) throw new Error('empty');
  const root: XNode = { name: '#root', attrs: {}, text: '', children: [] };
  const stack: XNode[] = [root];
  let nodes = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1] as XNode;
    if (lt === -1) {
      top.text += decodeText(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('cdata');
      top.text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('pi');
      i = end + 2;
    } else if (src.startsWith('<!', lt)) {
      throw new Error('doctype or entity declaration refused');
    } else if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt + 2);
      if (end === -1) throw new Error('close');
      const name = local(src.slice(lt + 2, end).trim());
      const closed = stack.pop() as XNode;
      if (stack.length === 0 || closed.name !== name) throw new Error('mismatch');
      i = end + 1;
    } else {
      // an opening tag: scan to its '>' honouring quoted attribute values
      let j = lt + 1;
      let quote = '';
      while (j < n) {
        const ch = src[j] as string;
        if (quote !== '') {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        j++;
      }
      if (j >= n) throw new Error('tag');
      if (j - lt > XML_MAX_TAG) throw new Error('tag too long');
      let inner = src.slice(lt + 1, j);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const sp = inner.search(/\s/);
      const qname = sp === -1 ? inner : inner.slice(0, sp);
      if (!/^[A-Za-z_][\w:.-]*$/.test(qname)) throw new Error('name');
      const node: XNode = { name: local(qname), attrs: sp === -1 ? {} : parseAttrs(inner.slice(sp)), text: '', children: [] };
      if (++nodes > XML_MAX_NODES) throw new Error('too many nodes');
      top.children.push(node);
      if (!selfClosing) {
        stack.push(node);
        if (stack.length > XML_MAX_DEPTH) throw new Error('too deep');
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error('unbalanced');
  return root.children[0] as XNode;
}

export function findAll(node: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

export function find(node: XNode, name: string): XNode | null {
  for (const c of node.children) {
    if (c.name === name) return c;
    const d = find(c, name);
    if (d !== null) return d;
  }
  return null;
}

const textOf = (node: XNode | null): string => (node === null ? '' : node.text.trim());

// ---------------------------------------------------------------------------------------------------------------
// WS-Discovery

export function buildProbe(messageId: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<e:Header><w:MessageID>${messageId}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>' +
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>'
  );
}

function privateIp(ip: string, boxIps: readonly string[]): boolean {
  return cameraUrlError(`rtsp://${ip}`, boxIps) === null;
}

/** First http XAddr whose host is exactly `ip` (a camera cannot send the box to another address). */
export function pickXAddr(xaddrs: string, ip: string): string | null {
  for (const raw of xaddrs.split(/\s+/)) {
    const m = /^http:\/\/([0-9.]+)(?::([0-9]{1,5}))?(\/[A-Za-z0-9._~\-/%]*)?$/.exec(raw);
    if (m === null || m[1] !== ip) continue;
    const port = m[2] === undefined ? 80 : Number(m[2]);
    if (port < 1 || port > 65535) continue;
    return `http://${ip}${m[2] === undefined ? '' : `:${port}`}${m[3] ?? '/onvif/device_service'}`;
  }
  return null;
}

function nameFromScopes(scopes: string): string {
  let hardware = '';
  for (const s of scopes.split(/\s+/)) {
    const m = /^onvif:\/\/www\.onvif\.org\/(name|hardware)\/(.+)$/.exec(s);
    if (m === null) continue;
    let v = m[2] as string;
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep as written */
    }
    v = v.replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '').trim().slice(0, NAME_MAX);
    if (v === '') continue;
    if (m[1] === 'name') return v;
    if (hardware === '') hardware = v;
  }
  return hardware !== '' ? hardware : 'Kamera';
}

/** One probe answer, or null when it is not a ProbeMatch for our probe from an acceptable sender. */
export function parseProbeMatch(reply: ProbeReply, messageId: string, boxIps: readonly string[]): { camera: DiscoveredCamera; xaddr: string | null } | null {
  if (reply.text.length > MAX_DATAGRAM_CHARS || !privateIp(reply.from, boxIps)) return null;
  if (!reply.text.includes(messageId)) return null; // not an answer to our probe: nothing to parse
  let doc: XNode;
  try {
    doc = parseXml(reply.text);
  } catch {
    return null;
  }
  if (textOf(find(doc, 'RelatesTo')) !== messageId) return null;
  const match = find(doc, 'ProbeMatch');
  if (match === null) return null;
  if (!/(^|[\s:])NetworkVideoTransmitter(\s|$)/.test(textOf(find(match, 'Types')))) return null;
  return { camera: { name: nameFromScopes(textOf(find(match, 'Scopes'))), ip: reply.from }, xaddr: pickXAddr(textOf(find(match, 'XAddrs')), reply.from) };
}

// ---------------------------------------------------------------------------------------------------------------
// SOAP

const NS_SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const NS_WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const NS_WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const PW_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const B64 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

interface Login {
  username: string;
  password: string;
}

function envelope(body: string, login: Login | null, timeMs: number, nonce: Buffer): string {
  let header = '';
  if (login !== null) {
    const created = new Date(timeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const digest = createHash('sha1').update(nonce).update(created).update(login.password).digest('base64');
    header =
      `<s:Header><wsse:Security xmlns:wsse="${NS_WSSE}" xmlns:wsu="${NS_WSU}"><wsse:UsernameToken>` +
      `<wsse:Username>${xmlEscape(login.username)}</wsse:Username>` +
      `<wsse:Password Type="${PW_DIGEST}">${digest}</wsse:Password>` +
      `<wsse:Nonce EncodingType="${B64}">${nonce.toString('base64')}</wsse:Nonce>` +
      `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS_SOAP}">${header}<s:Body>${body}</s:Body></s:Envelope>`;
}

const DEVICE_NS = 'http://www.onvif.org/ver10/device/wsdl';
const MEDIA_NS = 'http://www.onvif.org/ver10/media/wsdl';
const SCHEMA_NS = 'http://www.onvif.org/ver10/schema';

const bodyDateTime = `<GetSystemDateAndTime xmlns="${DEVICE_NS}"/>`;
const bodyCapabilities = `<GetCapabilities xmlns="${DEVICE_NS}"><Category>Media</Category></GetCapabilities>`;
const bodyProfiles = `<GetProfiles xmlns="${MEDIA_NS}"/>`;
const bodyStreamUri = (token: string): string =>
  `<GetStreamUri xmlns="${MEDIA_NS}"><StreamSetup><Stream xmlns="${SCHEMA_NS}">RTP-Unicast</Stream><Transport xmlns="${SCHEMA_NS}"><Protocol>RTSP</Protocol></Transport></StreamSetup><ProfileToken>${xmlEscape(token)}</ProfileToken></GetStreamUri>`;

const AUTH_FAULT = /NotAuthorized|Not Authorized|Unauthorized|FailedAuthentication|Authority|AuthFailed/i;

type Reply = { kind: 'ok'; body: XNode } | { kind: 'auth' };

function splitUrl(url: string): { ip: string; port: number; path: string } {
  const m = /^http:\/\/([0-9.]+)(?::([0-9]{1,5}))?(\/.*)?$/.exec(url);
  if (m === null) throw new OnvifError('bad_address');
  return { ip: m[1] as string, port: m[2] === undefined ? 80 : Number(m[2]), path: m[3] ?? '/' };
}

/** `ProfileToken` and the picture size of the H.264 profile with the most pixels (the main stream), or null. */
export function pickProfile(doc: XNode): string | null {
  let best: { token: string; px: number } | null = null;
  for (const p of findAll(doc, 'Profiles')) {
    const token = p.attrs.token;
    if (token === undefined || token === '' || token.length > 100) continue;
    const enc = find(p, 'VideoEncoderConfiguration');
    if (enc === null || !/^H\.?264$/i.test(textOf(find(enc, 'Encoding')))) continue;
    const w = Number(textOf(find(enc, 'Width')));
    const h = Number(textOf(find(enc, 'Height')));
    const px = Number.isFinite(w) && Number.isFinite(h) ? w * h : 0;
    if (best === null || px > best.px) best = { token, px };
  }
  return best === null ? null : best.token;
}

function parseUtc(doc: XNode): number | null {
  const utc = find(doc, 'UTCDateTime');
  if (utc === null) return null;
  const f = (n: string): number => Number(textOf(find(utc, n)));
  const t = Date.UTC(f('Year'), f('Month') - 1, f('Day'), f('Hour'), f('Minute'), f('Second'));
  return Number.isFinite(t) ? t : null;
}

const encodeLogin = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The camera's own address as the box will use it: host forced to the camera's IP, its login dropped, ours merged in. */
export function buildRtspUrl(uri: string, ip: string, login: Login | null, boxIps: readonly string[]): string | null {
  if (!uri.startsWith('rtsp://')) return null;
  const rest = uri.slice('rtsp://'.length);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? '' : rest.slice(cut);
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const colon = hostPort.indexOf(':');
  const port = colon === -1 ? '' : hostPort.slice(colon + 1);
  if (port !== '' && !/^[0-9]{1,5}$/.test(port)) return null;
  const info = login === null || login.username === '' ? '' : `${encodeLogin(login.username)}${login.password === '' ? '' : `:${encodeLogin(login.password)}`}@`;
  const url = `rtsp://${info}${ip}${port === '' ? '' : `:${port}`}${tail}`;
  return cameraUrlError(url, boxIps) === null ? url : null;
}

export interface OnvifOptions {
  transport?: OnvifTransport;
  boxIps?: readonly string[];
  now?: () => number;
}

export class OnvifClient {
  private readonly transport: OnvifTransport;
  private readonly boxIps: readonly string[];
  private readonly now: () => number;
  private readonly known = new Map<string, { name: string; xaddr: string | null; at: number }>();
  private inflight: Promise<DiscoveredCamera[]> | null = null;

  constructor(o: OnvifOptions = {}) {
    this.transport = o.transport ?? new NetOnvifTransport(o.boxIps ?? []);
    this.boxIps = o.boxIps ?? [];
    this.now = o.now ?? Date.now;
  }

  /** The cameras that answered the probe, deduplicated by address; calls made while one probe runs share it. */
  discover(): Promise<DiscoveredCamera[]> {
    if (this.inflight === null) {
      this.inflight = this.runProbe().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async runProbe(): Promise<DiscoveredCamera[]> {
    const id = `urn:uuid:${randomUUID()}`;
    let replies: ProbeReply[];
    try {
      replies = await this.transport.probe(buildProbe(id));
    } catch {
      return [];
    }
    const found = new Map<string, DiscoveredCamera>();
    const at = this.now();
    for (const r of replies.slice(0, MAX_DATAGRAMS)) {
      const m = parseProbeMatch(r, id, this.boxIps);
      if (m === null || found.has(m.camera.ip)) continue;
      if (found.size >= MAX_DEVICES) break;
      found.set(m.camera.ip, m.camera);
      this.known.set(m.camera.ip, { name: m.camera.name, xaddr: m.xaddr, at });
    }
    for (const [ip, v] of this.known) if (at - v.at > KNOWN_TTL_MS) this.known.delete(ip);
    return [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, 'en', { numeric: true }));
  }

  /** The camera's RTSP address with `login` merged in. Throws [OnvifError] with a fixed code. */
  async fill(ip: string, username: string, password: string): Promise<string> {
    if (typeof ip !== 'string' || !privateIp(ip, this.boxIps)) throw new OnvifError('bad_address');
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > LOGIN_MAX || password.length > LOGIN_MAX || /[\u0000-\u001f\u007f]/.test(username + password)) {
      throw new OnvifError('bad_address');
    }
    if (username === '' && password !== '') throw new OnvifError('username_missing');
    const login: Login | null = username === '' ? null : { username, password };
    const known = this.known.get(ip);
    const deviceUrl = known?.xaddr ?? `http://${ip}/onvif/device_service`;
    const clock = { offsetMs: null as number | null };

    let mediaUrl = deviceUrl;
    try {
      const caps = await this.call(ip, deviceUrl, bodyCapabilities, login, clock, deviceUrl);
      const x = textOf(find(find(caps, 'Media') ?? caps, 'XAddr'));
      const picked = pickXAddr(x, ip);
      if (picked !== null) mediaUrl = picked;
    } catch (e) {
      // a camera that does not know GetCapabilities may still serve the media service at the device address
      if (e instanceof OnvifError && (e.code === 'login' || e.code === 'unreachable')) throw e;
    }

    const profiles = await this.call(ip, mediaUrl, bodyProfiles, login, clock, deviceUrl);
    const token = pickProfile(profiles);
    if (token === null) throw new OnvifError('no_stream');
    const stream = await this.call(ip, mediaUrl, bodyStreamUri(token), login, clock, deviceUrl);
    const uri = textOf(find(stream, 'Uri'));
    const url = buildRtspUrl(uri, ip, login, this.boxIps);
    if (url === null) throw new OnvifError('no_stream');
    return url;
  }

  /** One authenticated SOAP call with the clock-skew retry; returns the Body element. */
  private async call(ip: string, url: string, body: string, login: Login | null, clock: { offsetMs: number | null }, deviceUrl: string): Promise<XNode> {
    let r = await this.attempt(ip, url, body, login, clock.offsetMs ?? 0);
    if (r.kind === 'auth') {
      if (login !== null && clock.offsetMs === null) {
        clock.offsetMs = await this.skew(ip, deviceUrl);
        if (clock.offsetMs !== 0) r = await this.attempt(ip, url, body, login, clock.offsetMs);
      }
      if (r.kind === 'auth') throw new OnvifError('login');
    }
    return r.body;
  }

  /** Camera clock minus ours, from `GetSystemDateAndTime` (which cameras answer without a login); 0 when unknown or small. */
  private async skew(ip: string, deviceUrl: string): Promise<number> {
    try {
      const r = await this.attempt(ip, deviceUrl, bodyDateTime, null, 0);
      if (r.kind !== 'ok') return 0;
      const cam = parseUtc(r.body);
      if (cam === null) return 0;
      const d = cam - this.now();
      return Math.abs(d) < 2000 ? 0 : d;
    } catch {
      return 0;
    }
  }

  private async attempt(ip: string, url: string, body: string, login: Login | null, offsetMs: number): Promise<Reply> {
    const u = splitUrl(url);
    if (u.ip !== ip) throw new OnvifError('bad_address'); // only the one camera is ever contacted
    let answer: SoapAnswer;
    try {
      answer = await this.transport.post(u.ip, u.port, u.path, envelope(body, login, this.now() + offsetMs, randomBytes(16)));
    } catch {
      throw new OnvifError('unreachable');
    }
    if (answer.status === 401 || answer.status === 403) return { kind: 'auth' };
    let doc: XNode;
    try {
      doc = parseXml(answer.text);
    } catch {
      throw new OnvifError('not_onvif');
    }
    if (doc.name !== 'Envelope') throw new OnvifError('not_onvif');
    const fault = find(doc, 'Fault');
    if (fault !== null) {
      const words = findAll(fault, 'Value').map(textOf).join(' ') + ' ' + findAll(fault, 'Text').map(textOf).join(' ');
      if (AUTH_FAULT.test(words)) return { kind: 'auth' };
      throw new OnvifError('not_onvif');
    }
    if (answer.status !== 200) throw new OnvifError('not_onvif');
    const b = find(doc, 'Body');
    if (b === null) throw new OnvifError('not_onvif');
    return { kind: 'ok', body: b };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The real network

/** The box's own private IPv4 interface addresses: where the probe leaves from. */
export function lanInterfaces(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || (a.family as unknown) === 4) && !a.internal && cameraUrlError(`rtsp://${a.address}`) === null && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** Every address of every local interface (any family, internal ones too): none of them can be a camera. */
export function localAddresses(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) for (const a of list ?? []) out.add(a.address);
  return [...out];
}

export class NetOnvifTransport implements OnvifTransport {
  private readonly boxIps: readonly string[];
  private readonly interfaces: () => string[];

  constructor(boxIps: readonly string[], interfaces: () => string[] = lanInterfaces) {
    this.boxIps = boxIps;
    this.interfaces = interfaces;
  }

  async probe(message: string): Promise<ProbeReply[]> {
    const replies: ProbeReply[] = [];
    const sockets: dgram.Socket[] = [];
    const buf = Buffer.from(message, 'utf8');
    const addrs = this.interfaces();
    if (addrs.length === 0) return []; // no private interface: nothing to send from, nothing to wait for
    for (const addr of addrs) {
      const s = dgram.createSocket({ type: 'udp4' });
      sockets.push(s);
      s.on('error', () => undefined);
      s.on('message', (m, rinfo) => {
        if (replies.length >= MAX_DATAGRAMS || m.length > MAX_DATAGRAM_CHARS) return;
        replies.push({ from: rinfo.address, text: m.toString('utf8') });
      });
      s.bind({ address: addr, port: 0 }, () => {
        try {
          s.setMulticastInterface(addr);
          s.setMulticastTTL(1);
          s.send(buf, 3702, '239.255.255.250', () => undefined);
        } catch {
          /* this interface cannot send: the others still may */
        }
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS));
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    return replies;
  }

  post(ip: string, port: number, path: string, body: string): Promise<SoapAnswer> {
    if (!privateIp(ip, this.boxIps)) return Promise.reject(new Error('address'));
    return httpPost(ip, port, path, body, MAX_SOAP_BYTES, SOAP_TIMEOUT_MS);
  }
}

/** One POST with a hard size cap on the answer and a hard time limit; no redirect is followed, no connection is kept. */
export function httpPost(host: string, port: number, path: string, body: string, maxBytes: number, timeoutMs: number): Promise<SoapAnswer> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8');
    const req = http.request(
      { host, port, path, method: 'POST', agent: false, headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': data.length } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new Error('too big'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    const total = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('close', () => clearTimeout(total));
    req.on('error', reject);
    req.end(data);
  });
}
