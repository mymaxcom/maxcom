import { SURAU_ID_RE } from '../surau/types.ts';

/** What a number names: a person or a device (a TV screen is a device). */
export type RefKind = 'user' | 'device';
/** `b`: the surau's primary box series (`U-0001`). `c`: the cloud series (`U-C0001`). */
export type RefSrc = 'b' | 'c';

const LETTER: Record<RefKind, string> = { user: 'U', device: 'D' };
const MAX_NO = 999_999_999;

/** `U-0001`, `D-0012`, `U-C0003`: the letter by kind, `C` for the cloud series, the number zero-padded to at least 4 digits. `no` is an integer from 1. */
export function formatRef(kind: RefKind, src: RefSrc, no: number): string {
  if (!Number.isSafeInteger(no) || no < 1) throw new RangeError('ref number must be an integer from 1');
  return `${LETTER[kind]}-${src === 'c' ? 'C' : ''}${String(no).padStart(4, '0')}`;
}

/** With the surau: `<surauId>/U-0001`. */
export function formatGlobalRef(surauId: string, kind: RefKind, src: RefSrc, no: number): string {
  return `${surauId}/${formatRef(kind, src, no)}`;
}

export interface ParsedRef {
  surauId: string | null;
  kind: RefKind | null;
  src: RefSrc;
  no: number;
}

/**
 * Loose typed text to its parts, or null: case ignored; spaces, dashes and leading zeros dropped; an optional
 * `<surauId>/` in front; `u1`, `U-0001`, `u-c12`, `D 7`. A missing letter leaves `kind` null. The number is from 1.
 */
export function parseRef(text: string): ParsedRef | null {
  if (typeof text !== 'string' || text.length > 100) return null;
  let rest = text.trim().toLowerCase();
  let surauId: string | null = null;
  const slash = rest.indexOf('/');
  if (slash >= 0) {
    const head = rest.slice(0, slash).trim();
    if (!SURAU_ID_RE.test(head)) return null;
    surauId = head;
    rest = rest.slice(slash + 1);
  }
  rest = rest.replace(/[\s-]+/g, '');
  const m = /^([ud])?(c)?(\d{1,9})$/.exec(rest);
  if (m === null) return null;
  const no = Number(m[3]);
  if (!Number.isSafeInteger(no) || no < 1 || no > MAX_NO) return null;
  return { surauId, kind: m[1] === undefined ? null : m[1] === 'u' ? 'user' : 'device', src: m[2] === undefined ? 'b' : 'c', no };
}
