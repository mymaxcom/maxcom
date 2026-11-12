// Hadis: the translation, the Arabic text, the source.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class HadisEditor extends StatelessWidget {
  const HadisEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults() => const {};

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('hadis')!,
    initial: initial,
    itemId: itemId,
    // What HadeethEnc served is never edited here: the box would refuse it.
    readOnly: readOnly || initial['ext'] != null,
  );
}
