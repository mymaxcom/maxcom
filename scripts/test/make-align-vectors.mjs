// Shared test vectors for the audio alignment modules (box: apps/box-server/src/live/align.ts,
// phone: AudioAligner.kt, which copies these files). Deterministic (fixed seed), no recorded or copyrighted audio:
// the "speech" is synthesised (voiced syllables through formant resonators, fricatives, pauses).
//
//   node scripts/test/make-align-vectors.mjs        writes apps/box-server/test/fixtures/align/*.s16 + manifest.json
//
// File format: raw signed 16-bit little-endian mono, 16 kHz. Lag convention (same as align.ts): src[n] = ref[n + lag],
// so a positive lag means the added source is EARLY and must be delayed by that much more.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RATE = 16000;
export const CLIP_SEC = 9;
export const SEED = 20261117;

/** Small deterministic PRNG (mulberry32), returns floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speech-like signal in [-1, 1]: syllables of 80 to 250 ms separated by 40 to 500 ms pauses. */
export function makeMaster(seconds, seed = SEED, rate = RATE) {
  const rand = rng(seed);
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  let i = 0;
  let f0 = 120;
  while (i < n) {
    const pause = Math.round((0.04 + rand() * 0.46) * rate);
    i += pause;
    const len = Math.round((0.08 + rand() * 0.17) * rate);
    const end = Math.min(n, i + len);
    const voiced = rand() < 0.8;
    const f0End = 100 + rand() * 90;
    const formants = [300 + rand() * 500, 900 + rand() * 1300, 2300 + rand() * 600];
    const bw = [90, 120, 160];
    const gain = 0.4 + rand() * 0.6;
    const coef = formants.map((f, k) => {
      const r = Math.exp((-Math.PI * bw[k]) / rate);
      return { a1: 2 * r * Math.cos((2 * Math.PI * f) / rate), a2: -r * r, y1: 0, y2: 0, g: 1 - r };
    });
    let phase = 0;
    let hp = 0;
    for (let s = i; s < end; s++) {
      const u = (s - i) / Math.max(1, end - i);
      const env = Math.sin(Math.PI * u) ** 1.5;
      const f = f0 + (f0End - f0) * u;
      let x;
      if (voiced) {
        phase += f / rate;
        if (phase >= 1) phase -= 1;
        x = phase < 0.08 ? 1 - phase / 0.08 : -0.12; // short glottal pulse
        let y = 0;
        for (const c of coef) {
          const v = c.g * x + c.a1 * c.y1 + c.a2 * c.y2;
          c.y2 = c.y1;
          c.y1 = v;
          y += v;
        }
        out[s] = y * env * gain * 6;
      } else {
        const w = rand() * 2 - 1;
        hp = w - hp * 0.6; // crude high-pass emphasis for a fricative
        out[s] = hp * env * gain * 0.35;
      }
    }
    f0 = f0End;
    i = end;
  }
  let peak = 1e-9;
  for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(out[k]));
  for (let k = 0; k < n; k++) out[k] = (out[k] / peak) * 0.7;
  return out;
}

/** ref = master[0, clip); src[n] = master[lag + n]: the source is `lagMs` EARLY against the reference. */
export function sliceClip(master, startMs, clipSec, rate = RATE) {
  const start = Math.round((startMs / 1000) * rate);
  const n = Math.round(clipSec * rate);
  return master.slice(start, start + n);
}

/** Gaussian-ish noise (sum of 4 uniforms) at `snrDb` below the signal RMS. */
export function addNoise(x, snrDb, seed = 77) {
  const rand = rng(seed);
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  const rms = Math.sqrt(e / x.length);
  const sigma = (rms * Math.pow(10, -snrDb / 20)) / 0.577; // stdev of the sum of 4 uniforms in [-.5,.5] is 0.577
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const g = rand() + rand() + rand() + rand() - 2;
    out[i] = x[i] + g * sigma;
  }
  return out;
}

/** Short room reverb: direct sound plus decaying reflections (delays in ms), then a gentle low-pass (a muffled mic). */
export function addRoom(x, rate = RATE) {
  const taps = [
    [23, 0.5],
    [47, 0.38],
    [91, 0.27],
    [140, 0.18],
    [210, 0.1],
  ];
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let v = x[i];
    for (const [ms, g] of taps) {
      const j = i - Math.round((ms / 1000) * rate);
      if (j >= 0) v += g * x[j];
    }
    out[i] = v;
  }
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    y += 0.55 * (out[i] - y); // one-pole low-pass, about 2 kHz at 16 kHz
    out[i] = y;
  }
  return out;
}

export function invert(x) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = -x[i];
  return out;
}

/** src[n] = master[startMs + n * (1 + ppm * 1e-6)]: the added clock runs fast against the reference (lag grows with n). */
export function driftClip(master, startMs, clipSec, ppm, rate = RATE) {
  const start = (startMs / 1000) * rate;
  const n = Math.round(clipSec * rate);
  const k = 1 + ppm * 1e-6;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = start + i * k;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = (master[j] ?? 0) * (1 - f) + (master[j + 1] ?? 0) * f;
  }
  return out;
}

export function toS16(x) {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  return out;
}

export const VECTORS = [
  { name: 'lag-37', lagMs: 37 },
  { name: 'lag-480', lagMs: 480 },
  { name: 'lag-1250', lagMs: 1250 },
  { name: 'lag-2900', lagMs: 2900 },
  { name: 'noise-480', lagMs: 480, noiseSnrDb: 6 },
  { name: 'echo-1250', lagMs: 1250, room: true },
  { name: 'invert-480', lagMs: 480, invert: true },
  { name: 'drift-480', lagMs: 480, ppm: 50 },
];

export function buildVectors() {
  const master = makeMaster(CLIP_SEC + 3.2);
  const files = { ref: toS16(sliceClip(master, 0, CLIP_SEC)) };
  const manifest = { rate: RATE, clipSec: CLIP_SEC, seed: SEED, lagConvention: 'src[n] = ref[n + lag]; lag > 0: source early', vectors: [] };
  for (const v of VECTORS) {
    let x = v.ppm ? driftClip(master, v.lagMs, CLIP_SEC, v.ppm) : sliceClip(master, v.lagMs, CLIP_SEC);
    if (v.room) x = addRoom(x);
    if (v.noiseSnrDb) x = addNoise(x, v.noiseSnrDb);
    if (v.invert) x = invert(x);
    files[v.name] = toS16(x);
    manifest.vectors.push({ file: `${v.name}.s16`, expectedLagMs: v.lagMs, ...(v.ppm ? { ppm: v.ppm } : {}), ...(v.room ? { room: true } : {}), ...(v.noiseSnrDb ? { noiseSnrDb: v.noiseSnrDb } : {}), ...(v.invert ? { inverted: true } : {}) });
  }
  files.silence = new Int16Array(CLIP_SEC * RATE);
  manifest.vectors.push({ file: 'silence.s16', expectedLagMs: null });
  return { files, manifest };
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = join(here, '..', '..', 'apps', 'box-server', 'test', 'fixtures', 'align');
  mkdirSync(dir, { recursive: true });
  const { files, manifest } = buildVectors();
  for (const [name, arr] of Object.entries(files)) writeFileSync(join(dir, `${name}.s16`), Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${Object.keys(files).length} vectors to ${dir}`);
}
