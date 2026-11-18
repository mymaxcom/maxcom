// Left-to-right isolation for values inside a right-to-left row: amounts
// ("-RM 18.00"), phone numbers, times, dates, codes and IDs. Without it the
// Arabic paragraph direction can move a leading minus or plus to the far end
// of the figures.

import 'package:flutter/material.dart';

const String _lri = '\u2066'; // LEFT-TO-RIGHT ISOLATE
const String _pdi = '\u2069'; // POP DIRECTIONAL ISOLATE

/// [text] wrapped in U+2066 and U+2069; it reads left to right whatever the
/// surrounding direction. Empty stays empty and an already wrapped text is
/// returned as it is.
String ltr(String text) {
  if (text.isEmpty) return text;
  if (text.startsWith(_lri) && text.endsWith(_pdi)) return text;
  return '$_lri$text$_pdi';
}

/// A [Text] of a left-to-right value. Screen readers get the plain text,
/// without the isolate characters.
class LtrText extends StatelessWidget {
  const LtrText(
    this.text, {
    super.key,
    this.style,
    this.textAlign,
    this.maxLines,
    this.overflow,
    this.softWrap,
  });

  final String text;
  final TextStyle? style;
  final TextAlign? textAlign;
  final int? maxLines;
  final TextOverflow? overflow;
  final bool? softWrap;

  @override
  Widget build(BuildContext context) => Text(
    ltr(text),
    style: style,
    textAlign: textAlign,
    maxLines: maxLines,
    overflow: overflow,
    softWrap: softWrap,
    semanticsLabel: text,
  );
}
