import qrcode from 'qrcode-generator';

export interface QrProps {
  /** The text to encode (a `maxcom1:` payload). Empty draws nothing. */
  text: string;
  /** Edge length in CSS pixels. */
  size: number;
  /** Quiet zone in modules (the QR standard asks for 4). */
  quiet?: number;
}

/** Dark modules as one SVG path: a horizontal run per row, so a large code is a few KB of path data. */
export function qrPath(text: string, quiet = 4): { d: string; modules: number } | null {
  if (text === '') return null;
  try {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!q.isDark(r, c)) {
          c++;
          continue;
        }
        const start = c;
        while (c < n && q.isDark(r, c)) c++;
        d += `M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`;
      }
    }
    return { d, modules: n + quiet * 2 };
  } catch {
    // too long for any QR version: draw nothing rather than crash the screen
    return null;
  }
}

/** A QR code drawn offline as inline SVG, black on white (high contrast reads best from across a room). */
export function Qr({ text, size, quiet = 4 }: QrProps) {
  const p = qrPath(text, quiet);
  if (p === null) return null;
  return (
    <svg
      data-testid="qr"
      role="img"
      aria-label="Kod QR"
      width={size}
      height={size}
      viewBox={`0 0 ${p.modules} ${p.modules}`}
      shape-rendering="crispEdges"
    >
      <rect width={p.modules} height={p.modules} fill="#fff" />
      <path d={p.d} fill="#000" />
    </svg>
  );
}
