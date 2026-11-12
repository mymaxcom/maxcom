// Serif headings of the Old School template (Latin only; Arabic keeps Amiri Quran / QPC Hafs).
import '@fontsource/amiri/latin-400.css';
import '@fontsource/amiri/latin-700.css';
// The thin wall clock of the Minimal template (Latin digits only).
import '@fontsource/plus-jakarta-sans/latin-300.css';
import { KIOSK_TEMPLATE_IDS } from '@surau/core';
import type { FeatureSettings, KioskTemplateId } from '@surau/core';

const KNOWN: ReadonlySet<string> = new Set(KIOSK_TEMPLATE_IDS);

/**
 * The presentation template the stage wears (`data-template`). Anything unknown, missing (an older box sends
 * no kioskTemplate feature) or switched off is 'default', the original single-colour look.
 */
export function templateOf(s: FeatureSettings | null | undefined): KioskTemplateId {
  if (!s || typeof s !== 'object' || s.enabled === false) return 'default';
  const id = (s as { templateId?: unknown }).templateId;
  return typeof id === 'string' && KNOWN.has(id) ? (id as KioskTemplateId) : 'default';
}
