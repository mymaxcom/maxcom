import { expect, it } from 'vitest';
import { KIOSK_TEMPLATE_IDS, PROTECTED, SCREEN_GROUP, SCREEN_IDS, THEME_CONTRACT, THEME_TITLES, isBuiltInTheme, isScreenId, isThemeName, screenOfCard } from '../src/index.ts';
it('the catalog is the spec list, in order, 21 ids', () => {
  expect(SCREEN_IDS).toEqual(['biasa','azan','masuk-waktu','iqamah','solat','jumaat','tiada-data','live','poster','kuliah','program','hadis','zikir','tilawah','pengumuman','takwim','tabung','ayat','arab-ayat','arab-hadis','arab-zikir']);
  expect(SCREEN_IDS).toHaveLength(21);
  expect(THEME_CONTRACT).toBe(1);
});
it('every id has a group and a protected list that always holds the clock', () => {
  for (const id of SCREEN_IDS) { expect(SCREEN_GROUP[id]).toBeTruthy(); expect(PROTECTED[id]).toContain('clock'); }
  expect(PROTECTED.live).toEqual(['clock', 'next']);
  expect(PROTECTED.azan).toEqual(['clock', 'prayers', 'countdown']);
  expect(PROTECTED['tiada-data']).toEqual(['clock']);
  // Theme round 2, rule 2: every content screen (the Arabic-led ones included) needs the clock and the next chip.
  for (const id of SCREEN_IDS) if (SCREEN_GROUP[id] !== 'prayer') expect(PROTECTED[id], id).toEqual(['clock', 'next']);
  expect(PROTECTED.biasa).toEqual(['clock', 'prayers', 'next']);
  expect(PROTECTED.iqamah).toEqual(['clock', 'prayers', 'countdown']);
  expect(PROTECTED.jumaat).toEqual(['clock', 'prayers']);
});
it('groups: first seven prayer, three arab-* arabic, rest content', () => {
  for (const id of SCREEN_IDS.slice(0, 7)) expect(SCREEN_GROUP[id]).toBe('prayer');
  for (const id of ['arab-ayat', 'arab-hadis', 'arab-zikir'] as const) expect(SCREEN_GROUP[id]).toBe('arabic');
  expect(SCREEN_GROUP.live).toBe('content');
});
it('cards map to screens; cards without a screen map to null', () => {
  expect(screenOfCard('posters')).toBe('poster'); expect(screenOfCard('kuliahCard')).toBe('kuliah');
  expect(screenOfCard('ayatCard')).toBe('ayat'); expect(screenOfCard('tabungCard')).toBe('tabung');
  expect(screenOfCard('pengumuman')).toBe('pengumuman'); expect(screenOfCard('programKhas')).toBe('program');
  expect(screenOfCard('takwim')).toBe('takwim'); expect(screenOfCard('hadis')).toBe('hadis');
  expect(screenOfCard('worldTimes')).toBeNull(); expect(screenOfCard('tugasan')).toBeNull();
});
it('theme names: lowercase, digits, hyphens, 1 to 32, no edge hyphen', () => {
  for (const ok of ['hijau-siti', 'a', 'x'.repeat(32), 'tema2']) expect(isThemeName(ok)).toBe(true);
  for (const bad of ['', 'Hijau', 'a_b', '-a', 'a-', 'x'.repeat(33), 'a b', '../a', 5, null]) expect(isThemeName(bad)).toBe(false);
});
it('titles are one English name per built-in', () => {
  expect(THEME_TITLES).toMatchObject({ default: 'Default', colourful: 'Colourful', creative: 'Creative', oldschool: 'Old School', minimal: 'Minimal', arabic: 'Arabic Art' });
  expect(KIOSK_TEMPLATE_IDS).toEqual(['default', 'colourful', 'creative', 'oldschool', 'minimal', 'arabic']);
  for (const id of KIOSK_TEMPLATE_IDS) expect(isBuiltInTheme(id)).toBe(true);
  expect(isBuiltInTheme('hijau-siti')).toBe(false); expect(isScreenId('setup')).toBe(false); expect(isScreenId('azan')).toBe(true);
});
