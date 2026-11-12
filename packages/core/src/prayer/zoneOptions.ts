/** One `<option value="CODE">CODE - districts</option>` of the e-Solat zone page. */
export interface ZoneOption { code: string; name: string }

const OPTION_RE = /<option\s+value\s*=\s*(["'])([A-Z]{3}\d{2})\1[^>]*>([^<]{0,400})/g;
const MAX_NAME = 200;

/**
 * Zones listed on the e-Solat page, in page order. A pure function over the page text: it reads only the
 * `<option>` tags whose value looks like a zone code, strips the `CODE - ` prefix and any tag text, and
 * keeps each code once. It never throws; the caller decides what a short list means.
 */
export function parseZoneOptions(html: string): ZoneOption[] {
  const out: ZoneOption[] = [];
  const seen = new Set<string>();
  if (typeof html !== 'string') return out;
  OPTION_RE.lastIndex = 0;
  for (let m = OPTION_RE.exec(html); m !== null; m = OPTION_RE.exec(html)) {
    const code = m[2]!;
    if (seen.has(code)) continue;
    let name = m[3]!.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (name.startsWith(code)) name = name.slice(code.length).replace(/^\s*[-:]\s*/, '').trim();
    if (name === '' || name.length > MAX_NAME) continue;
    seen.add(code);
    out.push({ code, name });
  }
  return out;
}
