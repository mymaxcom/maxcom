import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cameraAddressReason } from '../src/live/camera.js';

// [L8] The app has a Dart twin of the camera address rules (lib/features/live/camera_url.dart). Both read this file:
// the reason an address is refused must be the same on both sides.
const file = new URL('../../surau-app/test/fixtures/vectors/camera-url-vectors.json', import.meta.url);
interface Vector {
  name: string;
  url: string;
  boxIps?: string[];
  repeat?: { char: string; times: number };
  reason: string | null;
}
const vectors = JSON.parse(readFileSync(file, 'utf8')) as Vector[];

describe('[L8] camera address vectors shared with the app', () => {
  for (const v of vectors) {
    it(`[L8] ${v.name}`, () => {
      const url = v.repeat === undefined ? v.url : v.url + v.repeat.char.repeat(v.repeat.times);
      expect(cameraAddressReason(url, v.boxIps ?? [])).toBe(v.reason);
    });
  }
});
