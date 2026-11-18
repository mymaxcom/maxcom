import { canWriteSettingsFeatures, isFeatureKey } from '@surau/core';
import type { Role } from '@surau/core';

/**
 * Siaran Langsung (live:settings) may write only the live features of the settings (core LIVE_SETTINGS_FEATURES);
 * every other settings write needs settings:write. `PUT /api/settings/:feature` names exactly one feature, so a
 * live user's write is allowed when that one feature is a live feature. Anything else (other feature, odd path) is false.
 * The feature name is read from the raw path with its case kept (the router lower-cases paths, feature keys are camelCase).
 */
export function liveSettingsPutAllowed(roles: readonly Role[], method: string, rawUrl: string): boolean {
  if (method.toUpperCase() !== 'PUT') return false;
  const cut = rawUrl.search(/[?#]/);
  const path = cut < 0 ? rawUrl : rawUrl.slice(0, cut);
  const m = /^\/api\/settings\/([A-Za-z0-9]+)$/.exec(path);
  if (m === null || !isFeatureKey(m[1]!)) return false;
  return canWriteSettingsFeatures(roles, [m[1]]);
}
