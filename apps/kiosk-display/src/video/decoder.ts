import { createContext } from 'preact';

/**
 * O31 (2026.11.15): one video decoder at a time on the TV page. A weak box (2 GB or less) cannot run the live
 * picture and a rotation video side by side. True while the live player is mounted (connecting, playing, or holding
 * on for frames): a rotation video then opens no <video> and no YouTube frame, it hands its slot on.
 */
export const LiveDecoderContext = createContext(false);

/** The live picture height a display with little memory asks the box for (720 lines). */
export const LOW_MEMORY_LIVE_HEIGHT = 720;

/**
 * The tallest live picture this display should ask for: 720 when the browser says it has 2 GB of memory or less
 * (`navigator.deviceMemory`, rounded down by the browser), else nothing (the box's usual picture). The value is only
 * known where the browser gives it (a secure page such as the box's own loopback kiosk); unknown asks for nothing.
 */
export function liveMaxHeight(nav: { deviceMemory?: unknown } | undefined = globalThis.navigator as { deviceMemory?: unknown } | undefined): number | undefined {
  const mem = nav?.deviceMemory;
  return typeof mem === 'number' && Number.isFinite(mem) && mem > 0 && mem <= 2 ? LOW_MEMORY_LIVE_HEIGHT : undefined;
}
