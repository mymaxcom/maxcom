import { describe, expect, it } from 'vitest';
import {
  CAMERA_PASSWORD_MASK,
  cameraUrlError,
  isMaskedCameraUrl,
  maskCameraUrl,
} from '../src/live/cameraUrl.ts';

describe('cameraUrlError: good addresses', () => {
  it.each([
    'rtsp://10.168.1.20',
    'rtsp://10.168.1.20/',
    'rtsp://10.168.1.20:554/stream1',
    'rtsp://10.0.0.5:8554/live/main?profile=1&tcp=1',
    'rtsp://172.16.4.9/h264',
    'rtsp://172.31.255.254/h264',
    'rtsp://viewer:secret@10.168.1.20:554/stream1',
    'rtsp://viewer@10.168.1.20/stream1',
    'rtsp://viewer:p%40ss%3Aword@10.168.1.20/stream1',
    'rtsp://admin:@10.168.1.20/stream1',
    'rtsp://10.168.1.20/Streaming/Channels/101',
    'rtsp://10.168.1.20/cam/realmonitor?channel=1&subtype=0',
  ])('accepts %s', (u) => {
    expect(cameraUrlError(u)).toBeNull();
  });
});

describe('cameraUrlError: scheme and shape', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['http://10.168.1.20/stream', 'http'],
    ['rtsps://10.168.1.20/stream', 'rtsps'],
    ['RTSP://10.168.1.20/stream', 'upper case scheme is not the one we store'],
    ['10.168.1.20/stream', 'no scheme'],
    ['rtsp:/10.168.1.20', 'one slash'],
    ['rtsp://', 'no host'],
    ['rtsp:///stream', 'empty host'],
    ['rtsp://10.168.1.20:/stream', 'empty port'],
    ['rtsp://10.168.1.20/stream#frag', 'fragment'],
  ])('rejects %j (%s)', (u) => {
    expect(cameraUrlError(u)).not.toBeNull();
  });
  it('rejects a non-string', () => {
    expect(cameraUrlError(undefined as unknown as string)).not.toBeNull();
    expect(cameraUrlError(5 as unknown as string)).not.toBeNull();
  });
  it('rejects a very long address', () => {
    expect(cameraUrlError(`rtsp://10.168.1.20/${'a'.repeat(400)}`)).not.toBeNull();
  });
});

describe('cameraUrlError: private-address rule', () => {
  it.each([
    ['rtsp://8.8.8.8/stream', 'public'],
    ['rtsp://203.0.113.9/stream', 'public documentation range'],
    ['rtsp://127.0.0.1/stream', 'loopback'],
    ['rtsp://127.1.2.3/stream', 'loopback range'],
    ['rtsp://0.0.0.0/stream', 'unspecified'],
    ['rtsp://169.254.10.10/stream', 'link-local'],
    ['rtsp://224.0.0.1/stream', 'multicast'],
    ['rtsp://239.255.255.250/stream', 'multicast'],
    ['rtsp://255.255.255.255/stream', 'broadcast'],
    ['rtsp://172.15.0.1/stream', 'just below 172.16/12'],
    ['rtsp://172.32.0.1/stream', 'just above 172.16/12'],
    ['rtsp://192.169.1.1/stream', 'just above 192.168/16'],
    ['rtsp://100.64.0.1/stream', 'carrier grade NAT'],
    ['rtsp://camera.example.my/stream', 'a name'],
    ['rtsp://localhost/stream', 'localhost'],
    ['rtsp://[::1]/stream', 'IPv6 loopback'],
    ['rtsp://[fd00::5]/stream', 'IPv6 private'],
    ['rtsp://10.168.1/stream', 'three octets'],
    ['rtsp://10.168.1.256/stream', 'octet over 255'],
    ['rtsp://10.168.01.20/stream', 'leading zero (octal ambiguity)'],
    ['rtsp://0xc0.168.1.20/stream', 'hex octet'],
    ['rtsp://3232235796/stream', 'single decimal number'],
    ['rtsp://10.168.1.20.evil.example/stream', 'name that starts like an address'],
  ])('rejects %s (%s)', (u) => {
    expect(cameraUrlError(u)).not.toBeNull();
  });
  it('refuses the box itself', () => {
    expect(cameraUrlError('rtsp://10.168.1.2:554/stream', ['10.168.1.2'])).not.toBeNull();
    expect(cameraUrlError('rtsp://10.168.1.20:554/stream', ['10.168.1.2'])).toBeNull();
    expect(cameraUrlError('rtsp://10.168.1.2/stream', ['10.0.0.1', '10.168.1.2'])).not.toBeNull();
  });
});

describe('cameraUrlError: port, login and path', () => {
  it.each(['0', '65536', '99999', '-1', '5x4', '１２３'])('rejects port %s', (p) => {
    expect(cameraUrlError(`rtsp://10.168.1.20:${p}/stream`)).not.toBeNull();
  });
  it.each(['1', '554', '8554', '65535'])('accepts port %s', (p) => {
    expect(cameraUrlError(`rtsp://10.168.1.20:${p}/stream`)).toBeNull();
  });
  it('rejects a second @ in the login (it must be percent-encoded)', () => {
    expect(cameraUrlError('rtsp://user:pa@ss@10.168.1.20/stream')).not.toBeNull();
    expect(cameraUrlError('rtsp://evil@10.168.1.20@8.8.8.8/stream')).not.toBeNull();
  });
  it('rejects a bad percent escape', () => {
    expect(cameraUrlError('rtsp://u:p%zz@10.168.1.20/stream')).not.toBeNull();
    expect(cameraUrlError('rtsp://10.168.1.20/a%2')).not.toBeNull();
  });
  it('rejects spaces, quotes, control characters and shell or markup characters', () => {
    for (const bad of [' ', '"', "'", '`', '<', '>', '\\', '\n', '\r', '\t', '\u0000', '\u007f', '|', ';x`', '{', '}', '^']) {
      expect(cameraUrlError(`rtsp://10.168.1.20/a${bad}b`), JSON.stringify(bad)).not.toBeNull();
      expect(cameraUrlError(`rtsp://u${bad}:p@10.168.1.20/ab`), `login ${JSON.stringify(bad)}`).not.toBeNull();
    }
  });
  it('rejects a non-ASCII path', () => {
    expect(cameraUrlError('rtsp://10.168.1.20/kameraé')).not.toBeNull();
  });
});

describe('maskCameraUrl', () => {
  it('replaces the password with dots and never shows it', () => {
    const m = maskCameraUrl('rtsp://viewer:Tr0ub4dor@10.168.1.20:554/stream1');
    expect(m).toBe(`rtsp://viewer:${CAMERA_PASSWORD_MASK}@10.168.1.20:554/stream1`);
    expect(m).not.toContain('Tr0ub4dor');
  });
  it('leaves an address without a login unchanged', () => {
    expect(maskCameraUrl('rtsp://10.168.1.20/stream')).toBe('rtsp://10.168.1.20/stream');
  });
  it('leaves a user-only login unchanged', () => {
    expect(maskCameraUrl('rtsp://viewer@10.168.1.20/stream')).toBe('rtsp://viewer@10.168.1.20/stream');
  });
  it('masks an empty-user and a percent-encoded password', () => {
    expect(maskCameraUrl('rtsp://:p%40ss@10.168.1.20/s')).not.toContain('p%40ss');
    expect(maskCameraUrl('rtsp://u:p%40ss%3Aw@10.168.1.20/s')).toBe(`rtsp://u:${CAMERA_PASSWORD_MASK}@10.168.1.20/s`);
  });
  it('masks a password that holds colons, and one with a raw @ (such an address is refused on save, but is never echoed)', () => {
    for (const pw of ['a:b:c', 'p@ss']) {
      const m = maskCameraUrl(`rtsp://u:${pw}@10.168.1.20/s`);
      expect(m, pw).not.toContain(pw);
      expect(m.startsWith('rtsp://u:'), pw).toBe(true);
    }
  });
  it('does not mistake an @ in the path or query for a login', () => {
    const u = 'rtsp://10.168.1.20/stream?user=a@b.my';
    expect(maskCameraUrl(u)).toBe(u);
  });
  it('never throws and never leaks on junk input', () => {
    for (const junk of ['', 'not a url', 'rtsp://', 'rtsp://u:secretpass@', '://:x@y', 'u:secretpass@host']) {
      const m = maskCameraUrl(junk);
      expect(typeof m).toBe('string');
      expect(m).not.toContain('secretpass');
    }
  });
  it('is idempotent', () => {
    const once = maskCameraUrl('rtsp://u:secret@10.168.1.20/s');
    expect(maskCameraUrl(once)).toBe(once);
  });
});

describe('isMaskedCameraUrl', () => {
  it('is true only for an address that still holds the dots in the password place', () => {
    expect(isMaskedCameraUrl(`rtsp://u:${CAMERA_PASSWORD_MASK}@10.168.1.20/s`)).toBe(true);
    expect(isMaskedCameraUrl('rtsp://u:secret@10.168.1.20/s')).toBe(false);
    expect(isMaskedCameraUrl('rtsp://10.168.1.20/s')).toBe(false);
    expect(isMaskedCameraUrl(`rtsp://10.168.1.20/s?x=${CAMERA_PASSWORD_MASK}`)).toBe(false);
  });
  it('accepts a masked address as a valid address', () => {
    expect(cameraUrlError(`rtsp://u:${CAMERA_PASSWORD_MASK}@10.168.1.20/s`)).toBeNull();
  });
});
