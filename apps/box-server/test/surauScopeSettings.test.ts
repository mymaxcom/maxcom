import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { KioskLive } from '@surau/core';
import { openDb } from '../src/db.ts';
import { bumpVersion, getSettings, getVersion, putFeature, readFieldStamps } from '../src/settingsStore.ts';
import { createChangeBus } from '../src/events.ts';
import { DEFAULT_SURAU_ID } from '../src/sync/verify.ts';

const A = DEFAULT_SURAU_ID;
const B = 'surau-b';
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

describe('settings stores scoped by surau', () => {
  it('putFeature for one surau leaves the other surau\'s settings intact; the same feature lives in both', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    putFeature(db, 'appLock', { enabled: false }, 'test', undefined, A);
    putFeature(db, 'appLock', { enabled: true }, 'test', undefined, B);
    expect(getSettings(db, A).appLock.enabled).toBe(false);
    expect(getSettings(db, B).appLock.enabled).toBe(true);
    // with no surau the default one is used (behaviour unchanged)
    expect(getSettings(db, 'sdm').appLock.enabled).toBe(false);
    const rows = db.prepare('SELECT surau_id FROM settings WHERE feature = ?').all('appLock');
    expect(rows.map((r) => String(r.surau_id)).sort()).toEqual([A, B].sort());
  });

  it('versions are independent per surau', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    expect(getVersion(db, A)).toBe(0);
    expect(getVersion(db, B)).toBe(0);
    putFeature(db, 'appLock', { enabled: true }, 'test', undefined, B);
    expect(getVersion(db, B)).toBe(1);
    expect(getVersion(db, A)).toBe(0);
    expect(getVersion(db, 'sdm')).toBe(0);
    putFeature(db, 'appLock', { enabled: true }, 'test', undefined, A);
    expect(getVersion(db, A)).toBe(1);
    expect(getVersion(db, B)).toBe(1);
    // bumpVersion writes the surau's own meta row, not a shared one
    bumpVersion(db, B);
    expect(getVersion(db, B)).toBe(2);
    expect(getVersion(db, A)).toBe(1);
    const rows = db.prepare("SELECT surau_id, key FROM meta WHERE key = 'version'").all();
    expect(rows.map((r) => `${r.surau_id}:${r.key}`).sort()).toEqual([`${A}:version`, `${B}:version`].sort());
  });

  it('field stamps are read from the surau\'s own row only', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    putFeature(db, 'appLock', { enabled: true }, 'test', undefined, B);
    expect(readFieldStamps(db, 'appLock', A)).toEqual({});
    expect(readFieldStamps(db, 'appLock', 'sdm')).toEqual({});
    expect(readFieldStamps(db, 'appLock', B)).toHaveProperty('enabled');
    putFeature(db, 'appLock', { enabled: true }, 'test', undefined, A);
    expect(Object.keys(readFieldStamps(db, 'appLock', A))).toEqual(['enabled']);
  });
});

describe('change bus events carry surauId and subscribers filter', () => {
  it('an event of surau b never reaches the stream of surau a; no surau means the default one', () => {
    const bus = createChangeBus();
    const a: number[] = [];
    const all: string[] = [];
    const offA = bus.on((version, surauId) => {
      if (surauId === A) a.push(version);
    }, A);
    bus.on((version, surauId) => {
      all.push(`${surauId}:${version}`);
    });
    bus.emit(5, B);
    bus.emit(6, A);
    bus.emit(7, 'sdm');
    expect(a).toEqual([6, 7]);
    expect(all).toEqual([`${B}:5`, `${A}:6`, `${A}:7`]);
    offA();
    bus.emit(8, A);
    expect(a).toEqual([6, 7]);
    expect(all).toHaveLength(4);
  });

  it('live events are scoped the same way, and a broken listener does not block the others', () => {
    const bus = createChangeBus();
    const a: boolean[] = [];
    const seen: string[] = [];
    bus.onLive((live, surauId) => {
      if (surauId === A) a.push(live.live);
    }, A);
    bus.onLive((live, surauId) => seen.push(`${surauId}:${live.live}`));
    bus.on(() => {
      throw new Error('broken');
    }, A);
    const live = (v: boolean): KioskLive => ({ live: v, since: null, kuliah: null, audio: false, volume: 0 });
    bus.emitLive(live(true), B);
    bus.emitLive(live(false), A);
    bus.emitLive(live(true), 'sdm');
    expect(a).toEqual([false, true]);
    expect(seen).toEqual([`${B}:true`, `${A}:false`, `${A}:true`]);
  });
});
