// Takwim: a date in the surau calendar with its Hijri label and a picture.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class TakwimEditor extends StatelessWidget {
  const TakwimEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(DateTime today) => {'date': isoDate(today)};

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('takwim')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
