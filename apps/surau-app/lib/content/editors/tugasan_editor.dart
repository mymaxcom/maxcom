// Tugasan: who does what on which day.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class TugasanEditor extends StatelessWidget {
  const TugasanEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(DateTime today) => {
    'date': isoDate(today),
    'role': 'imam',
  };

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('tugasan')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
