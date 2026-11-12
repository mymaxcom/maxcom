import type { KioskView } from '../data/kiosk.ts';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';

/** The prayer layer wins: while any of these is on screen the band stays away (the Friday phases are 'jumaat*'). */
export function bandHiddenIn(phase: string): boolean {
  return phase === 'azanCountdown' || phase === 'masukWaktu' || phase === 'iqamah' || phase === 'solat' || phase === 'khutbah' || phase.startsWith('jumaat');
}

export interface EmergencyBandProps {
  view: KioskView;
  lang: Lang;
}

/**
 * Gold band above the prayer bar on a day whose times are a calculation in a country that has an official
 * source (the official data did not arrive): it never lets a calculated day pass for official data.
 */
export function EmergencyBand({ view, lang }: EmergencyBandProps) {
  if (!view.todaySource.emergency || bandHiddenIn(view.state.phase)) return null;
  return (
    <div class="emergency-band" data-testid="emergency-band" role="status">
      {t('kiosk.emergency', lang)}
    </div>
  );
}
