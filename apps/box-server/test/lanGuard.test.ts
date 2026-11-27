import { describe, expect, it } from 'vitest';
import { isLanDirect, isPrivateAddress } from '../src/net/lan.ts';
import type { FastifyRequest } from 'fastify';

describe('isPrivateAddress', () => {
  const yes: [string, string][] = [
    ['10.0.0.0', '10/8 low edge'],
    ['10.255.255.255', '10/8 high edge'],
    ['10.20.30.40', '10/8 middle'],
    ['172.16.0.0', '172.16/12 low edge'],
    ['172.16.0.1', '172.16/12'],
    ['172.31.255.255', '172.16/12 high edge'],
    ['172.20.1.1', '172.16/12 middle'],
    ['10.168.0.0', '192.168/16 low'],
    ['10.168.50.12', '192.168/16'],
    ['10.168.255.255', '192.168/16 high'],
    ['169.254.0.1', 'link-local low'],
    ['169.254.255.254', 'link-local high'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback range'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:10.168.50.12', 'mapped private'],
    ['::ffff:10.1.2.3', 'mapped 10/8'],
    ['::ffff:127.0.0.1', 'mapped loopback'],
    ['::FFFF:10.168.1.5', 'mapped, upper case'],
    ['  10.168.1.5 ', 'surrounding spaces'],
    ['fc00::1', 'unique local fc00'],
    ['fd12:3456:789a::1', 'unique local fd'],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unique local top'],
    ['fe80::1', 'link-local v6'],
    ['fe80::1%eth0', 'link-local with a zone'],
    ['fe80::abcd:1%12', 'link-local with a numeric zone'],
    ['febf::1', 'link-local fe80::/10 top'],
    ['FE80::1', 'link-local upper case'],
  ];
  it.each(yes)('%s is private (%s)', (addr) => {
    expect(isPrivateAddress(addr)).toBe(true);
  });

  const no: [string, string][] = [
    ['8.8.8.8', 'public v4'],
    ['1.1.1.1', 'public v4'],
    ['203.0.113.9', 'documentation range is not private'],
    ['9.255.255.255', 'just below 10/8'],
    ['11.0.0.0', 'just above 10/8'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['172.32.0.0', 'just above 172.16/12'],
    ['192.167.255.255', 'just below 192.168/16'],
    ['192.169.0.0', 'just above 192.168/16'],
    ['169.253.255.255', 'just below link-local'],
    ['169.255.0.0', 'just above link-local'],
    ['126.255.255.255', 'just below loopback'],
    ['128.0.0.0', 'just above loopback'],
    ['100.64.0.0', 'CGNAT low edge'],
    ['100.64.1.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT high edge'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['::', 'unspecified v6'],
    ['2001:4860:4860::8888', 'public v6'],
    ['2606:4700:4700::1111', 'public v6'],
    ['fbff::1', 'just below fc00::/7'],
    ['fe00::1', 'just above fd and below fe80'],
    ['fec0::1', 'site-local, deprecated, not link-local'],
    ['ff02::1', 'multicast v6'],
    ['::ffff:8.8.8.8', 'mapped public'],
    ['::ffff:100.64.0.1', 'mapped CGNAT'],
    ['::ffff:c0a8:0101', 'mapped in hex form (10.168.1.1) is not recognised: refused, the safe side'],
    ['64:ff9b::10.168.1.1', 'NAT64 form is not a private address'],
    ['2001:db8::1', 'documentation v6'],
  ];
  it.each(no)('%s is not private (%s)', (addr) => {
    expect(isPrivateAddress(addr)).toBe(false);
  });

  const junk = ['', ' ', 'localhost', 'example.com', '10.168.1', '10.168.1.1.1', '10.168.1.256', '256.1.1.1', '10.0.0.0/8', '1e1.0.0.1', '010.0.0.1x', '::gggg', '::ffff:', '::ffff:999.1.1.1', 'http://10.168.1.1', '10.168.1.1:8443', '[::1]', '-1.0.0.1', '10.0.0.1\n8.8.8.8'];
  it.each(junk.map((j) => [j]))('junk %j is not private', (addr) => {
    expect(isPrivateAddress(addr as string)).toBe(false);
  });
});

function req(remoteAddress: string | undefined, headers: Record<string, string> = {}): FastifyRequest {
  return { raw: { socket: { remoteAddress } }, headers } as unknown as FastifyRequest;
}

describe('isLanDirect', () => {
  it('true for a private socket address with no proxy header', () => {
    expect(isLanDirect(req('10.168.50.12'))).toBe(true);
    expect(isLanDirect(req('::ffff:10.0.0.9'))).toBe(true);
    expect(isLanDirect(req('127.0.0.1'))).toBe(true);
    expect(isLanDirect(req('fe80::1%wlan0'))).toBe(true);
  });

  it('false for a public or missing socket address', () => {
    expect(isLanDirect(req('8.8.8.8'))).toBe(false);
    expect(isLanDirect(req('100.64.3.3'))).toBe(false);
    expect(isLanDirect(req(undefined))).toBe(false);
    expect(isLanDirect(req(''))).toBe(false);
  });

  it.each(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via', 'cf-ray', 'cf-connecting-ip', 'cdn-loop', 'true-client-ip'])(
    'false for a private address when the request carries %s',
    (h) => {
      expect(isLanDirect(req('10.168.50.12', { [h]: '1' }))).toBe(false);
      expect(isLanDirect(req('10.168.50.12', { [h]: '' }))).toBe(false);
    },
  );

  it('an unrelated header does not matter', () => {
    expect(isLanDirect(req('10.168.50.12', { 'user-agent': 'x', accept: '*/*' }))).toBe(true);
  });

  it('a header that names a private address never makes a public socket private', () => {
    expect(isLanDirect(req('8.8.8.8', { 'x-real-ip': '10.168.1.1' }))).toBe(false);
  });
});
