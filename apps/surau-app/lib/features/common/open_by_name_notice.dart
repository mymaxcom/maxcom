// The "open by the MAXCOM name" notice (web build, page opened at an IP address).
// Informational: opening the other address is always the person's tap.

import 'package:flutter/material.dart';

import '../../l10n/generated/s.dart';

class OpenByNameNotice extends StatelessWidget {
  const OpenByNameNotice({super.key, required this.origin, required this.body, required this.onOpen, this.enabled = true});

  /// The box-name origin to open, e.g. `https://box1-surau.local:8443`.
  final Uri origin;

  /// The explanation (it names [origin]).
  final String body;

  final void Function(Uri origin) onOpen;

  /// False while something else is in flight (the button must not navigate away).
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Card(
      key: const ValueKey('open-by-name-notice'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.info_outline),
                const SizedBox(width: 12),
                Expanded(child: Text(s.openByNameTitle, style: text.titleSmall)),
              ],
            ),
            const SizedBox(height: 8),
            Text(body, style: text.bodyMedium),
            const SizedBox(height: 12),
            FilledButton(
              key: const ValueKey('open-by-name-open'),
              onPressed: enabled ? () => onOpen(origin) : null,
              child: Text(s.openByNameButton(origin.host)),
            ),
          ],
        ),
      ),
    );
  }
}
