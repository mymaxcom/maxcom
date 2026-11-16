import type { DatabaseSync } from 'node:sqlite';
import { isScreenId, isThemeName, MAX_PACKS } from '@surau/core';
import type { ProtectedEl } from '@surau/core';
import { getSettings } from '../settingsStore.ts';

/**
 * What a display saw when it loaded an uploaded theme: did the clock, the prayer times, the countdowns, the
 * next-prayer chip and the logo all still show ("Tema tidak sah" when not). The last report per theme is kept in
 * sync_state, so it survives a restart; a report for a theme or version that is not installed is dropped.
 */
export const THEME_HEALTH_KEY = 'theme_health_json';
const ROLES: readonly ProtectedEl[] = ['clock', 'prayers', 'countdown', 'next', 'logo'];

export interface ThemeHealthReport {
  theme: string;
  version: number;
  ok: boolean;
  screen: string;
  failed: ProtectedEl[];
  at: string;
}
/** What one display last said about a theme. */
interface DeviceReport { ok: boolean; screen: string; failed: ProtectedEl[]; at: string }
/** A bad report counts for this long (a display that stays silent after a failure must not leave the theme bad for ever, but not clear it by another display's good word either). */
export const BAD_REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEVICES_PER_THEME = 16;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The body of a report, or null when it is not exactly the agreed shape. */
export function parseHealthBody(body: unknown): Omit<ThemeHealthReport, 'at'> | null {
  if (!isPlain(body)) return null;
  const { theme, version, screen, ok, failed } = body;
  if (Object.keys(body).some((k) => !['theme', 'version', 'screen', 'ok', 'failed'].includes(k))) return null;
  if (!isThemeName(theme)) return null;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 999999) return null;
  // a catalog screen, or one of the three phases without a catalog entry
  if (typeof screen !== 'string' || screen.length > 20 || !(isScreenId(screen) || ['syuruk', 'isyraq', 'tarawih'].includes(screen))) return null;
  if (typeof ok !== 'boolean') return null;
  if (!Array.isArray(failed) || failed.length > ROLES.length || !failed.every((r) => typeof r === 'string' && (ROLES as readonly string[]).includes(r)) || new Set(failed).size !== failed.length) return null;
  if (ok !== (failed.length === 0)) return null;
  return { theme, version, screen, ok, failed: failed as ProtectedEl[] };
}

type Stored = ThemeHealthReport & { devices?: Record<string, DeviceReport> };

function readDevices(v: Record<string, unknown>): Record<string, DeviceReport> {
  const out: Record<string, DeviceReport> = {};
  if (!isPlain(v.devices)) return out;
  for (const [key, d] of Object.entries(v.devices)) {
    if (key.length === 0 || key.length > 80 || !isPlain(d) || typeof d.at !== 'string') continue;
    const p = parseHealthBody({ theme: 'x', version: 1, screen: d.screen, ok: d.ok, failed: d.failed });
    if (p !== null) out[key] = { ok: p.ok, screen: p.screen, failed: p.failed, at: d.at };
  }
  return out;
}

function readAll(db: DatabaseSync): Record<string, Stored> {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(THEME_HEALTH_KEY);
  if (typeof row?.value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!isPlain(parsed)) return {};
    const out: Record<string, Stored> = {};
    for (const [name, v] of Object.entries(parsed)) {
      if (!isThemeName(name) || !isPlain(v)) continue;
      const p = parseHealthBody({ theme: name, version: v.version, screen: v.screen, ok: v.ok, failed: v.failed });
      if (p !== null && typeof v.at === 'string') out[name] = { ...p, at: v.at, devices: readDevices(v) };
    }
    return out;
  } catch {
    return {};
  }
}

/** Keeps the report when its theme is installed at that very version; returns whether it was kept. `device` says which display it came from. */
export function recordThemeHealth(db: DatabaseSync, report: Omit<ThemeHealthReport, 'at'>, at: Date, device = 'unknown'): boolean {
  const packs = getSettings(db).themeStyle.packs;
  const rec = Object.prototype.hasOwnProperty.call(packs, report.theme) ? packs[report.theme] : undefined;
  if (rec === undefined || rec.version !== report.version) return false;
  const all = readAll(db);
  // only themes that are still installed stay, at most MAX_PACKS, the oldest reports out first
  for (const name of Object.keys(all)) if (!Object.prototype.hasOwnProperty.call(packs, name)) delete all[name];
  const before = all[report.theme];
  // a report of another version starts the per-display list over
  const devices: Record<string, DeviceReport> = before !== undefined && before.version === report.version ? { ...(before.devices ?? {}) } : {};
  devices[device.slice(0, 80)] = { ok: report.ok, screen: report.screen, failed: report.failed, at: at.toISOString() };
  const newest = Object.entries(devices).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MAX_DEVICES_PER_THEME);
  all[report.theme] = { ...report, at: at.toISOString(), devices: Object.fromEntries(newest) };
  const kept = Object.entries(all).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MAX_PACKS);
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(THEME_HEALTH_KEY, JSON.stringify(Object.fromEntries(kept)));
  return true;
}

/**
 * The report of the theme in use (the one the surau chose, at the version installed now), else null. The theme is bad when ANY
 * display reported a problem in the last 24 hours (that one is returned); otherwise the latest report stands.
 */
export function activeThemeHealth(db: DatabaseSync, now: Date = new Date()): ThemeHealthReport | null {
  const s = getSettings(db);
  const k = s.kioskTemplate;
  if (k.enabled === false) return null;
  const name = (k as { templateId?: unknown }).templateId;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(s.themeStyle.packs, name)) return null;
  const rep = readAll(db)[name];
  if (rep === undefined || rep.version !== s.themeStyle.packs[name]!.version) return null;
  const { devices, ...plain } = rep;
  const list = Object.values(devices ?? {});
  if (list.length === 0) return plain; // a record from before reports were kept per display
  const bad = list
    .filter((d) => !d.ok && now.getTime() - Date.parse(d.at) < BAD_REPORT_TTL_MS && Date.parse(d.at) <= now.getTime() + 60_000)
    .sort((x, y) => y.at.localeCompare(x.at))[0];
  if (bad !== undefined) return { theme: rep.theme, version: rep.version, ok: false, screen: bad.screen, failed: bad.failed, at: bad.at };
  // every display is fine, or its bad word is older than 24 hours
  return { ...plain, ok: true, failed: [] };
}

/** False only when the theme in use reported a problem. */
export const themeOk = (db: DatabaseSync): boolean => activeThemeHealth(db)?.ok !== false;
