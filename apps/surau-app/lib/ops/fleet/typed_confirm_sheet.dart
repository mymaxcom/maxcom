// Plan 14 Task 15: a confirmation that must be typed (revoke a box). The button stays off until the word is typed
// exactly (case and surrounding spaces ignored). Ops build only.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'fleet_texts.dart';

/// True when the person typed [word] and pressed [confirm].
Future<bool> showTypedConfirm(
  BuildContext context, {
  required String title,
  required String body,
  required String word,
  required String confirm,
}) async {
  final out = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _TypedConfirm(title: title, body: body, word: word, confirm: confirm),
  );
  return out ?? false;
}

class _TypedConfirm extends StatefulWidget {
  const _TypedConfirm({required this.title, required this.body, required this.word, required this.confirm});

  final String title;
  final String body;
  final String word;
  final String confirm;

  @override
  State<_TypedConfirm> createState() => _TypedConfirmState();
}

class _TypedConfirmState extends State<_TypedConfirm> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _ok => _controller.text.trim().toLowerCase() == widget.word.toLowerCase();

  @override
  Widget build(BuildContext context) {
    final t = FleetT.of(context);
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(widget.title, style: text.titleLarge),
          const SizedBox(height: 8),
          Text(widget.body, style: text.bodyMedium),
          const SizedBox(height: 16),
          Text(t.revokeTypeLabel(widget.word), style: text.labelLarge),
          const SizedBox(height: 6),
          TextField(
            key: const ValueKey('typed-confirm-field'),
            controller: _controller,
            autocorrect: false,
            textCapitalization: TextCapitalization.characters,
            decoration: InputDecoration(hintText: widget.word),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  key: const ValueKey('typed-confirm-cancel'),
                  onPressed: () => Navigator.of(context).pop(false),
                  child: Text(s.actionCancel),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  key: const ValueKey('typed-confirm-submit'),
                  style: FilledButton.styleFrom(backgroundColor: SurauColors.danger, foregroundColor: Colors.white),
                  onPressed: _ok ? () => Navigator.of(context).pop(true) : null,
                  child: Text(widget.confirm),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
