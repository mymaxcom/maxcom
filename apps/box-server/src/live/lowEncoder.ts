import { spawnRunner } from './audioInputs.ts';
import type { Runner } from './audioInputs.ts';
import type { LowEncoder } from './relay.ts';

/* B6: which H.264 encoder the low quality step of the YouTube leg can use on this box. Each candidate encodes one
   second of a test picture to nowhere; the first that completes wins. The Android box ffmpeg has none: null, and the
   ladder stays off. */

const PROBE_MS = 8000;

/** The candidates in order of preference; the Media Foundation one exists on Windows only. */
export function lowEncoderCandidates(platform: string = process.platform): LowEncoder[] {
  return platform === 'win32' ? ['h264_qsv', 'h264_mf', 'libx264'] : ['h264_qsv', 'libx264'];
}

/** The probe encodes with the relay's own low arguments (relay.ts) from a 720p picture, so a pass means the real step works. */
export function probeArgs(enc: LowEncoder): string[] {
  return [
    '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '1',
    '-vf', 'scale=-2:480', '-c:v', enc, '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k', '-g', '50',
    '-pix_fmt', enc === 'h264_qsv' ? 'nv12' : 'yuv420p',
    ...(enc === 'libx264' ? ['-preset', 'veryfast', '-tune', 'zerolatency'] : []),
    '-f', 'null', '-',
  ];
}

/**
 * The first encoder whose probe encodes the test picture to the end, else null. The runner does not report the exit
 * code (ffmpeg writes to stderr and some probes exit 1 by design), so success is the run completing in time with
 * ffmpeg's closing `video:` size summary, which it prints only after a clean encode.
 */
export async function probeLowEncoder(ffmpegPath: string, run: Runner = spawnRunner, platform: string = process.platform): Promise<LowEncoder | null> {
  for (const enc of lowEncoderCandidates(platform)) {
    try {
      const r = await run(ffmpegPath, probeArgs(enc), PROBE_MS);
      if (r.ok && /(^|\s)video:\d+/.test(r.output) && !/Conversion failed|Error while opening encoder|Unknown encoder/i.test(r.output)) return enc;
    } catch {
      /* a probe that throws is a failed probe */
    }
  }
  return null;
}
