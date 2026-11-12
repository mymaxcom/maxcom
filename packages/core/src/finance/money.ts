/** Money is integer sen. No float arithmetic is ever done on an amount: formatting and parsing use digit strings. */

import { MAX_AMOUNT_SEN } from './limits.ts';

/** `135680` -> `RM 1,356.80`. A negative amount is `-RM 18.00`, or `(RM 18.00)` with `parens` (reports). */
export function formatRm(sen: number, opts: { parens?: boolean } = {}): string {
  if (!Number.isSafeInteger(sen)) throw new RangeError('amount must be a whole number of sen');
  const neg = sen < 0;
  const abs = neg ? -sen : sen;
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `RM ${grouped}.${String(frac).padStart(2, '0')}`;
  if (!neg) return body;
  return opts.parens ? `(${body})` : `-${body}`;
}

const PLAIN = /^\d+(\.\d{1,2})?$/;
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;

/**
 * Text typed by a person -> sen, or null. Accepts `1356.80`, `1,356.80`, `RM 1356.8`, `1356`. Refuses more than two
 * decimals, negatives, exponents, bad comma groups and anything over `MAX_AMOUNT_SEN`.
 */
export function parseRm(text: string): number | null {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  if (/^RM/i.test(t)) t = t.slice(2).trim();
  if (!PLAIN.test(t) && !GROUPED.test(t)) return null;
  t = t.replace(/,/g, '');
  const [whole, frac = ''] = t.split('.');
  if (whole!.length > 12) return null;
  const sen = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(sen) || sen > MAX_AMOUNT_SEN) return null;
  return sen;
}
