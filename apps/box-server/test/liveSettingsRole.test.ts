import { describe, expect, it } from 'vitest';
import { liveSettingsPutAllowed } from '../src/auth/liveSettings.ts';
import { checkRoles } from '../src/auth/users.ts';

describe('liveSettingsPutAllowed', () => {
  it('lets Siaran Langsung put the live features only', () => {
    for (const f of ['liveOnKiosk', 'liveYoutube', 'recording', 'liveCamera']) {
      expect(liveSettingsPutAllowed(['live'], 'PUT', `/api/settings/${f}`), f).toBe(true);
    }
    for (const f of ['clock', 'surauInfo', 'themeStyle', 'nope']) {
      expect(liveSettingsPutAllowed(['live'], 'PUT', `/api/settings/${f}`), f).toBe(false);
    }
  });
  it('refuses Media, other methods and odd paths', () => {
    expect(liveSettingsPutAllowed(['media'], 'PUT', '/api/settings/liveCamera')).toBe(false);
    expect(liveSettingsPutAllowed(['live'], 'GET', '/api/settings/liveCamera')).toBe(false);
    expect(liveSettingsPutAllowed(['live'], 'PUT', '/api/settings/liveCamera/')).toBe(false);
    expect(liveSettingsPutAllowed(['live'], 'PUT', '/api/settings/liveCamera/x')).toBe(false);
    expect(liveSettingsPutAllowed(['live'], 'PUT', '/api/box/name')).toBe(false);
  });
  it('accepts a live role in the role list', () => {
    expect(checkRoles(['live'])).toEqual(['live']);
  });
});
