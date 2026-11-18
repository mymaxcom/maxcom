import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { buildProfile, pickBoxHost, profileUuid, rootCommonName, xmlEscape } from '../src/iosProfile.ts';
import { putFeature } from '../src/settingsStore.ts';

const ROOT_DER = Buffer.from([0x30, 0x82, 0x01, 0x02, 0x03, 0x04, 0xff]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let dir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'surau-ios-'));
  const appDir = join(dir, 'webapp');
  mkdirSync(join(appDir, 'icons'), { recursive: true });
  writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(appDir, 'icons', 'Icon-maskable-192.png'), PNG);
  writeFileSync(join(appDir, 'icons', 'Icon-192.png'), PNG);
  mkdirSync(join(dir, 'data', 'pki'), { recursive: true });
  writeFileSync(join(dir, 'data', 'pki', 'root-ca.cer'), ROOT_DER);
  app = buildApp(join(dir, 'test.db'), {
    dataDir: join(dir, 'data'),
    appDir,
    boxId: 'box123abc',
    httpsPort: 8443,
    allowedHosts: ['10.168.1.20', 'box.surau.local'],
    tls: { ipSan: ['10.168.1.20'], dnsSan: ['box.surau.local'] } as never,
  });
  await app.ready();
  putFeature(app.surau.db, 'surauInfo', { name: 'Surau Al-Hidayah Taman Indah' }, 'test', undefined, 'sdm');
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, host?: string) =>
  app.inject({ method: 'GET', url, remoteAddress: '10.168.1.5', headers: host ? { host } : {} });

const payloadTypes = (xml: string): string[] =>
  [...xml.matchAll(/<key>PayloadType<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => m[1]!);

describe('GET /app/ios.mobileconfig', () => {
  it('sets content type, attachment filename and no-store', async () => {
    const r = await get('/app/ios.mobileconfig', '10.168.1.20:8443');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/x-apple-aspen-config');
    expect(r.headers['content-disposition']).toBe('attachment; filename="MAXCOM-Surau.mobileconfig"');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('is a well-formed plist with the root CA and the web clip', async () => {
    const xml = (await get('/app/ios.mobileconfig', '10.168.1.20:8443')).body;
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    // balanced tags: every opening dict/array/plist has its close
    for (const t of ['dict', 'array', 'plist']) {
      expect((xml.match(new RegExp(`<${t}[ >]`, 'g')) ?? []).length).toBe((xml.match(new RegExp(`</${t}>`, 'g')) ?? []).length);
    }
    expect(payloadTypes(xml).sort()).toEqual(['Configuration', 'com.apple.security.root', 'com.apple.webClip.managed']);
    const content = /<key>PayloadContent<\/key>\s*<data>([^<]*)<\/data>/.exec(xml)!;
    expect(Buffer.compare(Buffer.from(content[1]!, 'base64'), ROOT_DER)).toBe(0);
    expect(xml).toContain('<string>MAXCOM Surau Al-Hidayah Taman Indah CA</string>');
    expect(xml).toContain('<string>https://10.168.1.20:8443/app/</string>');
    expect(xml).toContain('<key>Label</key>\n\t\t\t<string>Surau</string>');
    expect(xml).toContain('<key>FullScreen</key>\n\t\t\t<true/>');
    expect(xml).toContain('<key>Precomposed</key>\n\t\t\t<true/>');
    expect(xml).toContain('<key>PayloadRemovalDisallowed</key>\n\t<false/>');
    expect(xml).toContain('<string>my.maxcom.box.box123abc.ios</string>');
    expect(xml).toContain('<string>Pasang sijil kotak MAXCOM surau ini dan ikon aplikasi pentadbiran pada skrin utama.</string>');
    expect(xml).toContain(`<data>${PNG.toString('base64')}</data>`);
  });

  it('ignores a forged Host header and falls back to the first LAN IP', async () => {
    const r = await app.inject({ method: 'GET', url: '/app/ios.mobileconfig', remoteAddress: '10.168.1.5', headers: { host: 'localhost' } });
    expect(r.body).toContain('<string>https://10.168.1.20:8443/app/</string>');
    expect(pickBoxHost('evil.example.com', { lanIps: ['10.168.1.20'], allowedHosts: () => new Set(['10.168.1.20']) })).toBe('10.168.1.20');
    expect(pickBoxHost('box.surau.local:8443', { lanIps: ['10.168.1.20'], allowedHosts: () => new Set(['10.168.1.20', 'box.surau.local']) })).toBe('box.surau.local');
    expect(pickBoxHost(undefined, { lanIps: [], allowedHosts: () => new Set(['localhost']) })).toBe('box.surau.local');
  });

  it('uses an own name from the Host header', async () => {
    const r = await get('/app/ios.mobileconfig', 'box.surau.local:8443');
    expect(r.body).toContain('<string>https://box.surau.local:8443/app/</string>');
  });

  it('pickBoxHost: a numbered name wins over the request Host and the IP; a legacy root changes nothing', () => {
    const deps = { lanIps: ['10.168.1.20'], allowedHosts: () => new Set(['10.168.1.20', 'box1-surau.local']) };
    expect(pickBoxHost('10.168.1.20:8443', { ...deps, boxName: () => 'box1-surau.local' })).toBe('box1-surau.local');
    expect(pickBoxHost(undefined, { ...deps, boxName: () => 'box1-surau.local' })).toBe('box1-surau.local');
    expect(pickBoxHost('10.168.1.20:8443', { ...deps, boxName: () => null })).toBe('10.168.1.20');
    expect(pickBoxHost('10.168.1.20:8443', deps)).toBe('10.168.1.20');
  });

  it('?via=cloud has the cloud URL and no root CA payload', async () => {
    const r = await get('/app/ios.mobileconfig?via=cloud', '10.168.1.20:8443');
    expect(r.statusCode).toBe(200);
    expect(payloadTypes(r.body).sort()).toEqual(['Configuration', 'com.apple.webClip.managed']);
    expect(r.body).toContain('<string>https://api.mymaxcom.my/app/</string>');
    expect(r.body).not.toContain('com.apple.security.root');
  });

  it('is public (no session needed)', async () => {
    expect((await get('/app/ios.mobileconfig')).statusCode).toBe(200);
    expect((await get('/app/ios')).statusCode).toBe(200);
  });
});

describe('profile building', () => {
  it('escapes XML in the surau name and label', () => {
    const xml = buildProfile({ boxId: 'b1', surauName: 'A&B <"x"> \'y\'', label: '<L>&', url: 'https://h:1/app/?a=1&b=2', rootDer: ROOT_DER, icon: null });
    expect(xml).toContain('<string>MAXCOM A&amp;B &lt;&quot;x&quot;&gt; &apos;y&apos;</string>');
    expect(xml).toContain('<string>&lt;L&gt;&amp;</string>');
    expect(xml).toContain('https://h:1/app/?a=1&amp;b=2');
    expect(xml).not.toMatch(/<string>[^<]*[&](?!amp;|lt;|gt;|quot;|apos;)/);
    expect(xmlEscape('a\u0001b')).toBe('ab');
  });

  it('identifiers and UUIDs are deterministic per box', () => {
    const a = buildProfile({ boxId: 'b1', surauName: 'S', label: 'S', url: 'https://h/app/', rootDer: ROOT_DER, icon: null });
    const b = buildProfile({ boxId: 'b1', surauName: 'S', label: 'S', url: 'https://h/app/', rootDer: ROOT_DER, icon: null });
    const c = buildProfile({ boxId: 'b2', surauName: 'S', label: 'S', url: 'https://h/app/', rootDer: ROOT_DER, icon: null });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(profileUuid('b1', 'profile')).toBe(profileUuid('b1', 'profile'));
    expect(profileUuid('b1', 'profile')).not.toBe(profileUuid('b1', 'root'));
    expect(profileUuid('b1', 'root')).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  });

  it('the same box produces the same UUIDs on two downloads', async () => {
    const one = (await get('/app/ios.mobileconfig', '10.168.1.20')).body;
    const two = (await get('/app/ios.mobileconfig', '10.168.1.20')).body;
    expect(one).toBe(two);
  });
});

describe('GET /app/ios help page', () => {
  it('lists both downloads and the four steps, with no external assets', async () => {
    const r = await get('/app/ios');
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('href="/app/ios.mobileconfig"');
    expect(r.body).toContain('href="/app/ios.mobileconfig?via=cloud"');
    expect((r.body.match(/<li>/g) ?? []).length).toBe(4);
    expect(r.body).toContain('Tetapan Kepercayaan Sijil');
    expect(r.body).toContain('hanya untuk kotak surau anda sendiri');
    expect(r.body).toContain('Install a MAXCOM profile only for your own surau box');
    expect(r.body).toContain('VPN &amp; Pengurusan Peranti');
    expect(r.body).not.toMatch(/(src|href)="https?:/);
  });
});

describe('GET /app/ios.mobileconfig with a numbered name', () => {
  it('points the web clip at the name even when asked by IP, and keeps the IP on a legacy root', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'surau-ios2-'));
    const appDir = join(d2, 'webapp');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
    const named = buildApp(join(d2, 'n.db'), {
      dataDir: join(d2, 'data'), appDir, boxId: 'box123abc', httpsPort: 8443,
      allowedHosts: ['10.168.1.20', 'box1-surau.local'],
      tls: { ipSan: ['10.168.1.20'], dnsSan: ['localhost', 'box1-surau.local'] } as never,
    });
    await named.ready();
    const r = await named.inject({ method: 'GET', url: '/app/ios.mobileconfig', remoteAddress: '10.168.1.5', headers: { host: '10.168.1.20:8443' } });
    expect(r.body).toContain('<string>https://box1-surau.local:8443/app/</string>');
    await named.close();
    rmSync(d2, { recursive: true, force: true });
    // the shared legacy app above is unchanged: asked by IP it still answers with the IP
    const legacy = await get('/app/ios.mobileconfig', '10.168.1.20:8443');
    expect(legacy.body).toContain('<string>https://10.168.1.20:8443/app/</string>');
  });
});

describe('the root certificate name iOS lists', () => {
  const REAL = readFileSync(new URL('./fixtures/test-box-leaf.cer', import.meta.url));
  const cn = (): string => /^CN=(.+)$/m.exec(new X509Certificate(REAL).subject)![1]!.trim();

  it('rootCommonName reads the CN; null for non-certificates', () => {
    expect(rootCommonName(REAL)).toBe(cn());
    expect(rootCommonName(ROOT_DER)).toBeNull();
    expect(rootCommonName(null)).toBeNull();
  });

  it('the root payload is displayed by that CN, the help page step 3 names it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'surau-ios-cn-'));
    try {
      const appDir = join(d, 'webapp');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title>');
      mkdirSync(join(d, 'data', 'pki'), { recursive: true });
      writeFileSync(join(d, 'data', 'pki', 'root-ca.cer'), REAL);
      const a = buildApp(join(d, 't.db'), { dataDir: join(d, 'data'), appDir, boxId: 'box123abc', httpsPort: 8443, allowedHosts: ['10.168.1.20'], tls: { ipSan: ['10.168.1.20'], dnsSan: [] } as never });
      await a.ready();
      putFeature(a.surau.db, 'surauInfo', { name: 'Surau Al-Hidayah Taman Indah' }, 'test', undefined, 'sdm');
      const xml = (await a.inject({ method: 'GET', url: '/app/ios.mobileconfig', remoteAddress: '10.168.1.5', headers: { host: '10.168.1.20:8443' } })).body;
      expect(xml).toContain(`<key>PayloadDisplayName</key>
			<string>${cn()}</string>`);
      expect(xml).not.toContain('Taman Indah CA');
      const help = (await a.inject({ method: 'GET', url: '/app/ios', remoteAddress: '10.168.1.5' })).body;
      expect(help).toContain(`<b>${cn()}</b>`);
      await a.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('a root that cannot be parsed keeps the surau-based name', () => {
    const xml = buildProfile({ boxId: 'b1', surauName: 'S', label: 'S', url: 'https://h/app/', rootDer: ROOT_DER, icon: null, rootName: rootCommonName(ROOT_DER) });
    expect(xml).toContain('<string>MAXCOM S CA</string>');
  });
});
