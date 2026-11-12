// Turns the help contact into something a thumb can act on: a phone call,
// a WhatsApp chat or an email. Malaysian numbers written with a leading 0
// become +60 for WhatsApp, which only understands international digits.

import 'package:url_launcher/url_launcher.dart';

/// Opens [uri] outside the app; the default uses url_launcher, tests
/// capture the URI instead. Returns false when nothing could open it.
typedef UrlOpener = Future<bool> Function(Uri uri);

Future<bool> launchOutside(Uri uri) async {
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } on Exception {
    return false;
  }
}

abstract final class ContactLinks {
  /// `tel:` with the number as written, spaces and dashes removed.
  static Uri tel(String phone) => Uri(scheme: 'tel', path: _compact(phone));

  /// `https://wa.me/<digits>`: a Malaysian `01x` number becomes `601x`;
  /// a number given with `+` keeps its country code.
  static Uri whatsApp(String phone) =>
      Uri.https('wa.me', '/${internationalDigits(phone)}');

  static Uri mailto(String email) => Uri(scheme: 'mailto', path: email.trim());

  /// Digits only, with Malaysia's `0` trunk prefix swapped for `60` when
  /// the number was not written internationally.
  static String internationalDigits(String phone) {
    final t = phone.trim();
    final digits = t.replaceAll(RegExp(r'[^0-9]'), '');
    if (t.startsWith('+')) return digits;
    if (digits.startsWith('0')) return '60${digits.substring(1)}';
    return digits;
  }

  static String _compact(String phone) =>
      phone.trim().replaceAll(RegExp(r'[\s-]'), '');
}
