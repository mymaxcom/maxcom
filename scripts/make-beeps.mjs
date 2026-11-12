// Generates the kiosk beep sounds as own work: pure sine tones with a soft
// attack and release, 44.1 kHz, 16-bit, mono. Gentle, not harsh.
//
//   node scripts/make-beeps.mjs
//
// Writes apps/kiosk-display/src/assets/sounds/beep-short.wav and beep-long.wav.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../apps/kiosk-display/src/assets/sounds');

const SAMPLE_RATE = 44_100;

/**
 * Render one or more sine notes into a Float32 buffer.
 * @param {{ freq: number; seconds: number; gain?: number; attack?: number; release?: number; gapAfter?: number }[]} notes
 */
function render(notes) {
  const total = notes.reduce((n, x) => n + Math.round((x.seconds + (x.gapAfter ?? 0)) * SAMPLE_RATE), 0);
  const out = new Float32Array(total);
  let pos = 0;
  for (const note of notes) {
    const len = Math.round(note.seconds * SAMPLE_RATE);
    const attack = Math.round((note.attack ?? 0.012) * SAMPLE_RATE);
    const release = Math.round((note.release ?? 0.08) * SAMPLE_RATE);
    const gain = note.gain ?? 0.55;
    for (let i = 0; i < len; i++) {
      let env = 1;
      if (i < attack) env = i / attack;
      else if (i > len - release) env = Math.max(0, (len - i) / release);
      // Raised-cosine envelope edges feel softer than linear ramps.
      env = 0.5 - 0.5 * Math.cos(Math.PI * env);
      const t = i / SAMPLE_RATE;
      // Fundamental plus a quiet second harmonic for a little warmth.
      const s = Math.sin(2 * Math.PI * note.freq * t) + 0.18 * Math.sin(2 * Math.PI * note.freq * 2 * t);
      out[pos + i] = s * env * gain;
    }
    pos += len + Math.round((note.gapAfter ?? 0) * SAMPLE_RATE);
  }
  return out;
}

/** @param {Float32Array} samples */
function toWav(samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

mkdirSync(outDir, { recursive: true });

// Short: a single soft chime (A5), 0.35 s. Used for azan countdown start and
// the iqamah end warning.
const short = render([{ freq: 880, seconds: 0.35, release: 0.14 }]);
// Long: two gentle notes (E5 then A5), about 1.3 s. Used for masuk waktu.
const long = render([
  { freq: 659.25, seconds: 0.45, release: 0.12, gapAfter: 0.06 },
  { freq: 880, seconds: 0.75, release: 0.3 },
]);

writeFileSync(resolve(outDir, 'beep-short.wav'), toWav(short));
writeFileSync(resolve(outDir, 'beep-long.wav'), toWav(long));
console.log(`wrote ${outDir}/beep-short.wav (${short.length} samples) and beep-long.wav (${long.length} samples)`);
