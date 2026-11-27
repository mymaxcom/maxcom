import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without a declaration file
import { VARIANTS, VIEW_PASS, VIEW_USER, cameraConfig, publisherArgs } from '../../../scripts/test/fake-camera.mjs';
// @ts-expect-error plain .mjs script without a declaration file
import { BEEP_HZ, MIC_RATE, PULSE_EXPR, PULSE_SEC, makeMicSamples, makeSpeechSamples, makeSpeechWav, micPublisherArgs, pulseAt } from '../../../scripts/test/fake-mic.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** RMS of a stretch of samples, 0..1. */
function rms(x: Int16Array, fromSec: number, toSec: number, rate: number): number {
  let sum = 0;
  const a = Math.round(fromSec * rate);
  const b = Math.round(toSec * rate);
  for (let i = a; i < b; i++) sum += (x[i]! / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, b - a));
}

/** Zero crossings per second of a stretch: about twice the frequency of a clean tone. */
function crossings(x: Int16Array, fromSec: number, toSec: number, rate: number): number {
  let n = 0;
  const a = Math.round(fromSec * rate);
  const b = Math.round(toSec * rate);
  for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 !== x[i]! < 0) n++;
  return n / (toSec - fromSec);
}

describe('fake-mic: the pulse and the speech-like signal', () => {
  it('pulses every 2 s, and once more 0.5 s later every 10 s', () => {
    expect(pulseAt(0)).toBe(true);
    expect(pulseAt(PULSE_SEC / 2)).toBe(true);
    expect(pulseAt(PULSE_SEC + 0.01)).toBe(false);
    expect(pulseAt(1)).toBe(false);
    expect(pulseAt(2.01)).toBe(true);
    expect(pulseAt(4.01)).toBe(true);
    // the second pulse of the pair, only in the first two seconds of every ten
    expect(pulseAt(0.5 + PULSE_SEC / 2)).toBe(true);
    expect(pulseAt(10.5 + PULSE_SEC / 2)).toBe(true);
    expect(pulseAt(2.5 + PULSE_SEC / 2)).toBe(false);
    expect(pulseAt(6.5 + PULSE_SEC / 2)).toBe(false);
  });

  it('the ffmpeg expression says the same thing as pulseAt, and fits inside a quoted filter option', () => {
    expect(PULSE_EXPR).toBe(`lt(mod(t,2),${PULSE_SEC})+between(mod(t,10),0.5,${0.5 + PULSE_SEC})`);
    expect(PULSE_EXPR).not.toMatch(/['\s:]/);
  });

  it('is deterministic: the same seconds give the same samples', () => {
    const a = makeSpeechSamples(4);
    const b = makeSpeechSamples(4);
    expect(a.length).toBe(4 * MIC_RATE);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });

  it('beeps at the pulses and speaks between them', () => {
    const x = makeSpeechSamples(12);
    // a pulse: a clean loud tone at the beep frequency
    expect(rms(x, 2.005, 2 + PULSE_SEC - 0.005, MIC_RATE)).toBeGreaterThan(0.4);
    const hz = crossings(x, 2.005, 2 + PULSE_SEC - 0.005, MIC_RATE) / 2;
    expect(Math.abs(hz - BEEP_HZ)).toBeLessThan(BEEP_HZ * 0.1);
    expect(rms(x, 10.505, 10.5 + PULSE_SEC - 0.005, MIC_RATE)).toBeGreaterThan(0.4);
    // between the pulses there is sound, but it is not the tone
    expect(rms(x, 0.2, 1.9, MIC_RATE)).toBeGreaterThan(0.01);
    expect(rms(x, 0.2, 1.9, MIC_RATE)).toBeLessThan(0.4);
    for (const s of x) expect(Math.abs(s)).toBeLessThanOrEqual(32767);
  });

  it('writes a mono 16-bit WAV of the asked length that carries those samples', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-mic-test-'));
    dirs.push(dir);
    const file = join(dir, 'speech.wav');
    expect(makeSpeechWav(file, 3)).toBe(file);
    const buf = readFileSync(file);
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(MIC_RATE);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.readUInt32LE(40)).toBe(3 * MIC_RATE * 2);
    expect(buf.length).toBe(44 + 3 * MIC_RATE * 2);
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
    const want = makeSpeechSamples(3);
    expect(buf.subarray(44).equals(Buffer.from(want.buffer, want.byteOffset, want.byteLength))).toBe(true);
  });

  it('the microphone plays the same signal later by the chosen lag', () => {
    const lagMs = 250;
    const cam = makeSpeechSamples(6);
    const mic = makeMicSamples(6, { lagMs });
    const shift = (lagMs / 1000) * MIC_RATE;
    expect(mic.length).toBe(cam.length);
    // silence before the signal arrives, then the camera's samples, late
    for (let i = 0; i < shift; i += 997) expect(mic[i]).toBe(0);
    for (let i = shift; i < mic.length; i += 997) expect(mic[i]).toBe(cam[i - shift]);
  });

  it('noise changes the samples but keeps the pulse where it was; a drifting microphone slides away', () => {
    const clean = makeMicSamples(6, { lagMs: 0 });
    const noisy = makeMicSamples(6, { lagMs: 0, noiseSnrDb: 20 });
    expect(Buffer.from(noisy.buffer).equals(Buffer.from(clean.buffer))).toBe(false);
    expect(rms(noisy, 2.005, 2 + PULSE_SEC - 0.005, MIC_RATE)).toBeGreaterThan(0.4);
    const drift = makeMicSamples(6, { lagMs: 0, ppm: 5000 });
    expect(drift.length).toBe(clean.length);
    expect(Buffer.from(drift.buffer).equals(Buffer.from(clean.buffer))).toBe(false);
  });

  it('refuses a lag, a length or a drift that makes no sense', () => {
    expect(() => makeMicSamples(6, { lagMs: -1 })).toThrow();
    expect(() => makeMicSamples(0, {})).toThrow();
    expect(() => makeSpeechSamples(-2)).toThrow();
    expect(() => makeMicSamples(6, { ppm: 200000 })).toThrow();
  });

  it('publishes the microphone as Opus over RTSP to the given address, in real time', () => {
    const args: string[] = micPublisherArgs({ wav: 'mic.wav', url: 'rtsp://127.0.0.1:18554/surau-mic' });
    expect(args.slice(-1)).toEqual(['rtsp://127.0.0.1:18554/surau-mic']);
    expect(args).toContain('-re');
    expect(args[args.indexOf('-i') + 1]).toBe('mic.wav');
    expect(args[args.indexOf('-c:a') + 1]).toBe('libopus');
    expect(args).toContain('-vn');
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('tcp');
  });
});

describe('fake-camera: runnable now that fake-mic exists', () => {
  it('uses a neutral test login, view only, on loopback', () => {
    expect(VIEW_USER).toBe('viewer');
    expect(VIEW_PASS).toBe('test-view-1');
    const cfg: string = cameraConfig(18654);
    expect(cfg).toContain('rtspAddress: 127.0.0.1:18654');
    expect(cfg).toContain(`  - user: ${VIEW_USER}\n    pass: ${VIEW_PASS}\n    permissions:\n      - action: read\n`);
    // no address outside the loopback, no real camera or surau name
    expect(cfg).not.toMatch(/10\.168\.|10\.\d+\.\d+\.\d+|0\.0\.0\.0/);
  });

  it('every variant publishes to its own path with the flashing picture', () => {
    for (const v of Object.keys(VARIANTS)) {
      const args: string[] = publisherArgs(v, { port: 18654, wav: 'speech.wav' });
      expect(args.at(-1)).toBe(`rtsp://127.0.0.1:18654/${VARIANTS[v]}`);
      expect(args.join(' ')).toContain(`drawbox=enable='${PULSE_EXPR}':color=white:t=fill`);
    }
    expect(publisherArgs('noaudio', { port: 1, wav: 'x' })).toContain('-an');
    expect(publisherArgs('h264g711', { port: 1, wav: 'x' })).toContain('pcm_alaw');
    expect(publisherArgs('h265', { port: 1, wav: 'x' })).toContain('libx265');
    expect(publisherArgs('h264aac', { port: 1, wav: 'x' })).toContain('aac');
  });
});
