import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { validateFeatureSettings } from '@surau/core';
import type { ImageRef } from '@surau/core';
import { AssetError, MAX_IMAGE_BYTES, putAsset } from './assets/store.ts';
import { deriveImage, initialLogoRef } from './imageAdjust.ts';
import { decodeImage } from './imageResize.ts';
import { putFeature } from './settingsStore.ts';

/** change_log actor for everything the first-boot file writes. */
export const SURAU_INI_ACTOR = 'system:surau-ini';

export const SURAU_INI_FILE = 'surau.ini';
const MAX_INI_BYTES = 64 * 1024;

/** The key as written in the file (compared case-insensitively) to the surauInfo setting it sets. */
const INFO_KEYS: Readonly<Record<string, string>> = {
  name: 'name',
  kind: 'kind',
  shortaddress: 'shortAddress',
  helpname: 'helpName',
  helpphone: 'helpPhone',
  helpemail: 'helpEmail',
};
const ZONE_KEY = 'zone';
/** `app_lock` / `applock` (case-insensitive) set the appLock feature. */
const APP_LOCK_KEY = 'appLock';
const APP_LOCK_ALIASES: readonly string[] = ['app_lock', 'applock'];

export interface IniLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ParsedIni {
  /** Canonical key (`name`, `shortAddress`, ..., `zone`, `appLock`) to the text after `=`. */
  values: Map<string, string>;
  warnings: string[];
}

/**
 * `key = value` lines, UTF-8. Blank lines and lines starting with `#` or `;` are comments; a
 * `[section]` line is ignored; a value may be wrapped in one pair of double quotes. Unknown keys
 * and lines without `=` are reported, never fatal. A repeated key: the last one wins.
 */
export function parseSurauIni(text: string): ParsedIni {
  const values = new Map<string, string>();
  const warnings: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const at = `line ${index + 1}`;
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    if (line.startsWith('[') && line.endsWith(']')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      warnings.push(`${at} is not "key = value" and was skipped`);
      return;
    }
    const rawKey = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    const key = rawKey === ZONE_KEY ? ZONE_KEY : APP_LOCK_ALIASES.includes(rawKey) ? APP_LOCK_KEY : INFO_KEYS[rawKey];
    if (key === undefined) {
      warnings.push(`${at}: unknown key "${rawKey.slice(0, 40)}" was skipped`);
      return;
    }
    if (values.has(key)) warnings.push(`${at}: key "${key}" is repeated; the last value is used`);
    values.set(key, value);
  });
  return { values, warnings };
}

export interface IniResult {
  /** Why nothing was applied (file missing or unreadable), or `already-saved` when the surau details were; else null. */
  skipped: 'no-file' | 'already-saved' | 'unreadable' | null;
  /** Per key group: why it was left alone, or null when it was considered. */
  skippedKeys: {
    info: 'no-file' | 'already-saved' | 'unreadable' | null;
    zone: 'already-saved' | null;
    appLock: 'already-saved' | null;
  };
  /** Settings keys applied (including `logo`, `zone` and `appLock`). */
  applied: string[];
  /** Keys refused (also named in a warning). */
  refused: string[];
}

const BOOL_WORDS: Readonly<Record<string, boolean>> = {
  on: true, yes: true, true: true, '1': true,
  off: false, no: false, false: false, '0': false,
};

const hasRow = (db: DatabaseSync, feature: string): boolean =>
  db.prepare('SELECT 1 AS ok FROM settings WHERE feature = ?').get(feature) !== undefined;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The logo file next to the ini: PNG first, then JPEG. */
function findLogoFile(dataDir: string): { path: string; mime: 'image/png' | 'image/jpeg' } | null {
  const candidates: { name: string; mime: 'image/png' | 'image/jpeg' }[] = [
    { name: 'logo.png', mime: 'image/png' },
    { name: 'logo.jpg', mime: 'image/jpeg' },
    { name: 'logo.jpeg', mime: 'image/jpeg' },
  ];
  for (const c of candidates) {
    const path = join(dataDir, c.name);
    if (existsSync(path)) return { path, mime: c.mime };
  }
  return null;
}

/**
 * Imports the logo through the normal asset pipeline; returns the logo setting (the asset id, or an
 * adjusted image with the automatic trim and background removal), or null after a warning.
 */
function importLogo(db: DatabaseSync, dataDir: string, log: IniLogger): ImageRef | null {
  const file = findLogoFile(dataDir);
  if (file === null) return null;
  const label = file.path.slice(dataDir.length + 1);
  try {
    const st = statSync(file.path);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_IMAGE_BYTES) throw new Error('image is larger than 8 MB');
    const buf = readFileSync(file.path);
    // The app icons are made by decoding the picture, so a damaged file is refused before anything is stored.
    const pixels = decodeImage(buf);
    // The declared type comes from the file name; putAsset compares it with the magic bytes.
    const id = putAsset(db, dataDir, buf, file.mime, SURAU_INI_ACTOR).id;
    const ref = initialLogoRef(pixels, id);
    try {
      // Render now (the box would otherwise do it on first use); a failure here is not fatal.
      deriveImage(db, dataDir, 'logo', ref, SURAU_INI_ACTOR);
      deriveImage(db, dataDir, 'logoSquare', ref, SURAU_INI_ACTOR);
    } catch (error) {
      log.warn(`${SURAU_INI_FILE}: ${label} could not be pre-rendered (${messageOf(error)})`);
      // The adjustment cannot be rendered, so keep the plain asset: every read would fail on it.
      return id;
    }
    return ref;
  } catch (error) {
    const reason = error instanceof AssetError ? error.errors.join('; ') : messageOf(error);
    log.warn(`${SURAU_INI_FILE}: ${label} was not used (${reason})`);
    return null;
  }
}

/**
 * First-boot settings from `<dataDir>/surau.ini` (and `logo.png` / `logo.jpg` beside it).
 * Each part applies only while its own settings row does not exist, so the app's later choice
 * always wins over the file: the surau details (name, kind, address, help, logo) while surauInfo
 * was never saved, `zone` while zone was never saved, `app_lock` while appLock was never saved.
 * Every key is checked with the same validation the settings API uses; a bad key is refused with
 * a warning naming it and the others are still applied. Never throws: a bad file must not stop
 * the box from starting.
 */
export function applySurauIni(db: DatabaseSync, dataDir: string, log: IniLogger = console): IniResult {
  const result: IniResult = {
    skipped: null,
    skippedKeys: { info: null, zone: null, appLock: null },
    applied: [],
    refused: [],
  };
  const path = join(dataDir, SURAU_INI_FILE);
  try {
    if (!existsSync(path)) return { ...result, skipped: 'no-file', skippedKeys: { ...result.skippedKeys, info: 'no-file' } };

    let text: string;
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > MAX_INI_BYTES) throw new Error('not a regular file under 64 KB');
      text = readFileSync(path, 'utf8');
    } catch (error) {
      log.warn(`${SURAU_INI_FILE} could not be read (${messageOf(error)}); it was not used`);
      return { ...result, skipped: 'unreadable', skippedKeys: { ...result.skippedKeys, info: 'unreadable' } };
    }

    const parsed = parseSurauIni(text);
    for (const w of parsed.warnings) log.warn(`${SURAU_INI_FILE}: ${w}`);

    const refuse = (key: string, errors: string[]): void => {
      result.refused.push(key);
      log.warn(`${SURAU_INI_FILE}: key "${key}" was refused (${errors.join('; ')})`);
    };

    if (hasRow(db, 'surauInfo')) {
      result.skipped = 'already-saved';
      result.skippedKeys.info = 'already-saved';
    } else {
      const infoPatch: Record<string, unknown> = {};
      for (const [key, raw] of parsed.values) {
        if (key === ZONE_KEY || key === APP_LOCK_KEY) continue;
        // `kind` is matched without regard to case ("Masjid"); every other value is taken as written.
        const value = key === 'kind' ? raw.toLowerCase() : raw;
        const check = validateFeatureSettings('surauInfo', { [key]: value });
        if (check.ok) infoPatch[key] = value;
        else refuse(key, check.errors);
      }

      const logoId = importLogo(db, dataDir, log);
      if (logoId !== null) infoPatch.logo = logoId;

      if (Object.keys(infoPatch).length > 0) {
        try {
          putFeature(db, 'surauInfo', infoPatch, SURAU_INI_ACTOR);
          result.applied.push(...Object.keys(infoPatch));
        } catch (error) {
          log.warn(`${SURAU_INI_FILE}: the surau details could not be saved (${messageOf(error)})`);
          result.refused.push(...Object.keys(infoPatch));
        }
      }
    }

    const zoneRaw = parsed.values.get(ZONE_KEY);
    if (zoneRaw !== undefined) {
      if (hasRow(db, 'zone')) result.skippedKeys.zone = 'already-saved';
      else {
        const zone = zoneRaw.toUpperCase();
        const check = validateFeatureSettings('zone', { zone });
        if (!check.ok) refuse(ZONE_KEY, check.errors);
        else {
          try {
            putFeature(db, 'zone', { zone }, SURAU_INI_ACTOR);
            result.applied.push(ZONE_KEY);
          } catch (error) {
            log.warn(`${SURAU_INI_FILE}: the zone could not be saved (${messageOf(error)})`);
            result.refused.push(ZONE_KEY);
          }
        }
      }
    }

    const lockRaw = parsed.values.get(APP_LOCK_KEY);
    if (lockRaw !== undefined) {
      if (hasRow(db, 'appLock')) {
        result.skippedKeys.appLock = 'already-saved';
        log.warn(`${SURAU_INI_FILE}: key "${APP_LOCK_KEY}" was ignored: the app lock was already set in the app`);
      } else {
        const enabled = BOOL_WORDS[lockRaw.trim().toLowerCase()];
        if (enabled === undefined) refuse(APP_LOCK_KEY, ['use on or off']);
        else {
          try {
            putFeature(db, 'appLock', { enabled }, SURAU_INI_ACTOR);
            result.applied.push(APP_LOCK_KEY);
          } catch (error) {
            log.warn(`${SURAU_INI_FILE}: the app lock could not be saved (${messageOf(error)})`);
            result.refused.push(APP_LOCK_KEY);
          }
        }
      }
    }

    // One info line per start, whatever was applied or skipped.
    const applied = result.applied.length > 0 ? `; applied: ${result.applied.join(', ')}` : '';
    if (result.skippedKeys.info === 'already-saved') {
      log.info(`${SURAU_INI_FILE} found but the surau details in it were ignored: already saved in the app${applied}`);
    } else if (result.applied.length > 0) {
      log.info(`${SURAU_INI_FILE} applied: ${result.applied.join(', ')}`);
    }
    return result;
  } catch (error) {
    log.warn(`${SURAU_INI_FILE} was not used (${messageOf(error)})`);
    return { ...result, skipped: 'unreadable', skippedKeys: { ...result.skippedKeys, info: 'unreadable' } };
  }
}
