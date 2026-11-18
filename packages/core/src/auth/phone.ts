/**
 * Phone numbers. One implementation (this file) and one Dart twin share the vectors in
 * `apps/box-server/test/fixtures/phone-vectors.json`. A number is stored as E.164 only.
 */

/** Arabic-Indic (U+0660..U+0669) and Eastern Arabic-Indic (U+06F0..U+06F9) digits to 0-9; other characters unchanged. */
function asciiDigits(raw: string): string {
  return raw.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (c) => {
    const code = c.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * E.164 (`+` and 8 to 15 digits, first digit 1 to 9) or null. Spaces, dashes, dots and brackets are dropped; Arabic-Indic
 * digits are read as digits; a `00` prefix becomes `+`; a leading single `0` becomes `+60` (Malaysia is the default
 * country); bare `60` followed by 9 or 10 digits becomes `+60...`; a `+60` number must have 9 or 10 digits after `60`
 * and no `0` right after it. Anything else needs its own `+` country code.
 */
export function normalisePhone(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 40) return null;
  const text = asciiDigits(raw).trim();
  if (!/^\+?[0-9 ()\-.]+$/.test(text)) return null;
  const hasPlus = text.startsWith('+');
  let digits = text.replace(/[^0-9]/g, '');
  let plus = hasPlus;
  if (!plus) {
    if (digits.startsWith('00')) {
      digits = digits.slice(2);
      plus = true;
    } else if (digits.startsWith('0')) {
      digits = '60' + digits.slice(1);
      plus = true;
    } else if (/^60[0-9]{9,10}$/.test(digits)) {
      plus = true;
    }
  }
  if (!plus) return null;
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  if (digits.startsWith('60')) {
    const rest = digits.slice(2);
    if (!/^[1-9][0-9]{8,9}$/.test(rest)) return null;
  }
  return `+${digits}`;
}

const THREE_DIGIT_CODES = new Set([
  '212', '213', '216', '218', '220', '221', '233', '234', '249', '251', '254', '255', '256', '263', '264', '265',
  '351', '352', '353', '354', '358', '359', '370', '371', '372', '375', '380', '381', '385', '386', '420', '421',
  '852', '853', '855', '856', '880', '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971',
  '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998',
]);

function countryCodeLength(digits: string): number {
  if (digits.startsWith('1') || digits.startsWith('7')) return 1;
  return THREE_DIGIT_CODES.has(digits.slice(0, 3)) ? 3 : 2;
}

function chunk(rest: string): string {
  const n = rest.length;
  const size = n % 4 === 0 ? 4 : 3;
  const parts: string[] = [];
  for (let i = 0; i < n; i += size) parts.push(rest.slice(i, i + size));
  if (parts.length > 1 && parts[parts.length - 1]!.length === 1) parts.splice(-2, 2, parts[parts.length - 2]! + parts[parts.length - 1]!);
  return parts.join(' ');
}

/** `+60120000001` to `+60 12-000 0001` (a 10-digit national number groups 2-4-4); other countries: `+<cc> <rest>` in groups of 3 or 4. */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/[^0-9]/g, '');
  if (digits.startsWith('60') && /^60[1-9][0-9]{8,9}$/.test(digits)) {
    const rest = digits.slice(2);
    const area = rest.slice(0, 2);
    const tail = rest.slice(2);
    return tail.length === 7 ? `+60 ${area}-${tail.slice(0, 3)} ${tail.slice(3)}` : `+60 ${area}-${tail.slice(0, 4)} ${tail.slice(4)}`;
  }
  const cc = countryCodeLength(digits);
  return `+${digits.slice(0, cc)} ${chunk(digits.slice(cc))}`;
}
