#!/usr/bin/env node
// Fake microphone for the laptop integration tests (plan 2026-11-16-live-external-source rev 4, section 8), and the
// sound of the fake camera (fake-camera.mjs imports PULSE_EXPR and makeSpeechWav from here).
//
// The signal is synthetic and deterministic (no recorded or copyrighted audio): the speech-like master of
// make-align-vectors.mjs (voiced syllables, fricatives, pauses), with a 1 kHz beep at the pulse moments: every 2 s,
// plus a second pulse 0.5 s later every 10 s so a pair cannot alias beyond +-1 s. The fake camera flashes its picture
// white at the same moments (PULSE_EXPR), so picture-to-sound and source-to-source offsets can both be measured.
//
// The microphone plays the SAME signal as the camera, later by a chosen lag, optionally with noise and at a slightly
// different speed (a clock that drifts), so the box can be asked to align the two.
//
// CLI: node fake-mic.mjs --out <mic.wav> [--seconds 600] [--lag <ms>] [--noise <snr dB>] [--ppm <drift>]
//        [--ffmpeg <exe> --url rtsp://127.0.0.1:<port>/<path>]   (with both: publishes the file as Opus until stopped)

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEED, addNoise, makeMaster, toS16 } from './make-align-vectors.mjs';

/** Sample rate of the test signal (what the camera's AAC and the microphone's Opus both carry). */
export const MIC_RATE = 48000;
/** Length of one pulse in seconds: two frames at 25 fps. */
export const PULSE_SEC = 0.08;
/** The beep of a pulse. */
export const BEEP_HZ = 1000;
const BEEP_GAIN = 0.8;
const SPEECH_GAIN = 0.35;
const MAX_SECONDS = 3600;
const MAX_LAG_MS = 10_000;
const MAX_PPM = 100_000;

/**
 * True during a pulse, as an ffmpeg expression of `t` (seconds): every 2 s, plus 0.5 s later in every 10 s. It has no
 * quote, space or colon, so it can sit inside a quoted filter option (`drawbox=enable='<expr>'`).
 */
export const PULSE_EXPR = `lt(mod(t,2),${PULSE_SEC})+between(mod(t,10),0.5,${0.5 + PULSE_SEC})`;

/** The second pulse of the pair starts here, in every 10 s. */
const PAIR_AT = 0.5;

/** Seconds since the start of the pulse that covers `tSec`, or -1 outside every pulse. Same rule as PULSE_EXPR. */
function pulsePhase(tSec) {
  const a = tSec % 2;
  if (a < PULSE_SEC) return a;
  const b = tSec % 10;
  if (b >= PAIR_AT && b <= PAIR_AT + PULSE_SEC) return b - PAIR_AT;
  return -1;
}

/** The JS twin of PULSE_EXPR: is there a pulse at `tSec`? */
export function pulseAt(tSec) {
  return pulsePhase(tSec) >= 0;
}

function checkSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) throw new RangeError(`seconds must be above 0 and at most ${MAX_SECONDS}`);
}

/** The signal as floats in [-1, 1]: speech between the pulses, the beep during them. Deterministic; a longer run starts with the shorter one. */
function speechFloat(seconds, rate = MIC_RATE) {
  checkSeconds(seconds);
  const master = makeMaster(seconds, SEED, rate);
  const out = new Float32Array(master.length);
  for (let i = 0; i < out.length; i++) {
    const p = pulsePhase(i / rate);
    out[i] = p >= 0 ? BEEP_GAIN * Math.sin(2 * Math.PI * BEEP_HZ * p) : Math.max(-1, Math.min(1, master[i] * SPEECH_GAIN));
  }
  return out;
}

/** The camera's sound: `seconds` of the signal as signed 16-bit mono samples at MIC_RATE. */
export function makeSpeechSamples(seconds, rate = MIC_RATE) {
  return toS16(speechFloat(seconds, rate));
}

/**
 * The microphone's sound: the same signal, late by `lagMs` (silence until it arrives), with noise `noiseSnrDb` below
 * the signal when given, and played `ppm` parts per million fast when given (a clock that drifts against the camera).
 */
export function makeMicSamples(seconds, o = {}, rate = MIC_RATE) {
  checkSeconds(seconds);
  const lagMs = o.lagMs ?? 0;
  const ppm = o.ppm ?? 0;
  if (!Number.isFinite(lagMs) || lagMs < 0 || lagMs > MAX_LAG_MS) throw new RangeError(`lagMs must be 0 to ${MAX_LAG_MS}`);
  if (!Number.isFinite(ppm) || Math.abs(ppm) > MAX_PPM) throw new RangeError(`ppm must be within +-${MAX_PPM}`);
  const n = Math.round(seconds * rate);
  const shift = Math.round((lagMs / 1000) * rate);
  const k = 1 + ppm * 1e-6;
  // enough of the signal for a fast clock to read past the end
  const base = speechFloat(Math.min(MAX_SECONDS, seconds * Math.max(1, k) + 1), rate);
  let x = new Float32Array(n);
  for (let i = shift; i < n; i++) {
    const p = (i - shift) * k;
    const j = Math.floor(p);
    const f = p - j;
    x[i] = f === 0 ? (base[j] ?? 0) : (base[j] ?? 0) * (1 - f) + (base[j + 1] ?? 0) * f;
  }
  if (o.noiseSnrDb !== undefined) x = addNoise(x, o.noiseSnrDb);
  return toS16(x);
}

/** A mono 16-bit PCM WAV file of the samples. */
function writeWav(path, samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16); // fmt chunk size
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); // bytes per second
  head.writeUInt16LE(2, 32); // block align
  head.writeUInt16LE(16, 34); // bits per sample
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
  return path;
}

/** Writes `seconds` of the camera's sound to `path` (mono, 16-bit, MIC_RATE). Returns the path. */
export function makeSpeechWav(path, seconds, rate = MIC_RATE) {
  return writeWav(path, makeSpeechSamples(seconds, rate), rate);
}

/** Writes the microphone's sound (see makeMicSamples) to `path`. Returns the path. */
export function makeMicWav(path, seconds, o = {}, rate = MIC_RATE) {
  return writeWav(path, makeMicSamples(seconds, o, rate), rate);
}

/** Arguments of an ffmpeg that plays a microphone file to an RTSP address as Opus, in real time (without the program). Pure. */
export function micPublisherArgs(o) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-re', '-i', o.wav,
    '-vn', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1',
    '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', o.url,
  ];
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) o[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.out || (a.url !== undefined) !== (a.ffmpeg !== undefined)) {
    console.error('usage: fake-mic.mjs --out <mic.wav> [--seconds 600] [--lag ms] [--noise snrDb] [--ppm drift] [--ffmpeg <exe> --url rtsp://127.0.0.1:<port>/<path>]');
    process.exit(2);
  }
  const seconds = Number(a.seconds ?? 600);
  const opts = {
    lagMs: Number(a.lag ?? 0),
    ...(a.noise !== undefined ? { noiseSnrDb: Number(a.noise) } : {}),
    ppm: Number(a.ppm ?? 0),
  };
  makeMicWav(a.out, seconds, opts);
  console.log(`fake mic: wrote ${a.out} (${seconds} s, lag ${opts.lagMs} ms, drift ${opts.ppm} ppm${a.noise !== undefined ? `, noise ${a.noise} dB below` : ''})`);
  if (a.url !== undefined) {
    const child = spawn(a.ffmpeg, micPublisherArgs({ wav: a.out, url: a.url }), { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    console.log(`fake mic: publishing to ${a.url}, signal epoch ${Date.now()}`);
    const end = () => {
      if (child.pid) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      }
      process.exit(0);
    };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
    child.on('exit', (code) => process.exit(code ?? 0));
  }
}
