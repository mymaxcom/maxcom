// Show the mouse pointer while it moves, hide it after 3 s of stillness. Pure DOM class toggle on <html>
// (css: html.cursor-visible); no Preact re-render. Touch and pen input never show it, and neither do the
// compatibility mouse events a browser fires right after a touch (they carry no pointerType): those are
// ignored for 1 s after the last touch or pen pointer event.
export const CURSOR_IDLE_MS = 3000;
export const TOUCH_COMPAT_MS = 1000;
const CLASS = 'cursor-visible';

export function installCursorIdle(doc: Document = document, win: Window = window): () => void {
  const root = doc.documentElement;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    timer = undefined;
    root.classList.remove(CLASS);
  };

  let lastTouchAt = Number.NEGATIVE_INFINITY;

  const onActivity = (event: Event) => {
    const type = (event as PointerEvent).pointerType;
    if (type === 'touch' || type === 'pen') {
      lastTouchAt = Date.now();
      return;
    }
    if ((type === undefined || type === '') && Date.now() - lastTouchAt < TOUCH_COMPAT_MS) return;
    root.classList.add(CLASS);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(hide, CURSOR_IDLE_MS);
  };

  const opts = { passive: true } as const;
  const events = ['pointerdown', 'pointermove', 'mousemove', 'mousedown', 'wheel'] as const;
  for (const name of events) win.addEventListener(name, onActivity, opts);

  return () => {
    for (const name of events) win.removeEventListener(name, onActivity);
    if (timer !== undefined) clearTimeout(timer);
    root.classList.remove(CLASS);
  };
}
