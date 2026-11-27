// 2026.11.15, Lane B task B7 (box half): the box relay lifts the external camera's picture only when it re-encodes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { klDateOf, klInstant } from '@surau/core';
import { BRIGHTNESS_FILTER, Relay } from '../src/live/relay.ts';
import type { RelayBrightness, RelayOptions } from '../src/live/relay.ts';
import { resolveDay } from '../src/prayer/resolve.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { startLiveHarness } from './support/liveHarness.ts';
import type { LiveHarness } from './support/liveHarness.ts';

const KEY = 'abcd-efgh-ijkl-mnop-qrst';
const harnesses: LiveHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

function argsOf(relayVideo: 'copy' | 'reencode', brightness?: RelayBrightness): string[] {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-bright-'));
  try {
    const relay = new Relay({ ffmpegPath: 'ffmpeg', api: {} as RelayOptions['api'], dataDir, sessionId: 'abc123', kind: 'youtube' }) as unknown as {
      args(s: { key: string; relayVideo: string; maxBitrateKbps: number; brightness?: RelayBrightness }): string[];
    };
    return relay.args({ key: KEY, relayVideo, maxBitrateKbps: 2500, ...(brightness !== undefined ? { brightness } : {}) });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('B7: the ffmpeg arguments of the brightness levels', () => {
  it('a re-encoding relay carries the eq filter of each fixed level before the encoder, and none for normal', () => {
    for (const level of ['bright', 'brighter', 'night'] as const) {
      const a = argsOf('reencode', level);
      expect(a[a.indexOf('-vf') + 1]).toBe(BRIGHTNESS_FILTER[level]);
      expect(a.indexOf('-vf')).toBeLessThan(a.indexOf('-c:v'));
    }
    expect(argsOf('reencode', 'normal')).not.toContain('-vf');
    expect(argsOf('reencode')).not.toContain('-vf');
  });

  it('a copy relay never gets a filter, whatever the level (success path: it still copies)', () => {
    for (const level of ['bright', 'brighter', 'night'] as const) {
      const a = argsOf('copy', level);
      expect(a).not.toContain('-vf');
      expect(a.slice(a.indexOf('-c:v'), a.indexOf('-c:v') + 2)).toEqual(['-c:v', 'copy']);
    }
  });
});

describe('B7: which level the box picks', () => {
  async function box(): Promise<{ h: LiveHarness; pick: (video: 'phone' | 'external', videoPath?: 'box' | 'device') => RelayBrightness }> {
    const h = await startLiveHarness();
    harnesses.push(h);
    const s = h.app.liveSessions as unknown as { relayBrightness(s: { video: string; videoPath: string }): RelayBrightness };
    return { h, pick: (video, videoPath = 'box') => s.relayBrightness({ video, videoPath }) };
  }
  // the registry (lane P2) adds `brightness`; the box reads the stored row defensively, so the test writes the row itself
  const setBrightness = (h: LiveHarness, v: unknown): void => {
    h.app.surau.db
      .prepare("INSERT OR REPLACE INTO settings (surau_id, feature, json, updated_at, updated_by) VALUES ('sdm', 'liveCamera', ?, ?, 'test')")
      .run(JSON.stringify({ enabled: true, name: 'Kamera luaran', transport: 'auto', brightness: v }), new Date().toISOString());
  };

  it('the fixed levels are used as set; the phone camera is never lifted by the box', async () => {
    const { h, pick } = await box();
    setBrightness(h, 'bright');
    // Until lane P2 adds `brightness` to the registry (the merge of this release), the settings reader drops the key:
    // the box then reads the default (auto). Once the key is known, every fixed level is proved below.
    if (!('brightness' in getSettings(h.app.surau.db, 'sdm').liveCamera)) {
      expect(pick('external')).toBe('normal');
      return;
    }
    for (const level of ['normal', 'bright', 'brighter'] as const) {
      setBrightness(h, level);
      expect(pick('external')).toBe(level);
      expect(pick('phone')).toBe('normal');
      // F5: a picture the phone sends is lifted by the phone, never again by the box
      expect(pick('external', 'device')).toBe('normal');
    }
  });

  it('auto (the default, and any odd value): a mild gamma only from maghrib to subuh of the surau, else normal', async () => {
    const { h, pick } = await box();
    putFeature(h.app.surau.db, 'location', { latitude: 3.07, longitude: 101.52 }, 'test', undefined, 'sdm');
    const date = klDateOf(h.clock.now());
    const day = resolveDay(h.app.surau.db, getSettings(h.app.surau.db, 'sdm'), date, 'sdm');
    expect(day).not.toBeNull();
    const at = (hhmm: string, plusMin = 0): number => klInstant(date, hhmm).getTime() + plusMin * 60_000;
    h.clock.t = at(day!.times.zohor, 30);
    expect(pick('external')).toBe('normal');
    h.clock.t = at(day!.times.maghrib, 1);
    expect(pick('external')).toBe('night');
    h.clock.t = at(day!.times.subuh, -1);
    expect(pick('external')).toBe('night');
    h.clock.t = at(day!.times.subuh, 1);
    expect(pick('external')).toBe('normal');
    // an odd stored value reads as auto
    h.clock.t = at(day!.times.maghrib, 1);
    setBrightness(h, 'sparkly');
    expect(pick('external')).toBe('night');
    // the phone camera is not touched by the box at any hour
    h.clock.t = at(day!.times.maghrib, 1);
    expect(pick('phone')).toBe('normal');
    // F5: nor a camera the phone pulls and sends, even at night on auto
    setBrightness(h, 'auto');
    expect(pick('external', 'device')).toBe('normal');
    expect(pick('external', 'box')).toBe('night');
  });
});
