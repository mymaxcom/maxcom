import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cameraUrlError } from '@surau/core';
import { NetOnvifTransport, OnvifClient, OnvifError, buildProbe, httpPost, localAddresses, parseProbeMatch, parseXml } from '../src/live/onvif.ts';
import type { OnvifTransport, ProbeReply, SoapAnswer } from '../src/live/onvif.ts';

const fx = (name: string): string => readFileSync(new URL(`./fixtures/onvif/${name}`, import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 10, 17, 10, 0, 0);
const BOX = '10.168.1.40';
const CAM = '10.168.1.20';

function probeReply(id: string, o: { from?: string; name?: string; xaddrs?: string } = {}): ProbeReply {
  const from = o.from ?? CAM;
  return {
    from,
    text: fx('probe-match.xml')
      .replace('{{RELATES}}', id)
      .replace('{{NAME}}', o.name ?? 'Kamera%20Dewan')
      .replace('{{XADDRS}}', o.xaddrs ?? `http://${from}/onvif/device_service http://[fe80::1]/onvif/device_service`),
  };
}

type FakeOpts = {
  ip?: string;
  user?: string;
  pass?: string;
  clockOffsetMs?: number;
  profiles?: string;
  uriHost?: string;
  mediaXAddr?: string;
  raw?: Partial<Record<string, SoapAnswer>>;
};

/** A camera on the other end of the SOAP calls: checks the digest against its own clock, like a real one. */
class FakeCamera {
  calls: Array<{ ip: string; port: number; path: string; op: string }> = [];
  private readonly o: FakeOpts;
  constructor(o: FakeOpts = {}) {
    this.o = o;
  }

  asTransport(replies: ProbeReply[] | ((id: string) => ProbeReply[]) = []): OnvifTransport {
    return {
      probe: async (message: string) => {
        const id = /<w:MessageID>([^<]+)<\/w:MessageID>/.exec(message)?.[1] ?? '';
        return typeof replies === 'function' ? replies(id) : replies;
      },
      post: async (ip, port, path, body) => this.answer(ip, port, path, body),
    };
  }

  private fault(): SoapAnswer {
    return { status: 400, text: fx('fault-notauthorized.xml') };
  }

  private async answer(ip: string, port: number, path: string, body: string): Promise<SoapAnswer> {
    const op = /<(GetSystemDateAndTime|GetCapabilities|GetProfiles|GetStreamUri)\b/.exec(body)?.[1] ?? '?';
    this.calls.push({ ip, port, path, op });
    const raw = this.o.raw?.[op];
    if (raw !== undefined) return raw;
    const cam = T0 + (this.o.clockOffsetMs ?? 0);
    if (op === 'GetSystemDateAndTime') {
      const d = new Date(cam);
      return {
        status: 200,
        text: fx('datetime.xml')
          .replace('{{H}}', String(d.getUTCHours()))
          .replace('{{M}}', String(d.getUTCMinutes()))
          .replace('{{S}}', String(d.getUTCSeconds()))
          .replace('{{Y}}', String(d.getUTCFullYear()))
          .replace('{{MO}}', String(d.getUTCMonth() + 1))
          .replace('{{D}}', String(d.getUTCDate())),
      };
    }
    if (this.o.user !== undefined) {
      const u = /<wsse:Username>([^<]*)<\/wsse:Username>/.exec(body)?.[1];
      const digest = /<wsse:Password[^>]*>([^<]*)<\/wsse:Password>/.exec(body)?.[1];
      const nonce = /<wsse:Nonce[^>]*>([^<]*)<\/wsse:Nonce>/.exec(body)?.[1];
      const created = /<wsu:Created>([^<]*)<\/wsu:Created>/.exec(body)?.[1];
      if (u === undefined || digest === undefined || nonce === undefined || created === undefined) return this.fault();
      const want = createHash('sha1').update(Buffer.from(nonce, 'base64')).update(created).update(this.o.pass ?? '').digest('base64');
      if (u !== this.o.user || digest !== want || Math.abs(Date.parse(created) - cam) > 5000) return this.fault();
    }
    if (op === 'GetCapabilities') return { status: 200, text: this.o.mediaXAddr === undefined ? fx('capabilities.xml') : fx('capabilities.xml').replace('http://10.168.1.20:8080/onvif/media_service', this.o.mediaXAddr) };
    if (op === 'GetProfiles') return { status: 200, text: this.o.profiles ?? fx('profiles.xml') };
    if (op === 'GetStreamUri') {
      const token = /<ProfileToken>([^<]*)<\/ProfileToken>/.exec(body)?.[1];
      if (token !== 'main_h264') return { status: 400, text: fx('fault-notauthorized.xml').replace('NotAuthorized', 'InvalidArgVal') };
      return { status: 200, text: fx('streamuri.xml').replace('{{HOST}}', this.o.uriHost ?? CAM) };
    }
    return { status: 500, text: '' };
  }
}

const client = (t: OnvifTransport) => new OnvifClient({ transport: t, boxIps: [BOX], now: () => T0 });
const failure = async (p: Promise<unknown>): Promise<OnvifError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OnvifError);
    return e as OnvifError;
  }
  throw new Error('expected a refusal');
};

describe('discovery probe', () => {
  it('sends a WS-Discovery Probe for NetworkVideoTransmitter with its own message id', () => {
    const p = buildProbe('urn:uuid:abc');
    expect(p).toContain('urn:uuid:abc');
    expect(p).toContain('NetworkVideoTransmitter');
    expect(p).toContain('discovery/Probe');
  });

  it('lists a normal camera by the name in its scopes and its address; duplicates and the box itself are dropped', async () => {
    const cam = new FakeCamera();
    const c = client(
      cam.asTransport((id) => [
        probeReply(id),
        probeReply(id), // the same camera answers on two interfaces
        probeReply(id, { from: '10.168.1.21', name: 'Pintu%20Utama' }),
        probeReply(id, { from: BOX }),
      ]),
    );
    expect(await c.discover()).toEqual([
      { name: 'Kamera Dewan', ip: CAM },
      { name: 'Pintu Utama', ip: '10.168.1.21' },
    ]);
  });

  it('keeps only private addresses, replies to its own probe, NetworkVideoTransmitter types, and well-formed answers', async () => {
    const cam = new FakeCamera();
    const bad: ProbeReply[] = [];
    const c = client(
      cam.asTransport((id) => {
        bad.push(probeReply(id, { from: '8.8.8.8' }));
        bad.push(probeReply('urn:uuid:someone-elses-probe'));
        bad.push({ from: '10.168.1.30', text: probeReply(id, { from: '10.168.1.30' }).text.replace('NetworkVideoTransmitter', 'Printer') });
        bad.push({ from: '10.168.1.31', text: fx('not-onvif.html') });
        bad.push({ from: '10.168.1.32', text: 'x'.repeat(200_000) });
        bad.push({ from: '10.168.1.33', text: fx('xxe.xml') });
        return [...bad, probeReply(id, { from: '10.168.1.22' })];
      }),
    );
    expect(await c.discover()).toEqual([{ name: 'Kamera Dewan', ip: '10.168.1.22' }]);
  });

  it('a camera without a name scope is listed as Kamera; the name is cleaned and shortened', () => {
    const none = probeReply('i', { name: '' }).text.replace(/onvif:\/\/www\.onvif\.org\/name\/ /, '').replace(' onvif://www.onvif.org/hardware/IPC-X100', '');
    expect(parseProbeMatch({ from: CAM, text: none }, 'i', [BOX])?.camera.name).toBe('Kamera');
    const long = probeReply('i', { name: encodeURIComponent('<b>' + 'A'.repeat(100)) });
    const name = parseProbeMatch(long, 'i', [BOX])?.camera.name ?? '';
    expect(name).not.toContain('<');
    expect(name.length).toBeLessThanOrEqual(40);
  });

  it('an XAddr that points at another host is ignored (the camera cannot send the box elsewhere)', () => {
    const r = probeReply('i', { xaddrs: 'http://10.0.0.9/onvif/device_service' });
    expect(parseProbeMatch(r, 'i', [BOX])?.xaddr).toBeNull();
  });

  it('a failed probe is an empty list, never an error', async () => {
    const c = client({ probe: async () => Promise.reject(new Error('no interface')), post: async () => ({ status: 500, text: '' }) });
    expect(await c.discover()).toEqual([]);
  });
});

describe('fill: GetProfiles, GetStreamUri', () => {
  it('a normal camera: the main H.264 profile, the host forced to the camera, the login merged in', async () => {
    const cam = new FakeCamera({ user: 'viewer', pass: 'lihat123' });
    const c = client(cam.asTransport((id) => [probeReply(id)]));
    await c.discover();
    const url = await c.fill(CAM, 'viewer', 'lihat123');
    expect(url).toBe(`rtsp://viewer:lihat123@${CAM}:554/Streaming/Channels/101?transportmode=unicast&profile=Profile_1`);
    expect(cameraUrlError(url, [BOX])).toBeNull();
    expect(cam.calls.map((x) => x.op)).toEqual(['GetCapabilities', 'GetProfiles', 'GetStreamUri']);
    expect(new Set(cam.calls.map((x) => x.ip))).toEqual(new Set([CAM]));
    expect(cam.calls[1]?.port).toBe(8080); // the media service the camera named, on its own address
  });

  it('a camera with no login at all fills without a login in the address', async () => {
    const cam = new FakeCamera();
    const url = await client(cam.asTransport()).fill(CAM, '', '');
    expect(url).toBe(`rtsp://${CAM}:554/Streaming/Channels/101?transportmode=unicast&profile=Profile_1`);
  });

  it('a wrong clock: the first login fails, the box reads the camera time and retries with it', async () => {
    const cam = new FakeCamera({ user: 'viewer', pass: 'lihat123', clockOffsetMs: -3 * 3_600_000 });
    const url = await client(cam.asTransport()).fill(CAM, 'viewer', 'lihat123');
    expect(url).toContain('viewer:lihat123@');
    expect(cam.calls.map((x) => x.op)).toEqual(['GetCapabilities', 'GetSystemDateAndTime', 'GetCapabilities', 'GetProfiles', 'GetStreamUri']);
  });

  it('a refused login: code login, a fixed message, and the password nowhere in it', async () => {
    const cam = new FakeCamera({ user: 'viewer', pass: 'lihat123' });
    const e = await failure(client(cam.asTransport()).fill(CAM, 'viewer', 'salah-sangat'));
    expect(e.code).toBe('login');
    expect(JSON.stringify(e.message)).not.toContain('salah-sangat');
    // the clock is right, so there is no retry and no guessing loop: one try, one clock read
    expect(cam.calls.filter((x) => x.op === 'GetCapabilities')).toHaveLength(1);
  });

  it('a camera that wants a login when none was given is a login refusal', async () => {
    const cam = new FakeCamera({ user: 'viewer', pass: 'lihat123' });
    expect((await failure(client(cam.asTransport()).fill(CAM, '', ''))).code).toBe('login');
  });

  it('a non-ONVIF reply (a web page) is not_onvif', async () => {
    const cam = new FakeCamera({ raw: { GetCapabilities: { status: 200, text: fx('not-onvif.html') }, GetProfiles: { status: 200, text: fx('not-onvif.html') } } });
    expect((await failure(client(cam.asTransport()).fill(CAM, 'u', 'p'))).code).toBe('not_onvif');
  });

  it('an XML entity attack is refused as data: no DOCTYPE is read, nothing is fetched', async () => {
    const cam = new FakeCamera({ raw: { GetProfiles: { status: 200, text: fx('xxe.xml') } } });
    expect((await failure(client(cam.asTransport()).fill(CAM, '', ''))).code).toBe('not_onvif');
    expect(() => parseXml(fx('xxe.xml'))).toThrow();
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY b "c">]><a>&b;</a>')).toThrow();
    expect(() => parseXml('<a><!ENTITY b "c"></a>')).toThrow();
    // predefined and numeric references are decoded; an undeclared name stays literal
    expect(parseXml('<a>x &amp; &#65; &unknown;</a>').text).toBe('x & A &unknown;');
  });

  it('an oversized answer is cut at the cap and counts as unreachable', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/soap+xml');
      res.end('<a>' + 'x'.repeat(300_000) + '</a>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(httpPost('127.0.0.1', port, '/', '<x/>', 256 * 1024, 2000)).rejects.toThrow('too big');
      const ok = await httpPost('127.0.0.1', port, '/', '<x/>', 400_000, 2000);
      expect(ok.status).toBe(200);
    } finally {
      server.close();
    }
    const cam = new FakeCamera();
    const t = cam.asTransport();
    const e = await failure(client({ ...t, post: async () => Promise.reject(new Error('too big')) }).fill(CAM, '', ''));
    expect(e.code).toBe('unreachable');
  });

  it('a camera that never answers is cut at the time limit', async () => {
    const server = http.createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(httpPost('127.0.0.1', port, '/', '<x/>', 1000, 150)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('only a private address that passes the rule is ever contacted', async () => {
    const cam = new FakeCamera();
    const c = client(cam.asTransport());
    for (const ip of ['8.8.8.8', '127.0.0.1', BOX, '169.254.169.254', '10.168.1.20/x', 'camera.local', '0x7f000001', '10.168.1.20:80', '']) {
      expect((await failure(c.fill(ip, '', ''))).code, ip).toBe('bad_address');
    }
    expect(cam.calls).toEqual([]);
  });

  it('a media service on another address is not followed; a stream address on another host is rewritten to the camera', async () => {
    const cam = new FakeCamera({ mediaXAddr: 'http://10.9.9.9/onvif/media_service', uriHost: '10.9.9.9' });
    const url = await client(cam.asTransport()).fill(CAM, '', '');
    expect(url.startsWith(`rtsp://${CAM}:554/`)).toBe(true);
    expect(new Set(cam.calls.map((x) => x.ip))).toEqual(new Set([CAM]));
  });

  it('a camera with only H.265 profiles has no stream to fill', async () => {
    const cam = new FakeCamera({ profiles: fx('profiles-h265-only.xml') });
    expect((await failure(client(cam.asTransport()).fill(CAM, '', ''))).code).toBe('no_stream');
  });

  it('a login with characters that need escaping is encoded so the address passes the core rule', async () => {
    const pass = "p@ss:w/rd'(1)#";
    const cam = new FakeCamera({ user: 'ad min', pass });
    const url = await client(cam.asTransport()).fill(CAM, 'ad min', pass);
    expect(cameraUrlError(url, [BOX])).toBeNull();
    expect(url).toContain('ad%20min:p%40ss%3Aw%2Frd%27%281%29%23@');
  });

  it('a login with control characters or a huge one is refused before any call', async () => {
    const cam = new FakeCamera();
    const c = client(cam.asTransport());
    expect((await failure(c.fill(CAM, 'a\nb', 'x'))).code).toBe('bad_address');
    expect((await failure(c.fill(CAM, 'a', 'x'.repeat(500)))).code).toBe('bad_address');
    expect(cam.calls).toEqual([]);
  });
});

describe('hostile input stays cheap (round 2 review fixes)', () => {
  const timeIt = (fn: () => unknown): number => {
    const t = performance.now();
    fn();
    return performance.now() - t;
  };

  it('a 32 KB discovery datagram made of one long attribute-like run is dropped in under 50 ms', () => {
    const text = `<s:Envelope ${'a'.repeat(32 * 1024 - 40)}>`;
    expect(text.length).toBeLessThanOrEqual(32 * 1024);
    let out: unknown = 'x';
    const ms = timeIt(() => {
      out = parseProbeMatch({ from: CAM, text }, 'urn:uuid:abc', [BOX]);
    });
    expect(out).toBeNull();
    expect(ms).toBeLessThan(50);
  });

  it('a 256 KB SOAP answer with a hostile tag is rejected or parsed in under 50 ms', () => {
    const text = `<Envelope ${'a'.repeat(256 * 1024)}><Body/></Envelope>`;
    const ms = timeIt(() => {
      try {
        parseXml(text);
      } catch {
        /* refused */
      }
    });
    expect(ms).toBeLessThan(50);
  });

  it('an opening tag above 4 KB is refused', () => {
    expect(() => parseXml(`<a ${'b="1" '.repeat(700)}/>`)).toThrow();
    expect(parseXml('<a b="1" c="2"><d/></a>').attrs).toEqual({ b: '1', c: '2' });
  });
});

describe('probe and fill guards (round 2 review fixes)', () => {
  it('a box with no private interface answers the probe at once, without waiting for the timeout', async () => {
    const t = new NetOnvifTransport([BOX], () => []);
    const start = performance.now();
    await expect(t.probe('<x/>')).resolves.toEqual([]);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('a password without a user name is refused with its own code before any call', async () => {
    const cam = new FakeCamera();
    const e = await failure(client(cam.asTransport()).fill(CAM, '', 'secret-pass'));
    expect(e.code).toBe('username_missing');
    expect(cam.calls).toEqual([]);
    expect(e.message).not.toContain('secret-pass');
  });

  it('every address of every local interface counts as the box itself', () => {
    const ifaces = {
      eth0: [{ address: '10.168.1.40', family: 'IPv4', internal: false }],
      wlan0: [
        { address: '10.0.0.7', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
    };
    expect(localAddresses(ifaces as never).sort()).toEqual(['10.0.0.7', '10.168.1.40', 'fe80::1']);
    const c = new OnvifClient({ transport: new FakeCamera().asTransport(), boxIps: localAddresses(ifaces as never) });
    return expect(failure(c.fill('10.0.0.7', '', ''))).resolves.toMatchObject({ code: 'bad_address' });
  });
});
