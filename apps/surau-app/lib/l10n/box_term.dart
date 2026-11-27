// The product term for one device of the multi-box set, in one place. The arb files spell it out literally (a message
// cannot read a Dart constant), and test/l10n/box_term_test.dart ties them to these constants: change a constant here
// and the test names every string that must follow.

/// The full product name, the same in every language.
const String boxProductTerm = 'MAXCOM Kiosk Box';

/// The short form used where a line has no room or repeats the full term.
const String boxShortTerm = 'Box';

/// Role words per language, as they follow (ms) or surround (en, ar) the term.
const String boxMainMs = 'utama';
const String boxFollowerMs = 'pengikut';
const String boxMainEn = 'main';
const String boxFollowerEn = 'follower';
const String boxMainAr = 'الرئيسي';
const String boxFollowerAr = 'التابع';
