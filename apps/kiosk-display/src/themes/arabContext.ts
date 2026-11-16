import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ScreenStyle } from '@surau/core';

/**
 * What the Arabic-led screens need to know about the stage they are on: the looks the theme turns on, the screen the
 * preview forces (a forced arab-* screen shows its look for any theme), and the resolved style of the screen
 * (translation placement). The default is the plain look: no theme looks, nothing forced, no menu values.
 */
export interface ArabEnv {
  looks: ReadonlySet<string>;
  forced: string | null;
  style: ScreenStyle;
}

export const ArabEnvContext = createContext<ArabEnv>({ looks: new Set(), forced: null, style: {} });

export function useArabEnv(): ArabEnv {
  return useContext(ArabEnvContext);
}
