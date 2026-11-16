import type { StageScreenId } from './screenId.ts';

/** How much of the stage a screen takes: `full` the main layout, `hero` a prayer state, `content` the shell, `live`. */
export type StageKind = 'full' | 'hero' | 'content' | 'live';

/**
 * live: 'live'. biasa: 'full'. Every prayer phase screen (and syuruk, isyraq, tarawih, tiada-data): 'hero'.
 * Every other catalog screen, the Arabic-led ones included: 'content'.
 */
export function kindOf(screen: StageScreenId): StageKind {
  switch (screen) {
    case 'live':
      return 'live';
    case 'biasa':
      return 'full';
    case 'azan':
    case 'masuk-waktu':
    case 'iqamah':
    case 'solat':
    case 'jumaat':
    case 'tiada-data':
    case 'syuruk':
    case 'isyraq':
    case 'tarawih':
      return 'hero';
    default:
      return 'content';
  }
}
