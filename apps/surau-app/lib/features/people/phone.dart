// Phone numbers. The Dart twin of `packages/core/src/auth/phone.ts`: both read
// the vectors in `apps/box-server/test/fixtures/phone-vectors.json`. A number
// is stored on the servers as E.164 only; the app normalises what a person types
// the same way before it sends, and formats the stored value for reading.
//
// A phone number is personal data: it is never logged and never put in an error
// text, a golden or a fixture (tests use only +60 12-000 0000 to +60 12-000 0099).

/// Arabic-Indic (U+0660 to U+0669) and Eastern Arabic-Indic (U+06F0 to U+06F9)
/// digits to 0-9; every other character is unchanged.
String _asciiDigits(String raw) => raw.replaceAllMapped(
  RegExp('[٠-٩۰-۹]'),
  (m) {
    final code = m.group(0)!.codeUnitAt(0);
    return String.fromCharCode(0x30 + (code >= 0x06F0 ? code - 0x06F0 : code - 0x0660));
  },
);

final RegExp _typed = RegExp(r'^\+?[0-9 ()\-.]+$');
final RegExp _bareMy = RegExp(r'^60[0-9]{9,10}$');
final RegExp _intl = RegExp(r'^[1-9][0-9]{7,14}$');
final RegExp _myRest = RegExp(r'^[1-9][0-9]{8,9}$');
final RegExp _e164 = RegExp(r'^\+[1-9][0-9]{7,14}$');

/// E.164 (`+` and 8 to 15 digits, first digit 1 to 9) or null. Spaces, dashes,
/// dots and brackets are dropped; Arabic-Indic digits are read as digits; a
/// `00` prefix becomes `+`; a leading single `0` becomes `+60` (Malaysia is the
/// default country); bare `60` followed by 9 or 10 digits becomes `+60...`; a
/// `+60` number must have 9 or 10 digits after `60` and no `0` right after it.
/// Anything else needs its own `+` country code.
String? normalisePhone(String raw) {
  if (raw.isEmpty || raw.length > 40) return null;
  final text = _asciiDigits(raw).trim();
  if (!_typed.hasMatch(text)) return null;
  var plus = text.startsWith('+');
  var digits = text.replaceAll(RegExp(r'[^0-9]'), '');
  if (!plus) {
    if (digits.startsWith('00')) {
      digits = digits.substring(2);
      plus = true;
    } else if (digits.startsWith('0')) {
      digits = '60${digits.substring(1)}';
      plus = true;
    } else if (_bareMy.hasMatch(digits)) {
      plus = true;
    }
  }
  if (!plus) return null;
  if (!_intl.hasMatch(digits)) return null;
  if (digits.startsWith('60') && !_myRest.hasMatch(digits.substring(2))) return null;
  return '+$digits';
}

/// Whether [value] is a stored E.164 number (`+` and 8 to 15 digits).
bool isE164(String value) => _e164.hasMatch(value);

const Set<String> _threeDigitCodes = {
  '212', '213', '216', '218', '220', '221', '233', '234', '249', '251', '254', '255', '256', '263', '264', '265',
  '351', '352', '353', '354', '358', '359', '370', '371', '372', '375', '380', '381', '385', '386', '420', '421',
  '852', '853', '855', '856', '880', '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971',
  '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998',
};

int _countryCodeLength(String digits) {
  if (digits.startsWith('1') || digits.startsWith('7')) return 1;
  return digits.length >= 3 && _threeDigitCodes.contains(digits.substring(0, 3)) ? 3 : 2;
}

String _chunk(String rest) {
  final n = rest.length;
  final size = n % 4 == 0 ? 4 : 3;
  final parts = <String>[];
  for (var i = 0; i < n; i += size) {
    parts.add(rest.substring(i, i + size > n ? n : i + size));
  }
  if (parts.length > 1 && parts.last.length == 1) {
    final tail = parts.removeLast();
    parts[parts.length - 1] = parts.last + tail;
  }
  return parts.join(' ');
}

final RegExp _myNumber = RegExp(r'^60[1-9][0-9]{8,9}$');

/// `+60120000001` to `+60 12-000 0001` (a 10-digit national number groups
/// 2-4-4 after the code); other countries: `+<cc> <rest>` in groups of 3 or 4.
String formatPhone(String e164) {
  final digits = e164.replaceAll(RegExp(r'[^0-9]'), '');
  if (_myNumber.hasMatch(digits)) {
    final rest = digits.substring(2);
    final area = rest.substring(0, 2);
    final tail = rest.substring(2);
    return tail.length == 7
        ? '+60 $area-${tail.substring(0, 3)} ${tail.substring(3)}'
        : '+60 $area-${tail.substring(0, 4)} ${tail.substring(4)}';
  }
  final cc = _countryCodeLength(digits);
  if (digits.length < cc) return '+$digits';
  return '+${digits.substring(0, cc)} ${_chunk(digits.substring(cc))}';
}

/// `https://wa.me/<digits without +>?text=<percent-encoded text>` for an E.164
/// [e164]; throws [ArgumentError] when [e164] is not E.164 (a number is never
/// guessed). A space is `%20` (the form `+` is not read as a space everywhere).
/// Only `openWhatsApp` opens it.
Uri whatsAppUri(String e164, String text) {
  if (!isE164(e164)) throw ArgumentError.value('number', 'e164', 'not E.164');
  return Uri.parse('https://wa.me/${e164.substring(1)}?text=${Uri.encodeComponent(text)}');
}
