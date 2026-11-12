import type { Settings } from '@surau/core';
import { fmtAt } from '../format.ts';
import { t } from '../i18n.ts';
import type { Lang } from '../i18n.ts';

export interface CloudBadgeProps {
  lastOkAt: string | null;
  settings: Settings;
  lang: Lang;
  /** Quieter in a prayer phase, as the not-paired badge is. */
  dim: boolean;
}

/** The small corner chip on a linked box that has lost the cloud. It lives in the strip under the prayer bar. */
export function CloudBadge({ lastOkAt, settings, lang, dim }: CloudBadgeProps) {
  const time = fmtAt(lastOkAt, settings.prayerBar.timeFormat === '24h' ? '24h' : '12h', lang);
  return (
    <div class="cloud-badge" data-testid="cloud-badge" data-dim={dim ? 'true' : 'false'} role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M7 18h10.5a3.5 3.5 0 0 0 .6-6.95A6 6 0 0 0 6.6 9.3 4.5 4.5 0 0 0 7 18z" />
        <path d="M4 4l16 16" />
      </svg>
      {t('cloudOffline', lang)}
      {time !== null ? ` · ${t('cloudSyncedAt', lang, { time })}` : ''}
    </div>
  );
}
