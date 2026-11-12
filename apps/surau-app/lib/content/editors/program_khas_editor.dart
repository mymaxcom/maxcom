// Program khas: name, when it happens, the dates it is announced, a
// picture, a note, status.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class ProgramKhasEditor extends StatelessWidget {
  const ProgramKhasEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(DateTime today) => {
    'showFrom': isoDate(today),
    'showTo': isoDate(today.add(const Duration(days: 14))),
    'status': 'aktif',
  };

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('programKhas')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
