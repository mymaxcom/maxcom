import { describe, expect, it } from 'vitest';
import { probeLowEncoder } from '../src/live/lowEncoder.ts';
import type { Runner } from '../src/live/audioInputs.ts';

const OK = { ok: true, output: 'frame=   25 fps=0.0 q=-0.0 Lsize=N/A time=00:00:01.00 bitrate=N/A\nvideo:20kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: unknown\n' };
const NO = { ok: true, output: 'Unknown encoder "h264_qsv"\n' };

interface Call {
  enc: string;
  args: readonly string[];
  ms: number;
}

function recorder(works: (enc: string) => { ok: boolean; output: string }): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (_ff, args, ms) => {
    const enc = args[args.indexOf('-c:v') + 1]!;
    calls.push({ enc, args, ms });
    return works(enc);
  };
  return { run, calls };
}

describe('probeLowEncoder', () => {
  it('tries qsv, mf (Windows), then libx264 and stops at the first that works', async () => {
    const a = recorder((e) => (e === 'libx264' ? OK : NO));
    expect(await probeLowEncoder('ffmpeg', a.run, 'win32')).toBe('libx264');
    expect(a.calls.map((c) => c.enc)).toEqual(['h264_qsv', 'h264_mf', 'libx264']);
    const b = recorder((e) => (e === 'h264_mf' ? OK : NO));
    expect(await probeLowEncoder('ffmpeg', b.run, 'win32')).toBe('h264_mf');
    expect(b.calls.map((c) => c.enc)).toEqual(['h264_qsv', 'h264_mf']);
    const c = recorder(() => OK);
    expect(await probeLowEncoder('ffmpeg', c.run, 'win32')).toBe('h264_qsv');
    expect(c.calls).toHaveLength(1);
  });

  it('skips h264_mf off Windows', async () => {
    const a = recorder((e) => (e === 'libx264' ? OK : NO));
    expect(await probeLowEncoder('ffmpeg', a.run, 'linux')).toBe('libx264');
    expect(a.calls.map((c) => c.enc)).toEqual(['h264_qsv', 'libx264']);
  });

  it('B5: each probe runs the real low arguments on a 1280x720 test picture, with an 8 s limit', async () => {
    const a = recorder(() => NO);
    await probeLowEncoder('ffmpeg', a.run, 'win32');
    expect(a.calls[0]!.ms).toBe(8000);
    const head = ['-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '1', '-vf', 'scale=-2:480'];
    const rate = ['-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k', '-g', '50'];
    const tail = ['-f', 'null', '-'];
    expect(a.calls.map((c) => c.args)).toEqual([
      [...head, '-c:v', 'h264_qsv', ...rate, '-pix_fmt', 'nv12', ...tail],
      [...head, '-c:v', 'h264_mf', ...rate, '-pix_fmt', 'yuv420p', ...tail],
      [...head, '-c:v', 'libx264', ...rate, '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-tune', 'zerolatency', ...tail],
    ]);
  });

  it('null when none works, a timeout, or a thrown runner (the Android box)', async () => {
    expect(await probeLowEncoder('ffmpeg', recorder(() => NO).run, 'linux')).toBeNull();
    expect(await probeLowEncoder('ffmpeg', recorder(() => ({ ok: false, output: OK.output })).run, 'win32')).toBeNull();
    const boom: Runner = async () => {
      throw new Error('x');
    };
    expect(await probeLowEncoder('ffmpeg', boom, 'linux')).toBeNull();
  });
});
