// The ID of a person or a device (`U-0001`, `D-0001`, cloud series `U-C0001`).
//
// An ID is allocated and stored by the servers; the app only formats and reads
// it. This file is the Dart twin of `packages/core/src/auth/ref.ts` and both
// read the vectors in `apps/box-server/test/fixtures/ref-vectors.json`.
//
// The app never invents an ID: [refOf] returns what the server stored (`ref`
// on an answer, or `no` and `noSrc` on the local copy) or null, and [RefText]
// then says "ID belum ada" in the app language.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';

const Map<String, String> _letter = {'user': 'U', 'device': 'D'};
const int _maxNo = 999999999;

/// `U-0001`, `D-0012`, `U-C0003`: the letter by [kind] (`user` or `device`; a
/// TV screen is a device), `C` for the cloud series ([src] `c`; `b` is the
/// surau's box), the number zero-padded to at least 4 digits. [no] is from 1.
String formatRef(String kind, String src, int no) {
  final letter = _letter[kind];
  if (letter == null) throw ArgumentError.value(kind, 'kind', 'user or device');
  if (src != 'b' && src != 'c') throw ArgumentError.value(src, 'src', 'b or c');
  if (no < 1) throw RangeError.value(no, 'no', 'ref number must be an integer from 1');
  return '$letter-${src == 'c' ? 'C' : ''}${no.toString().padLeft(4, '0')}';
}

/// With the surau: `<surauId>/U-0001`.
String formatGlobalRef(String surauId, String kind, String src, int no) =>
    '$surauId/${formatRef(kind, src, no)}';

final RegExp _surauIdRe = RegExp(r'^[a-z0-9-]{2,40}$');
final RegExp _typedRef = RegExp(r'^([ud])?(c)?(\d{1,9})$');

/// Loose typed text to its parts, or null: case ignored; spaces, dashes and
/// leading zeros dropped; an optional `<surauId>/` in front; `u1`, `U-0001`,
/// `u-c12`, `D 7`. A missing letter leaves `kind` null. The number is from 1.
({String? surauId, String? kind, String src, int no})? parseRef(String text) {
  if (text.length > 100) return null;
  var rest = text.trim().toLowerCase();
  String? surauId;
  final slash = rest.indexOf('/');
  if (slash >= 0) {
    final head = rest.substring(0, slash).trim();
    if (!_surauIdRe.hasMatch(head)) return null;
    surauId = head;
    rest = rest.substring(slash + 1);
  }
  rest = rest.replaceAll(RegExp(r'[\s-]+'), '');
  final m = _typedRef.firstMatch(rest);
  if (m == null) return null;
  final no = int.parse(m.group(3)!);
  if (no < 1 || no > _maxNo) return null;
  final k = m.group(1);
  return (
    surauId: surauId,
    kind: k == null ? null : (k == 'u' ? 'user' : 'device'),
    src: m.group(2) == null ? 'b' : 'c',
    no: no,
  );
}

/// The ID of a record as the server stored it: the `ref` of an answer, else
/// built from `no` and `noSrc` (the local copy carries those), else null. Never
/// invented: a record that waits for its ID has none.
String? refOf({String? ref, required String kind, int? no, String? noSrc}) {
  if (ref != null && ref.isNotEmpty) return ref;
  if (no == null || no < 1 || (noSrc != 'b' && noSrc != 'c')) return null;
  return formatRef(kind, noSrc!, no);
}

/// `U-C0012` read out as "U C 0 0 1 2" (no dash, one character at a time).
String refSpoken(String ref) => ref.replaceAll('-', '').split('').join(' ');

/// The ID in the app font with tabular figures, muted, always left-to-right (also inside
/// an Arabic row), selectable, read out as "ID U 0 0 0 1". Without an ID it
/// shows `idPending` in the app language.
class RefText extends StatelessWidget {
  const RefText(this.ref, {super.key, this.style});

  /// The stored ID, or null while the record has none yet.
  final String? ref;

  /// Merged over the muted default.
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final base = (Theme.of(context).textTheme.bodySmall ?? const TextStyle()).copyWith(
      color: SurauColors.muted,
    );
    final id = ref;
    if (id == null || id.isEmpty) {
      return Text(s.idPending, style: base.merge(style));
    }
    return Semantics(
      label: '${s.idLabel} ${refSpoken(id)}',
      excludeSemantics: true,
      child: SelectableText(
        id,
        textDirection: TextDirection.ltr,
        style: base
            .copyWith(fontFeatures: const [FontFeature.tabularFigures()])
            .merge(style),
      ),
    );
  }
}
