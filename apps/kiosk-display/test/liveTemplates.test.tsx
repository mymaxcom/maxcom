import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { KIOSK_TEMPLATE_IDS, instantOf } from '@surau/core';
import { makeView } from './helpers.tsx';
import type { KioskView } from '../src/data/kiosk.ts';
import type { LiveView } from '../src/data/live.ts';

const holder = vi.hoisted(() => ({ view: null as unknown as KioskView, live: null as unknown as LiveView }));
vi.mock('../src/data/kiosk.ts', () => ({ useKiosk: () => holder.view }));
vi.mock('../src/data/live.ts', () => ({ useLive: () => holder.live }));
vi.mock('../src/data/whep.ts', () => ({ openWhep: () => ({ close: async () => {}, location: () => null }) }));

import { App } from '../src/app.tsx';

/** Renders and lets the video report its first picture: the live shows only once frames flow (2026-11-15). */
function renderLive(ui: Parameters<typeof render>[0]) {
  const r = render(ui);
  const video = r.container.querySelector('video');
  if (video) {
    act(() => {
      fireEvent(video, new Event('playing'));
    });
  }
  return r;
}

const ON_AIR: LiveView = {
  live: true,
  since: '2026-11-05T07:40:00.000Z',
  kuliah: { label: 'Kuliah Maghrib', penceramah: 'Ustaz Ahmad Fauzi', topic: 'Bab Ikhlas dan Niat' },
  audio: false,
  volume: 50,
  playable: true,
};
const viewFor = (id: string, hhmm: string, sec = 0) =>
  makeView('2026-11-05', hhmm, {
    settings: { liveOnKiosk: { enabled: true }, kioskTemplate: { templateId: id } },
    logo: null,
    at: new Date(instantOf('2026-11-05', hhmm, 'Asia/Kuala_Lumpur').getTime() + sec * 1000),
  });

afterEach(() => cleanup());

describe('every template: the live screen gives the main area to the video', () => {
  for (const id of KIOSK_TEMPLATE_IDS) {
    it(`${id}: frame, side column, strip and next chip; no prayer table, cards, ticker or main header`, () => {
      holder.live = ON_AIR;
      holder.view = viewFor(id, '15:50');
      const r = renderLive(<App />);
      const stage = r.container.querySelector('.stage')!;
      expect(stage.getAttribute('data-template')).toBe(id);
      expect(stage.getAttribute('data-screen')).toBe('live');
      expect(stage.getAttribute('data-kind')).toBe('live');
      expect(stage.getAttribute('data-live-layout')).toBe(id === 'default' || id === 'creative' ? 'full' : 'framed');
      const screen = r.container.querySelector('.screen--live')!;
      expect(screen).toBeTruthy();
      // the four pieces, each a direct child in its own grid area
      const kids = [...screen.children].map((c) => c.className.split(' ')[0]);
      expect(kids).toEqual(['live-screen__frame', 'live-screen__side', 'live-screen__strip']);
      // brand with the logo place, the compact clock and the next-prayer chip are in the side column
      const side = screen.querySelector('.live-screen__side')!;
      for (const sel of ['.region-brand', '.region-clock.clock--compact[data-role="clock"]', '.region-next.next--chip[data-role="next"]']) {
        expect(side.querySelectorAll(sel).length, `${id} ${sel}`).toBe(1);
      }
      // the frame holds nothing but the waiting card (gone once pictures play): no panel over the video
      const frame = screen.querySelector('.live-screen__frame')!;
      expect([...frame.querySelectorAll('*')].every((el) => el.closest('.live-screen__waiting'))).toBe(true);
      // the big prayer panels and the content are not on screen at all while live
      for (const sel of ['.pbar', '[data-prayer]', '[data-layer="content"]', '.ticker', '.zikir', '.screen--main', '.next', '.emergency-band']) {
        expect(r.container.querySelector(sel), `${id} ${sel}`).toBeNull();
      }
      // the video is the app's, on the same box as the frame (live.css), outside the screen
      const layer = r.container.querySelector('.live--clear')!;
      expect(layer.parentElement).toBe(stage);
      expect(screen.contains(layer)).toBe(false);
    });

    it(`${id}: inside the azan window the template's own azan screen is on top of the blurred live`, () => {
      holder.live = ON_AIR;
      holder.view = viewFor(id, '16:19', 30);
      const r = renderLive(<App />);
      const stage = r.container.querySelector('.stage')!;
      expect(stage.getAttribute('data-live')).toBe('blurred');
      expect(stage.getAttribute('data-screen')).toBe('azan');
      expect(r.container.querySelector('.live--blurred .live__veil')).toBeTruthy();
      expect(r.container.querySelector('.screen--phase.screen--azanCountdown')).toBeTruthy();
      expect(r.container.querySelector('.screen--live')).toBeNull();
    });
  }
});
