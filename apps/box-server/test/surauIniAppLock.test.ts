import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { getSettings, putFeature } from '../src/settingsStore.ts';
import { applySurauIni, parseSurauIni, SURAU_INI_ACTOR } from '../src/surauIni.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'surau-ini-lock-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function collect(): { infos: string[]; warns: string[]; logger: { info(m: string): void; warn(m: string): void } } {
  const infos: string[] = [];
  const warns: string[] = [];
  return { infos, warns, logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) } };
}

describe('surau.ini app_lock', () => {
  it('app_lock = on with no row applies, as the system actor, and is listed in applied', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'name = Surau Satu\napp_lock = on\n');
    const db = openDb(join(d, 'a.db'));
    const log = collect();
    const r = applySurauIni(db, d, log.logger);
    expect(r.applied).toContain('appLock');
    expect(getSettings(db).appLock.enabled).toBe(true);
    const actor = db.prepare("SELECT actor FROM change_log WHERE entity = 'settings' AND entity_id = 'appLock'").get() as { actor: string };
    expect(actor.actor).toBe(SURAU_INI_ACTOR);
    db.close();
  });

  it('accepts the aliases and values on|off|yes|no|true|false|1|0, case-insensitive', () => {
    const cases: [string, boolean][] = [
      ['app_lock = ON', true], ['applock = Yes', true], ['app_lock = TRUE', true], ['app_lock = 1', true],
      ['app_lock = off', false], ['applock = No', false], ['app_lock = False', false], ['app_lock = 0', false],
    ];
    for (const [line, want] of cases) {
      const d = tmp();
      writeFileSync(join(d, 'surau.ini'), line + '\n');
      const db = openDb(join(d, 'c.db'));
      const log = collect();
      const r = applySurauIni(db, d, log.logger);
      expect(r.refused, line).toEqual([]);
      expect(getSettings(db).appLock.enabled, line).toBe(want);
      // an explicit off is stored as a row, so a later ini never overrides the app's choice
      expect(db.prepare("SELECT 1 AS x FROM settings WHERE feature = 'appLock'").get(), line).toBeDefined();
      db.close();
    }
  });

  it('still applies when surauInfo was already saved; the info keys are skipped', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'name = Dari Fail\napp_lock = on\n');
    const db = openDb(join(d, 'b.db'));
    putFeature(db, 'surauInfo', { name: 'Dipilih Admin' }, 'user:1');
    const log = collect();
    const r = applySurauIni(db, d, log.logger);
    expect(getSettings(db).surauInfo.name).toBe('Dipilih Admin');
    expect(getSettings(db).appLock.enabled).toBe(true);
    expect(r.applied).toContain('appLock');
    expect(r.skipped).toBe('already-saved');
    expect(r.skippedKeys.info).toBe('already-saved');
    expect(r.skippedKeys.appLock).toBeNull();
    db.close();
  });

  it('is skipped with a warning when an appLock row exists (the app choice wins)', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'app_lock = on\n');
    const db = openDb(join(d, 'e.db'));
    putFeature(db, 'appLock', { enabled: false }, 'user:1');
    const log = collect();
    const r = applySurauIni(db, d, log.logger);
    expect(getSettings(db).appLock.enabled).toBe(false);
    expect(r.applied).not.toContain('appLock');
    expect(r.skippedKeys.appLock).toBe('already-saved');
    expect(log.warns.some((w) => /app_?lock/i.test(w))).toBe(true);
    db.close();
  });

  it('refuses a bad value with a warning naming the key', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'app_lock = maybe\n');
    const db = openDb(join(d, 'f.db'));
    const log = collect();
    const r = applySurauIni(db, d, log.logger);
    expect(r.refused).toContain('appLock');
    expect(log.warns.some((w) => w.includes('appLock'))).toBe(true);
    expect(db.prepare("SELECT 1 AS x FROM settings WHERE feature = 'appLock'").get()).toBeUndefined();
    db.close();
  });

  it('ignores a [security] section line and reads the key under it', () => {
    const parsed = parseSurauIni('[security]\napp_lock = on\n');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.values.get('appLock')).toBe('on');
  });

  it('zone follows the same per-key rule (applies while only its own row is missing)', () => {
    const d = tmp();
    writeFileSync(join(d, 'surau.ini'), 'zone = SGR02\n');
    const db = openDb(join(d, 'g.db'));
    putFeature(db, 'surauInfo', { name: 'X' }, 'user:1');
    const r = applySurauIni(db, d, collect().logger);
    expect(r.applied).toContain('zone');
    expect(getSettings(db).zone.zone).toBe('SGR02');
    // a second start never overrides
    putFeature(db, 'zone', { zone: 'SGR03' }, 'user:1');
    const r2 = applySurauIni(db, d, collect().logger);
    expect(r2.applied).not.toContain('zone');
    expect(r2.skippedKeys.zone).toBe('already-saved');
    expect(getSettings(db).zone.zone).toBe('SGR03');
    db.close();
  });
});
