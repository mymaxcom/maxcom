import type { DatabaseSync } from "node:sqlite";
import { getSettings } from "../settingsStore.ts";

/**
 * Whether the app asks for a PIN (or fingerprint) at unlock. Read per request, never cached, so
 * a change made in the app, the CLI or surau.ini applies at the next unlock. Off by default on
 * every box, new or upgraded: no settings row resolves to `false`.
 */
export function appLockEnabled(db: DatabaseSync): boolean {
  return getSettings(db).appLock.enabled === true;
}

/**
 * Whether THIS person is asked for a PIN: the surau-wide lock, or the Pentadbir MAXCOM role, whose
 * device always asks for a PIN or fingerprint whatever the surau decided (Plan 12 decision 7).
 */
export function appLockRequiredFor(db: DatabaseSync, roles: readonly string[]): boolean {
  return roles.includes('superadmin') || appLockEnabled(db);
}
