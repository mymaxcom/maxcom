// Kuliah: date, the prayer it follows, time, name, speaker, book, topic,
// status (a cancelled kuliah stays on the TV marked Batal), series.

import 'package:flutter/material.dart';

import '../../l10n/generated/s.dart';
import '../kinds.dart';
import 'content_form.dart';

class KuliahEditor extends StatelessWidget {
  const KuliahEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(DateTime today) => {
    'date': isoDate(today),
    'status': 'aktif',
  };

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return ContentForm(
      spec: contentKindByKey('kuliah')!,
      initial: initial,
      itemId: itemId,
      readOnly: readOnly,
      hints: {'status': s.contentCancelledHint},
    );
  }
}
