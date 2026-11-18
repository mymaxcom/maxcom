// The catalogue for code that has no BuildContext: pick it by language, or
// take BM (the template language) when no language is at hand.

import 'dart:ui' show Locale;

import '../app/app_lang.dart';
import 'generated/s.dart';

/// The catalogue of [lang].
S sFor(AppLang lang) => lookupS(lang.locale);

/// The BM catalogue: what a message carries as its plain text, and what
/// code with no language to hand falls back to.
S get sBm => lookupS(const Locale('ms'));
