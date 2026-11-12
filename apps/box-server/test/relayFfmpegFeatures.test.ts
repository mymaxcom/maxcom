import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Relay } from '../src/live/relay.ts';
import type { RelayOptions, RelayStartOptions } from '../src/live/relay.ts';

// The slim Android ffmpeg is built from scripts/android/ffmpeg-features.json. This test proves the
// relay's real ffmpeg command lines only use what that list switches on, and that the build script
// stays LGPL-only, dynamic against bionic, and reproducible from the pins.

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIR = join(REPO, 'scripts', 'android');

interface Features {
  protocols: string[];
  demuxers: string[];
  muxers: string[];
  encoders: string[];
  decoders: string[];
  parsers: string[];
  bsfs: string[];
  filters: string[];
  externalLibs: string[];
}

const features = JSON.parse(readFileSync(join(DIR, 'ffmpeg-features.json'), 'utf8')) as Features;

// Relay.args is private and has no exported builder; the test reads it through a cast so relay.ts stays untouched.
function relayArgs(kind: 'youtube' | 'kioskAudio', start: Partial<RelayStartOptions>): string[] {
  const dataDir = mkdtempSync(join(tmpdir(), 'ffeat-'));
  try {
    const o: RelayOptions = { ffmpegPath: 'ffmpeg', api: {} as RelayOptions['api'], dataDir, sessionId: 'abc123', kind };
    const relay = new Relay(o) as unknown as { args(s: RelayStartOptions): string[] };
    return relay.args({ key: 'abcd-efgh-ijkl-mnop-qrst', relayVideo: 'copy', maxBitrateKbps: 4500, ...start } as RelayStartOptions);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function valuesOf(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag && i + 1 < args.length) out.push(args[i + 1]);
  });
  return out;
}

/** URLs and pipe targets in the argument list, with the role each plays. */
function endpoints(args: string[]): { scheme: string; role: 'input' | 'output' | 'progress' }[] {
  const list: { scheme: string; role: 'input' | 'output' | 'progress' }[] = [];
  const iIndex = args.indexOf('-i');
  args.forEach((a, i) => {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(a);
    if (!m || i === 0) return;
    const prev = args[i - 1];
    if (prev === '-progress') list.push({ scheme: m[1].toLowerCase(), role: 'progress' });
    else if (prev === '-i') list.push({ scheme: m[1].toLowerCase(), role: 'input' });
    else if (i > iIndex && /^[a-z]+:\/\//i.test(a)) list.push({ scheme: m[1].toLowerCase(), role: 'output' });
  });
  return list;
}

const scenarios: { name: string; args: string[] }[] = [
  { name: 'YouTube leg, copy mode', args: relayArgs('youtube', { relayVideo: 'copy' }) },
  { name: 'kiosk audio leg', args: relayArgs('kioskAudio', {}) },
];

describe('relay arguments stay inside the slim ffmpeg feature list', () => {
  for (const sc of scenarios) {
    describe(sc.name, () => {
      it('uses only listed encoders (or copy)', () => {
        const codecs = [...valuesOf(sc.args, '-c:v'), ...valuesOf(sc.args, '-c:a')];
        expect(codecs.length).toBeGreaterThan(0);
        for (const c of codecs) {
          if (c === 'copy') continue;
          expect(features.encoders, `encoder ${c}`).toContain(c);
        }
        expect(codecs).not.toContain('libx264');
      });

      it('uses only listed muxers', () => {
        const formats = valuesOf(sc.args, '-f');
        expect(formats.length).toBeGreaterThan(0);
        for (const f of formats) expect(features.muxers, `muxer ${f}`).toContain(f);
      });

      it('maps every URL scheme to a listed protocol and demuxer or muxer', () => {
        const eps = endpoints(sc.args);
        expect(eps.length).toBeGreaterThan(1);
        for (const ep of eps) {
          if (ep.scheme === 'rtsp') {
            // rtsp is a demuxer/muxer pair riding on tcp (-rtsp_transport tcp); it needs the rtp and sdp parts too
            expect(valuesOf(sc.args, '-rtsp_transport')).toContain('tcp');
            expect(features.protocols).toContain('tcp');
            if (ep.role === 'input') for (const d of ['rtsp', 'rtp', 'sdp']) expect(features.demuxers).toContain(d);
            else for (const m of ['rtsp', 'rtp']) expect(features.muxers).toContain(m);
          } else {
            expect(features.protocols, `protocol ${ep.scheme}`).toContain(ep.scheme);
            if (ep.scheme === 'rtmps') for (const p of ['tls', 'tcp']) expect(features.protocols).toContain(p);
          }
        }
      });

      it('has the decoders, parsers and bitstream filters its streams need', () => {
        // the rtsp input carries h264 video and aac audio; audio is decoded whenever it is re-encoded
        for (const d of ['h264', 'aac']) expect(features.decoders).toContain(d);
        for (const p of ['h264', 'aac']) expect(features.parsers).toContain(p);
        if (valuesOf(sc.args, '-f').includes('flv')) {
          expect(features.bsfs).toContain('aac_adtstoasc');
          expect(features.bsfs).toContain('h264_mp4toannexb');
        }
        if (valuesOf(sc.args, '-c:a').includes('libopus')) {
          expect(features.decoders).toContain('opus');
          expect(features.parsers).toContain('opus');
        }
      });

      it('uses only listed filters', () => {
        const af = valuesOf(sc.args, '-af');
        for (const chain of af) {
          for (const part of chain.split(',')) {
            const name = part.split('=')[0];
            expect(features.filters, `filter ${name}`).toContain(name);
          }
        }
        // the sample-rate and channel options force format conversion through these
        expect(features.filters).toContain('aresample');
        expect(features.filters).toContain('aformat');
        expect(features.filters).toContain('anull');
      });
    });
  }

  it('the kiosk audio leg really uses aresample, the Opus encoder and the rtsp muxer', () => {
    const args = scenarios[1].args;
    expect(valuesOf(args, '-af')[0]).toMatch(/^aresample=/);
    expect(valuesOf(args, '-c:a')).toContain('libopus');
    expect(valuesOf(args, '-f')).toContain('rtsp');
  });

  it('the YouTube leg in copy mode copies video and encodes AAC into flv over rtmps', () => {
    const args = scenarios[0].args;
    expect(valuesOf(args, '-c:v')).toEqual(['copy']);
    expect(valuesOf(args, '-c:a')).toEqual(['aac']);
    expect(valuesOf(args, '-f')).toEqual(['flv']);
    expect(endpoints(args).some((e) => e.scheme === 'rtmps' && e.role === 'output')).toBe(true);
    expect(endpoints(args).some((e) => e.scheme === 'pipe' && e.role === 'progress')).toBe(true);
  });

  it('re-encode mode is the only path that wants libx264, and the Android list leaves it out', () => {
    const re = relayArgs('youtube', { relayVideo: 'reencode' });
    expect(valuesOf(re, '-c:v')).toEqual(['libx264']);
    expect(features.encoders).not.toContain('libx264');
    expect(features.externalLibs).not.toContain('libx264');
  });
});

describe('feature list file', () => {
  it('has every list as a non-empty array of plain names', () => {
    for (const [key, list] of Object.entries(features)) {
      expect(Array.isArray(list), key).toBe(true);
      expect((list as string[]).length, key).toBeGreaterThan(0);
      for (const n of list as string[]) expect(n, `${key}:${n}`).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('allows only LGPL-compatible external libraries', () => {
    expect([...features.externalLibs].sort()).toEqual(['libopus', 'mbedtls']);
  });
});

describe('build script (static checks)', () => {
  const sh = readFileSync(join(DIR, 'build-ffmpeg-android.sh'), 'utf8');
  // the executable lines only: comments may name the forbidden flags while explaining the guard
  const code = sh
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('uses LF line ends only', () => {
    expect(sh.includes('\r')).toBe(false);
    expect(sh.startsWith('#!/usr/bin/env bash\n')).toBe(true);
  });

  it('never enables gpl or nonfree, and refuses them if they appear', () => {
    // the only mentions of the flags are inside the case guard that dies on them
    const lines = code.split('\n');
    const flagLines = lines.map((l, i) => ({ l, i })).filter((x) => /--enable-(gpl|nonfree)/.test(x.l));
    expect(flagLines.length).toBe(1);
    expect(flagLines[0].l).toContain('--enable-nonfree');
    expect(flagLines[0].l.trimStart().startsWith('*"')).toBe(true); // a case pattern
    expect(lines[flagLines[0].i + 1]).toContain('die');
    expect(lines[flagLines[0].i - 1]).toContain('case');
  });

  it('starts from --disable-everything and takes the lists from the JSON', () => {
    expect(code).toContain('--disable-everything');
    for (const flag of ['--disable-autodetect', '--disable-doc', '--disable-ffplay', '--disable-ffprobe', '--disable-avdevice', '--disable-swscale', '--enable-version3', '--enable-swresample']) {
      expect(code).toContain(flag);
    }
    for (const kind of ['protocol', 'demuxer', 'muxer', 'encoder', 'decoder', 'parser', 'bsf', 'filter']) expect(code).toContain(`"${kind}"`);
    expect(code).toContain('externalLibs');
    expect(code).toContain('FEATURES');
  });

  it('has no static final link and needs only bionic libraries', () => {
    expect(code).not.toMatch(/(^|\s)-static(\s|$)/);
    expect(code).not.toMatch(/--extra-ldflags="[^"]*-static/);
    expect(code).toMatch(/libc\.so\|libm\.so\|libdl\.so/);
    expect(code).toContain('llvm-readelf');
  });

  it('builds libopus and mbedTLS static, with a host twin self-check of every list', () => {
    expect(code).toContain('--disable-shared --enable-static');
    expect(code).toContain('-DUSE_STATIC_MBEDTLS_LIBRARY=ON');
    for (const flag of ['-protocols', '-demuxers', '-muxers', '-encoders', '-decoders', '-bsfs', '-filters', '-L']) expect(code).toContain(`"${flag}"`);
    expect(code).toContain('config_components.h');
    expect(code).toContain('LGPL version 3 or later');
  });

  it('checks the source hashes before it builds', () => {
    expect(code).toContain('sha256sum');
    for (const v of ['FFMPEG_SHA256', 'OPUS_SHA256', 'MBEDTLS_SHA256']) expect(code).toContain(v);
  });
});

describe('pins', () => {
  const pins = JSON.parse(readFileSync(join(DIR, 'android-pins.json'), 'utf8')) as Record<string, Record<string, string | number>>;

  it('pins the three sources by version and sha256, and the image by digest', () => {
    for (const k of ['ffmpegSrc', 'opusSrc', 'mbedtlsSrc']) {
      expect(String(pins[k].version), k).toMatch(/^\d+\.\d+(\.\d+)?$/);
      expect(String(pins[k].sha256), k).toMatch(/^[0-9a-f]{64}$/);
      expect(String(pins[k].url), k).toMatch(/^https:\/\//);
      expect(String(pins[k].url), k).toContain(String(pins[k].version));
    }
    expect(String(pins.ndkImage.base)).toMatch(/^ubuntu:[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(String(pins.ndkImage.ndkSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(pins.ndkImage.ndkUrl)).toMatch(/^https:\/\/dl\.google\.com\//);
    expect(Number(pins.ndkImage.apiLevel)).toBe(28);
  });
});

describe('build-ffmpeg-android.ps1 -DryRun', () => {
  it.skipIf(process.platform !== 'win32')('prints the Docker commands as argument lists and starts nothing', () => {
    const cache = mkdtempSync(join(tmpdir(), 'ffcache-'));
    const out = mkdtempSync(join(tmpdir(), 'ffout-'));
    try {
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(DIR, 'build-ffmpeg-android.ps1'), '-Abi', 'armeabi-v7a', '-CacheDir', cache, '-OutDir', out, '-DryRun'],
        { encoding: 'utf8', timeout: 60_000 },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('DRY RUN');
      expect(r.stdout).toMatch(/\[\d+\] --network\r?\n\s+\[\d+\] none/);
      expect(r.stdout).toContain('ABI=armeabi-v7a');
      expect(r.stdout).toMatch(/FROM ubuntu:24\.04@sha256:[0-9a-f]{64}/);
      expect(r.stdout).toContain('/scripts/build-ffmpeg-android.sh');
      // nothing downloaded, nothing written
      expect(readdirSync(cache)).toEqual([]);
      expect(readdirSync(out)).toEqual([]);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('is ASCII with no em dash', () => {
    const ps = readFileSync(join(DIR, 'build-ffmpeg-android.ps1'));
    for (const b of ps) expect(b).toBeLessThan(128);
  });
});
