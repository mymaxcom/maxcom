import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveLog, NULL_LIVE_LOG } from '../src/live/liveLog.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'livelog-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FIXED = new Date('2026-11-25T10:00:00.000Z');
const mk = (dir: string, extra: Partial<ConstructorParameters<typeof LiveLog>[0]> = {}): LiveLog => new LiveLog({ dir, now: () => FIXED, ...extra });
const read = (dir: string, name = 'live.log'): string => readFileSync(join(dir, name), 'utf8');

describe('live log', () => {
  it('writes an event line and a process line in the documented formats', () => {
    const dir = tmp();
    const log = mk(dir);
    log.event('session_start', { id: 'abc', combined: true, delayMs: 120, reason: null });
    log.line('combiner', 'speed=1.0x\nsecond line');
    expect(read(dir).split('\n')).toEqual([
      '2026-11-25T10:00:00.000Z event session_start id=abc combined=true delayMs=120 reason=null',
      '2026-11-25T10:00:00.000Z [combiner] speed=1.0x second line',
      '',
    ]);
  });

  it('creates a missing folder', () => {
    const dir = join(tmp(), 'deep', 'live');
    const log = mk(dir);
    log.event('x');
    expect(existsSync(join(dir, 'live.log'))).toBe(true);
    // the folder is made again when it disappears between writes
    rmSync(dir, { recursive: true, force: true });
    log.event('y');
    expect(read(dir)).toContain('event y');
  });

  it('uses a private file mode where the OS supports it', () => {
    if (process.platform === 'win32') return;
    const dir = tmp();
    mk(dir).event('x');
    expect(statSync(join(dir, 'live.log')).mode & 0o777).toBe(0o600);
  });

  it('rotates at the size limit and keeps one old copy', () => {
    const dir = tmp();
    const log = mk(dir, { maxBytes: 300 });
    for (let i = 0; i < 40; i++) log.line('t', `line number ${String(i).padStart(3, '0')}`);
    expect(existsSync(join(dir, 'live.log.1'))).toBe(true);
    expect(existsSync(join(dir, 'live.log.2'))).toBe(false);
    expect(statSync(join(dir, 'live.log')).size).toBeLessThanOrEqual(300);
    expect(read(dir)).toContain('line number 039');
    expect(read(dir, 'live.log.1')).toMatch(/line number 0\d\d/);
  });

  it('masks each kind of secret as ***', () => {
    const dir = tmp();
    const log = mk(dir);
    log.setSecrets(['s3cr3t-pass', 'passphrase value']);
    log.line('relay', 'password s3cr3t-pass and passphrase value seen');
    log.line('ffmpeg', 'Opening rtsp://mixer:hunter2@127.0.0.1:8554/surau for reading');
    log.line('ffmpeg', 'Opening rtmps://a.rtmps.youtube.com:443/live2/abcd-efgh-ijkl-mnop for writing');
    log.line('ffmpeg', 'connect to 192.0.2.44 port 554 failed');
    log.event('camera', { host: '192.0.2.45' });
    const text = read(dir);
    expect(text).toContain('password *** and *** seen');
    expect(text).toContain('rtsp://***@***:8554/surau');
    expect(text).toContain('rtmps://a.rtmps.youtube.com:443/live2/***');
    expect(text).toContain('connect to *** port 554');
    expect(text).toContain('host=***');
    for (const bad of ['s3cr3t-pass', 'passphrase value', 'hunter2', 'abcd-efgh', '192.0.2', '127.0.0.1']) expect(text).not.toContain(bad);
  });

  it('setSecrets replaces the earlier list', () => {
    const dir = tmp();
    const log = mk(dir);
    log.setSecrets(['first-secret']);
    log.setSecrets(['second-secret']);
    log.line('t', 'first-secret second-secret');
    expect(read(dir)).toContain('first-secret ***');
  });

  it('a write failure never throws and the line is counted as dropped', () => {
    const dir = tmp();
    const log = mk(dir, {
      writeFn: () => {
        throw new Error('ENOSPC');
      },
    });
    expect(() => log.event('x', { a: 1 })).not.toThrow();
    expect(() => log.line('t', 'text')).not.toThrow();
    expect(log.droppedLines()).toBe(2);
  });

  it('a folder that cannot be made never throws', () => {
    const dir = tmp();
    // a regular file stands where the folder should be
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'x');
    const log = new LiveLog({ dir: blocked, now: () => FIXED });
    expect(() => log.event('x')).not.toThrow();
    expect(log.droppedLines()).toBe(1);
    mkdirSync(join(dir, 'other'));
  });

  it('B8: every control character becomes a space, one entry is capped at 1000 characters', () => {
    const dir = tmp();
    const log = mk(dir);
    log.line('t', 'a\u0000b\u001bc\u007fd\u2028e\u2029f\tg\r\nh');
    log.line('t', 'x'.repeat(5000));
    const lines = read(dir).split('\n');
    expect(lines[0]).toBe('2026-11-25T10:00:00.000Z [t] a b c d e f g h');
    expect(lines[1]!.length).toBeLessThanOrEqual('2026-11-25T10:00:00.000Z '.length + 1000);
    expect(lines[1]).toContain('xxxx');
    expect(lines).toHaveLength(3);
  });

  it('B8: IPv6 addresses and the camera host name are masked, clock times and ffmpeg progress are not', () => {
    const dir = tmp();
    const log = mk(dir);
    log.setSecrets(['cam-hall.example.test']);
    log.line('ffmpeg', 'connect to fe80::1ff:fe23:4567:890a failed, also [2001:db8::7]:554 and ::1 and 2001:db8:0:0:0:0:0:9');
    log.line('ffmpeg', 'host cam-hall.example.test refused');
    log.line('ffmpeg', 'frame=10 time=00:01:02.50 bitrate=12.3kbits/s std::string a::b');
    const text = read(dir);
    for (const bad of ['fe80', '2001:db8', '::1 ', 'cam-hall']) expect(text).not.toContain(bad);
    expect(text).toContain('connect to *** failed, also [***]:554 and *** and ***');
    expect(text).toContain('host *** refused');
    expect(text).toContain('time=00:01:02.50');
    expect(text).toContain('std::string');
  });

  it('B8: an existing log file is tightened to 0600 and the folder is made private', () => {
    const dir = join(tmp(), 'live');
    mkdirSync(dir);
    writeFileSync(join(dir, 'live.log'), 'old\n');
    const seen: string[] = [];
    mk(dir, { chmodFn: (p) => seen.push(p) });
    expect(seen).toEqual([join(dir, 'live.log')]);
    const fresh: string[] = [];
    mk(join(tmp(), 'none'), { chmodFn: (p) => fresh.push(p) });
    expect(fresh).toEqual([]); // no file, nothing to tighten
    if (process.platform === 'win32') return;
    writeFileSync(join(dir, 'live.log'), 'old\n', { mode: 0o644 });
    mk(dir);
    expect(statSync(join(dir, 'live.log')).mode & 0o777).toBe(0o600);
    const nested = join(tmp(), 'a', 'b');
    mk(nested);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it('B10: a size that cannot be read at the start is read again on the next write, and a large old file rotates', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'live.log'), 'y'.repeat(500));
    let fail = 2;
    const log = mk(dir, {
      maxBytes: 600,
      sizeFn: (p) => {
        if (fail-- > 0) throw new Error('EIO');
        return statSync(p).size;
      },
    });
    // the constructor's read failed (fail 2 -> 1); this write's check fails too (1 -> 0) and appends without a size
    log.line('t', 'first line of the day, long enough to pass the limit if the size were known 123456789');
    expect(existsSync(join(dir, 'live.log.1'))).toBe(false);
    // the next write reads the size (now ~600 or more) and rotates
    log.line('t', 'second line');
    expect(existsSync(join(dir, 'live.log.1'))).toBe(true);
    expect(read(dir)).toContain('second line');
    expect(statSync(join(dir, 'live.log')).size).toBeLessThanOrEqual(600);
  });

  it('the null log accepts every call and does nothing', () => {
    expect(() => {
      NULL_LIVE_LOG.event('x', { a: 1 });
      NULL_LIVE_LOG.line('t', 'text');
      NULL_LIVE_LOG.setSecrets(['a']);
    }).not.toThrow();
  });
});
