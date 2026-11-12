// Waktu dunia: a city, its time zone from the list, its order.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class WorldTimeEditor extends StatelessWidget {
  const WorldTimeEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(int nextOrder) => {'order': nextOrder};

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('worldTime')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
