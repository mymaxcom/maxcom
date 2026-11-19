// Bidirectional text isolation for a name or a Latin word dropped into a
// sentence of another direction (a YouTube channel in an Arabic sentence, an
// Arabic channel name in a Malay one). Without it the neutral characters
// around the name (colon, comma, bracket) take the wrong side and the line
// reads out of order.

/// First strong isolate: the direction of the text inside is its own first
/// letter's, and nothing inside leaks out to reorder the sentence around it.
const String _fsi = '\u2068';

/// Pop directional isolate.
const String _pdi = '\u2069';

/// Embeddings, overrides and isolates (U+202A..202E, U+2066..2069): a title that carries them could close our
/// isolate early or push the reading order of the sentence around it.
final RegExp _controls = RegExp(r'[\u202A-\u202E\u2066-\u2069]');

/// [text] wrapped so it keeps its own direction inside any sentence. Bidi controls inside are removed first (a
/// U+2069 in the text would end the isolate early), and the result is always wrapped. Empty text is returned as it is.
String bidiIsolate(String text) {
  final inner = text.replaceAll(_controls, '');
  if (inner.isEmpty) return inner;
  return '$_fsi$inner$_pdi';
}

/// [text] with the isolation marks removed (a plain copy for the clipboard
/// or a comparison).
String bidiStrip(String text) => text.replaceAll(_fsi, '').replaceAll(_pdi, '');
