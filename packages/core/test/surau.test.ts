import { describe, expect, it } from 'vitest';
import { SURAU_ID_RE, type PendingBox, type Surau, type SurauStatus } from '../src/index.ts';

describe('SURAU_ID_RE', () => {
  it('accepts the pilot id and a base32 box id', () => {
    expect(SURAU_ID_RE.test('sdm')).toBe(true);
    expect(SURAU_ID_RE.test('4u3t8wqm9o5k')).toBe(true);
    expect(SURAU_ID_RE.test('masjid-kajang-2')).toBe(true);
  });

  it('accepts 2 to 40 lowercase letters, digits and hyphens', () => {
    expect(SURAU_ID_RE.test('sd')).toBe(true);
    expect(SURAU_ID_RE.test('s')).toBe(false);
    expect(SURAU_ID_RE.test('a'.repeat(40))).toBe(true);
    expect(SURAU_ID_RE.test('a'.repeat(41))).toBe(false);
  });

  it('refuses anything outside lowercase letters, digits and hyphens', () => {
    expect(SURAU_ID_RE.test('*')).toBe(false);
    expect(SURAU_ID_RE.test('SDM')).toBe(false);
    expect(SURAU_ID_RE.test('surau masjid')).toBe(false);
    expect(SURAU_ID_RE.test('sdm/')).toBe(false);
    expect(SURAU_ID_RE.test('')).toBe(false);
  });
});

describe('surau types', () => {
  it('SurauStatus has exactly the four values', () => {
    const all: SurauStatus[] = ['ok', 'offline', 'waiting', 'suspended'];
    expect(all).toHaveLength(4);
  });

  it('Surau carries the ten plan fields', () => {
    const s: Surau = {
      id: 'sdm',
      name: 'Masjid Sultan Dawood',
      kind: 'surau',
      location: 'Kajang',
      zone: 'WLY01',
      createdAt: '2026-11-01T09:00:00.000Z',
      linkedAt: '2026-11-02T09:00:00.000Z',
      reviewedAt: null,
      suspendedAt: null,
      suspendedReason: null,
    };
    expect(Object.keys(s)).toEqual([
      'id',
      'name',
      'kind',
      'location',
      'zone',
      'createdAt',
      'linkedAt',
      'reviewedAt',
      'suspendedAt',
      'suspendedReason',
    ]);
  });

  it('PendingBox carries the claim and the optional box metadata', () => {
    const p: PendingBox = {
      boxId: 'a1b2c3d4e5f60718',
      name: 'Bilik persatuan',
      claimCode: '9f3a1c2e',
      at: '2026-11-05T10:00:00.000Z',
    };
    const withMeta: PendingBox = { ...p, boxName: 'Box dapur', platform: 'linux', version: '1.2.3' };
    expect(Object.keys(p)).toEqual(['boxId', 'name', 'claimCode', 'at']);
    expect(withMeta.boxName).toBe('Box dapur');
    expect(withMeta.platform).toBe('linux');
    expect(withMeta.version).toBe('1.2.3');
  });
});
