// Slot tilawah: the days, the prayer it precedes, how many minutes before,
// the surah, and whether it plays.

import 'package:flutter/material.dart';

import '../kinds.dart';
import 'content_form.dart';

class TilawahSlotEditor extends StatelessWidget {
  const TilawahSlotEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults() => {
    'days': ['daily'],
    'before': 'subuh',
    'minutesBefore': 20,
    'surah': 18,
    'enabled': true,
  };

  @override
  Widget build(BuildContext context) => ContentForm(
    spec: contentKindByKey('tilawahSlot')!,
    initial: initial,
    itemId: itemId,
    readOnly: readOnly,
  );
}
