import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

/**
 * The surau's text-size factor for the screen on stage (S 1, M 1.1, L 1.2, XL 1.3; the stage's `--scale`), for the
 * cards that estimate how much text fits a page. 1 without a provider (the tests, and every screen at size S).
 */
export const ScaleContext = createContext<number>(1);

export function useScale(): number {
  return useContext(ScaleContext);
}
