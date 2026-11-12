// Zikir: its place in the sequence, the Arabic, the translation, how many
// times it is read.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class ZikirEditor extends StatelessWidget {
  const ZikirEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(int nextOrder) => {'order': nextOrder, 'repeat': 33};

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('zikir')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
