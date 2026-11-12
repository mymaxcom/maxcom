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
  const text = footer ? (lang === 'en' ? footer.en : footer.ms) : '';
  if (!text) return null;
  return (
    <div class="source-footer" data-testid="source-footer">
      {text}
    </div>
  );
}
