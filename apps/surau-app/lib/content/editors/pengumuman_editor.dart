// Pengumuman: title, body, the dates it shows, priority. A new one runs
// from today for a week.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class PengumumanEditor extends StatelessWidget {
  const PengumumanEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(DateTime today) => {
    'from': isoDate(today),
    'to': isoDate(today.add(const Duration(days: 7))),
    'priority': 1,
  };

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('pengumuman')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
