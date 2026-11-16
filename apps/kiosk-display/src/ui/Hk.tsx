export interface HkProps {
  /** The Arabic text with its marks. */
  text: string;
  /** Extra classes of the paragraph (the screen's own, e.g. `aa-text`). */
  class?: string;
  /** The Quranic face (QPC Hafs unless the surau chose another) instead of the general Arabic face. */
  quran?: boolean;
}

/**
 * Arabic text drawn twice, for the harakat colour (spec 6.12.2): the full text below in the text colour, and on top,
 * hidden unless the stage says `data-harakat="on"`, the same text in a marks-only font in the harakat colour, so only
 * the marks change colour. Both layers share one box, one font size, one line height and one wrapping (the top layer is
 * absolutely placed over the bottom one and sets none of those itself); only the font family differs, and the marks
 * font has the advance widths of the letters it replaces. The top layer is hidden from readers.
 */
export function Hk({ text, class: cls, quran = false }: HkProps) {
  return (
    <p class={`hk${cls ? ` ${cls}` : ''} ${quran ? 'quran' : 'arab'}`} dir="rtl" lang="ar">
      <span class="hk-b">{text}</span>
      <span class="hk-t" aria-hidden="true">{text}</span>
    </p>
  );
}
