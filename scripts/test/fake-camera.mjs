#!/usr/bin/env node
// Fake IP camera for the laptop integration tests (plan 2026-11-16-live-external-source rev 4, section 8).
//
// Its own MediaMTX on a test port with a view-only login (viewer / test-view-1, a test value only), and ffmpeg publishers of: H.264 + AAC,
// H.264 + G.711, H.264 without audio, and (opt in) H.265 + AAC. The picture flashes white and the sound beeps at the same
// moments (every 2 s, plus a second pulse 0.5 s later every 10 s so a pair cannot alias beyond +-1 s). Between the beeps
// the sound is the speech-like signal of fake-mic.mjs (the microphone plays the same signal, so the box can align them).
// Publisher flags follow the T0 sync-repeat research: `-rtsp_transport tcp`, `-muxdelay 0 -muxpreload 0 -flush_packets 1`
// (a bursty publisher alone moves timestamps by 0.3 to 1 s).
//
// CLI: node fake-camera.mjs --mediamtx <exe> --ffmpeg <exe> [--port 18654] [--variants h264aac,h264g711,noaudio,h265]
//        [--seconds 600] [--size 1280x720] [--stop-after <ms>]   (stop-after: stops every publisher mid-run)
// Prints the URLs and the signal epoch. Everything it started is stopped on exit.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PULSE_EXPR, makeSpeechWav } from './fake-mic.mjs';

export const VIEW_USER = 'viewer';
export const VIEW_PASS = 'test-view-1';
export const VARIANTS = {
  h264aac: 'cam-h264aac',
  h264g711: 'cam-h264g711',
  noaudio: 'cam-noaudio',
  h265: 'cam-h265',
};

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** The MediaMTX config of the fake camera: loopback only, RTSP with a view-only login, publishers from localhost. */
export function cameraConfig(port) {
  return [
    'logLevel: info',
    'api: yes',
    `apiAddress: 127.0.0.1:${port + 1}`,
    'rtmp: no', 'hls: no', 'webrtc: no', 'srt: no', 'metrics: no', 'pprof: no', 'playback: no', 'moq: no',
    `rtspAddress: 127.0.0.1:${port}`,
    `rtpAddress: 127.0.0.1:${port + 2}`,
    `rtcpAddress: 127.0.0.1:${port + 3}`,
    'rtspTransports: [tcp, udp]',
    'authInternalUsers:',
    '  - user: any',
    "    ips: ['127.0.0.1', '::1']",
    '    permissions:',
    '      - action: publish',
    '      - action: api',
    `  - user: ${VIEW_USER}`,
    `    pass: ${VIEW_PASS}`,
    '    permissions:',
    '      - action: read',
    'paths:',
    '  all_others:',
    '',
  ].join('\n');
}

/** Arguments of one publisher (without the program). Pure. */
export function publisherArgs(variant, o) {
  const size = o.size ?? '1280x720';
  const flash = `drawbox=enable='${PULSE_EXPR}':color=white:t=fill`;
  const video = `testsrc2=s=${size}:r=25,${flash}`;
  const url = `rtsp://127.0.0.1:${o.port}/${VARIANTS[variant]}`;
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '2M', '-maxrate', '2M', '-bufsize', '2M', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p'];
  const x265 = ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '1M', '-x265-params', 'keyint=50:min-keyint=50:scenecut=0', '-pix_fmt', 'yuv420p'];
  const out = ['-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-f', 'rtsp', '-rtsp_transport', 'tcp', url];
  const head = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-re', '-f', 'lavfi', '-i', video];
  const wav = ['-re', '-i', o.wav];
  if (variant === 'noaudio') return [...head, ...x264, '-an', ...out];
  if (variant === 'h264g711') return [...head, ...wav, ...x264, '-c:a', 'pcm_alaw', '-ar', '8000', '-ac', '1', ...out];
  if (variant === 'h265') return [...head, ...wav, ...x265, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', ...out];
  return [...head, ...wav, ...x264, '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', ...out];
}

/**
 * Starts the fake camera. Options: mediamtx, ffmpeg (paths), port (default 18654), variants (default h264aac, h264g711,
 * noaudio), seconds (length of the speech signal, default 600), wav (an existing speech wav, else one is made in `dir`),
 * dir, size, stopAfterMs (every publisher is stopped that long after the start: a camera that dies mid-run).
 */
export async function startFakeCamera(o) {
  const port = o.port ?? 18654;
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'fake-camera-'));
  mkdirSync(dir, { recursive: true });
  const wav = o.wav ?? join(dir, 'speech.wav');
  if (o.wav === undefined) makeSpeechWav(wav, o.seconds ?? 600);
  const cfg = join(dir, 'camera-mediamtx.yml');
  writeFileSync(cfg, cameraConfig(port));
  const procs = [];
  const logs = {};
  const sp = (name, exe, args) => {
    const c = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    logs[name] = '';
    c.stderr.on('data', (d) => { logs[name] = (logs[name] + d.toString()).slice(-6000); });
    procs.push({ name, c });
    return c;
  };
  sp('mediamtx', o.mediamtx, [cfg]);
  // wait for the RTSP port
  const net = await import('node:net');
  const end = Date.now() + 10_000;
  for (;;) {
    const ok = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); r(true); });
      s.once('error', () => r(false));
    });
    if (ok) break;
    if (Date.now() > end) { killAll(); throw new Error('fake camera: MediaMTX did not start'); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const variants = o.variants ?? ['h264aac', 'h264g711', 'noaudio'];
  const epochMs = Date.now();
  for (const v of variants) sp(v, o.ffmpeg, publisherArgs(v, { port, wav, size: o.size }));

  function killAll() {
    for (const p of procs.splice(0)) killTree(p.c.pid);
  }
  let stopTimer = null;
  if (o.stopAfterMs !== undefined) {
    stopTimer = setTimeout(() => {
      for (const p of procs.filter((x) => x.name !== 'mediamtx')) killTree(p.c.pid);
    }, o.stopAfterMs);
  }
  const urlOf = (v, user = VIEW_USER, pass = VIEW_PASS) => `rtsp://${user}:${pass}@127.0.0.1:${port}/${VARIANTS[v]}`;
  return {
    port,
    dir,
    wav,
    /** Wall-clock ms at which the publishers started: the speech signal is at second (now - epochMs) / 1000 (give or take the start-up). */
    epochMs,
    logs,
    url: urlOf,
    /** The same stream with a wrong password (the camera answers 401). */
    wrongPasswordUrl: (v) => urlOf(v, VIEW_USER, 'wrong-pass-1'),
    /** A camera that dies mid-run: its publishers stop, MediaMTX stays. */
    stopPublishers() {
      for (const p of procs.filter((x) => x.name !== 'mediamtx')) killTree(p.c.pid);
    },
    async stop() {
      if (stopTimer !== null) clearTimeout(stopTimer);
      killAll();
      await new Promise((r) => setTimeout(r, 200));
    },
  };
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
  const mediamtx = a.mediamtx ?? process.env.LIVE_IT_MEDIAMTX;
  const ffmpeg = a.ffmpeg ?? process.env.LIVE_IT_FFMPEG;
  if (!mediamtx || !ffmpeg || !existsSync(mediamtx) || !existsSync(ffmpeg)) {
    console.error('usage: fake-camera.mjs --mediamtx <exe> --ffmpeg <exe> [--port 18654] [--variants h264aac,h264g711,noaudio,h265] [--stop-after ms]');
    process.exit(2);
  }
  const variants = (a.variants ?? 'h264aac,h264g711,noaudio').split(',').filter((v) => v in VARIANTS);
  const cam = await startFakeCamera({
    mediamtx, ffmpeg, variants,
    port: Number(a.port ?? 18654),
    seconds: Number(a.seconds ?? 600),
    size: a.size,
    stopAfterMs: a['stop-after'] !== undefined ? Number(a['stop-after']) : undefined,
  });
  console.log(`fake camera up, signal epoch ${cam.epochMs}`);
  for (const v of variants) console.log(`${v}: ${cam.url(v)}   (wrong password: ${cam.wrongPasswordUrl(v)})`);
  const end = async () => { await cam.stop(); process.exit(0); };
  process.on('SIGINT', end);
  process.on('SIGTERM', end);
  setInterval(() => {}, 1 << 30);
}
