// Penceramah: name, title, a phone number the TV never shows, a photo.

import 'package:flutter/material.dart';

import '../../l10n/generated/s.dart';
import '../kinds.dart';
import 'content_form.dart';

class PenceramahEditor extends StatelessWidget {
  const PenceramahEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults() => const {};

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return ContentForm(
      spec: contentKindByKey('penceramah')!,
      initial: initial,
      itemId: itemId,
      readOnly: readOnly,
      hints: {'phone': s.contentPhoneHint},
    );
  }
}
