import type { KioskView } from '../data/kiosk.ts';
import type { Lang } from '../i18n.ts';

export interface SourceFooterProps {
  view: KioskView;
  lang: Lang;
}

/**
 * One quiet line under the prayer bar saying where today's times come from (the box sends the finished
 * sentence in both languages). Nothing for an old bundle that carries no source line.
 */
export function SourceFooter({ view, lang }: SourceFooterProps) {
  const footer = view.todaySource.footer;
  // The box writes the line in Malay and English only: an Arabic screen shows the English one, set left to right.
  const text = footer ? (lang === 'ms' ? footer.ms : footer.en) : '';
  if (!text) return null;
  return (
    <div class="source-footer free-text" data-testid="source-footer" {...(lang === 'ar' ? { lang: 'en', dir: 'ltr' } : {})}>
      {text}
    </div>
  );
}
