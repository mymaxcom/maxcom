// Petugas: a name and a photo.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class PetugasEditor extends StatelessWidget {
  const PetugasEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults() => const {};

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('petugas')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
