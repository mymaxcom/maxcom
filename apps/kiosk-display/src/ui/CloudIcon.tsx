import type { Settings } from '@surau/core';
import { fmtAt } from '../format.ts';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';
import './cloudIcon.css';

export interface CloudIconProps {
  offline: boolean;
  lastOkAt: string | null;
  settings: Settings;
  lang: Lang;
  /** Quieter in a prayer phase, as the not-paired badge is. */
  dim: boolean;
}

/** Material `cloud_done` (outlined) and `cloud_off` (rounded), 24x24, Apache-2.0: the glyphs the MAX Admin Client uses. */
const CLOUD_DONE =
  'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3zm-9-3.82l-2.09-2.09L6.5 13.5 10 17l6.01-6.01-1.41-1.41z';
const CLOUD_OFF =
  'M19.35 10.04C18.67 6.59 15.64 4 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46C10.21 6.23 11.08 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C23.16 18.16 24 16.68 24 15c0-2.64-2.05-4.78-4.65-4.96zM4.41 3.86c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l2.77 2.77C2.65 8.31 0 10.84 0 14c0 3.31 2.69 6 6 6h11.73l1.54 1.54c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L4.41 3.86zM6 18c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73l8 8H6z';

/**
 * The cloud state of a linked box: a small icon just left of the MAXCOM logo (teal when the cloud answered
 * recently, red when it did not). No visible text; the words live in aria-label and title. It is a sibling
 * of the logo button with no pointer events, so it never takes part in the host-exit double click or hold.
 */
export function CloudIcon({ offline, lastOkAt, settings, lang, dim }: CloudIconProps) {
  const time = fmtAt(lastOkAt, settings.prayerBar.timeFormat === '24h' ? '24h' : '12h', lang);
  const label = offline ? `${t('cloudOffline', lang)}${time !== null ? ` · ${t('cloudSyncedAt', lang, { time })}` : ''}` : t('cloudOnline', lang);
  return (
    <div
      class="cloud-icon"
      data-testid="cloud-icon"
      data-state={offline ? 'offline' : 'online'}
      data-dim={dim ? 'true' : 'false'}
      role="img"
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={offline ? CLOUD_OFF : CLOUD_DONE} />
      </svg>
    </div>
  );
}
