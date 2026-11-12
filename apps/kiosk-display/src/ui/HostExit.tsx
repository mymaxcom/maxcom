import { useEffect, useRef, useState } from 'preact/hooks';
import logoUrl from '../assets/brand/maxcom-logo.svg';
import { captureHostBridge, exitToHost } from '../data/hostExit.ts';
import { isPreview } from '../data/preview.ts';
import './hostExit.css';

/** A touch screen has no double-click: holding the logo this long does the same. */
export const HOST_EXIT_HOLD_MS = 3000;

/**
 * The tiny MAXCOM logo in the bottom-right corner. Double-click (or a 3 second press) asks the host to close the
 * kiosk so an admin can use the box OS. It does nothing where there is no host bridge, and it is not shown in the
 * admin app's preview.
 */
export function HostExit() {
  const preview = isPreview();
  const [pulse, setPulse] = useState(false);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read (and remove) the hash before the first paint, so the address bar never shows the token.
  useState(() => (preview ? null : captureHostBridge()));
  useEffect(() => {
    return () => {
      if (hold.current !== null) clearTimeout(hold.current);
      if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
    };
  }, []);
  if (preview) return null;

  const trigger = () => {
    setPulse(true);
    // one pulse timer at a time, kept so an unmount can clear it
    if (pulseTimer.current !== null) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => {
      pulseTimer.current = null;
      setPulse(false);
    }, 600);
    void exitToHost();
  };
  const clearHold = () => {
    if (hold.current !== null) clearTimeout(hold.current);
    hold.current = null;
  };

  return (
    <button
      type="button"
      class="host-exit"
      data-testid="host-exit"
      data-pulse={pulse ? 'true' : 'false'}
      tabIndex={-1}
      aria-label="MAXCOM"
      onDblClick={trigger}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        clearHold();
        hold.current = setTimeout(trigger, HOST_EXIT_HOLD_MS);
      }}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onPointerLeave={clearHold}
    >
      <img src={logoUrl} alt="" draggable={false} />
    </button>
  );
}
