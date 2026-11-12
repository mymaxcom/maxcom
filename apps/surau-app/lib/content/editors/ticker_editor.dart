// Teks bergerak: a short line (300 characters) and the dates it runs.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class TickerEditor extends StatelessWidget {
  const TickerEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(DateTime today) => {
    'from': isoDate(today),
    'to': isoDate(today.add(const Duration(days: 30))),
  };

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('ticker')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
