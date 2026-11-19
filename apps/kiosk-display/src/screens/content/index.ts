import type { ComponentChildren } from 'preact';
import type { SlotFeature } from '@surau/core';
import type { CardProps } from '../../content/ContentLayer.tsx';
import { HadisScreen } from './HadisScreen.tsx';
import { KuliahScreen } from './KuliahScreen.tsx';
import { PosterScreen } from './PosterScreen.tsx';
import { VideoScreen } from './VideoScreen.tsx';

/**
 * The full-stage body of a rotation card, when its catalog screen has a design of its own; null for every other card
 * (it renders its existing card inside the generic frame of the content shell).
 */
export function screenBodyFor(feature: SlotFeature): ((p: CardProps) => ComponentChildren) | null {
  switch (feature) {
    case 'posters': return PosterScreen;
    case 'videos': return VideoScreen;
    case 'kuliahCard': return KuliahScreen;
    case 'hadis': return HadisScreen;
    default: return null;
  }
}
