import { describe, expect, it } from 'vitest';
import { FEATURES, isBlockedHost, isBlockedIp, resolveSettings, sourceUrlError, validateFeatureSettings } from '../src/index.ts';

const url = (u: string) => validateFeatureSettings('dataSources', { esolat: { url: u } });

describe('dataSources feature', () => {
  it('is locked, on, and has the three default sources', () => {
    const f = FEATURES.find((x) => x.key === 'dataSources');
    expect(f?.locked).toBe(true);
    expect(f?.labelMs).toBe('Sumber data internet');
    expect(f?.labelEn).toBe('Internet data sources');
    const s = resolveSettings({}).dataSources as Record<string, any>;
    expect(s.enabled).toBe(true);
    expect(s.esolat).toEqual({ name: 'e-Solat JAKIM', url: 'https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat' });
    expect(s.quranText).toEqual({ name: 'QuranEnc', url: 'https://quranenc.com/api/v1' });
    expect(s.quranAudio).toEqual({ name: 'EveryAyah', url: 'https://everyayah.com/data' });
  });
  it('accepts a changed public https address and name', () => {
    expect(validateFeatureSettings('dataSources', { quranText: { name: 'Sumber baharu', url: 'https://api.example.my/v2' } }).ok).toBe(true);
    expect(url('https://8.8.8.8/x').ok).toBe(true);
    expect(url('https://[2606:4700:4700::1111]/x').ok).toBe(true);
  });
  it('refuses http and other schemes', () => {
    expect(url('http://www.e-solat.gov.my/x').ok).toBe(false);
    expect(url('ftp://example.com/x').ok).toBe(false);
    expect(url('//example.com').ok).toBe(false);
    expect(url('not a url').ok).toBe(false);
  });
  it.each([
    'https://localhost/x', 'https://foo.localhost/x', 'https://printer.local/x', 'https://nas/x', 'https://box.lan/x',
    'https://127.0.0.1/x', 'https://127.1/x', 'https://2130706433/x', 'https://0x7f.0.0.1/x', 'https://0.0.0.0/x',
    'https://10.1.2.3/x', 'https://172.16.0.1/x', 'https://172.31.255.255/x', 'https://192.' + '168.0.10/x',
    'https://169.254.169.254/x', 'https://100.64.0.1/x', 'https://100.127.255.255/x',
    'https://[::1]/x', 'https://[::]/x', 'https://[fc00::1]/x', 'https://[fd12:3456::1]/x', 'https://[fe80::1]/x',
    'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x', 'https://[::ffff:10.0.0.1]/x', 'https://[::ffff:c0a8:1]/x',
    'https://[64:ff9b::7f00:1]/x', 'https://[2002:7f00:1::]/x',
  ])('refuses %s', (u) => {
    expect(url(u).ok).toBe(false);
  });
  it('refuses userinfo, fragment, long url, long or empty name, odd text', () => {
    expect(url('https://user:pw@example.com/x').ok).toBe(false);
    expect(url('https://user@example.com/x').ok).toBe(false);
    expect(url('https://example.com/x#frag').ok).toBe(false);
    expect(url('https://example.com/' + 'a'.repeat(300)).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { esolat: { name: 'x'.repeat(61) } }).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { esolat: { name: '' } }).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { esolat: { name: '<b>x</b>' } }).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { esolat: { name: 'a\nb' } }).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { esolat: { url: 5 } }).ok).toBe(false);
  });
  it('refuses unknown keys and switching off', () => {
    expect(validateFeatureSettings('dataSources', { other: {} }).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { esolat: { extra: 'x' } }).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { enabled: false }).ok).toBe(false);
    expect(validateFeatureSettings('dataSources', { enabled: true }).ok).toBe(true);
  });
  it('a stored bad address falls back to the default, a good one is kept', () => {
    const bad = resolveSettings({ dataSources: { esolat: { url: 'http://127.0.0.1/x', name: 'Baru' } } } as any).dataSources as any;
    expect(bad.esolat.url).toBe('https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat');
    expect(bad.esolat.name).toBe('Baru');
    const good = resolveSettings({ dataSources: { quranAudio: { url: 'https://audio.example.my/d' } } } as any).dataSources as any;
    expect(good.quranAudio.url).toBe('https://audio.example.my/d');
  });
  it('does not change surauInfo name rules', () => {
    expect(validateFeatureSettings('surauInfo', { name: 'x'.repeat(80) }).ok).toBe(true);
    expect(validateFeatureSettings('surauInfo', { name: 'x'.repeat(81) }).ok).toBe(false);
  });
});

describe('address helpers', () => {
  it('isBlockedIp', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIp('[::1]')).toBe(true);
    expect(isBlockedIp('garbage')).toBe(true);
  });
  it('isBlockedHost and sourceUrlError', () => {
    expect(isBlockedHost('www.e-solat.gov.my')).toBe(false);
    expect(isBlockedHost('localhost.')).toBe(true);
    expect(sourceUrlError('https://everyayah.com/data')).toBeNull();
  });
});
