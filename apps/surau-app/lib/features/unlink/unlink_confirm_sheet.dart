// The sheet that confirms an unlink action ("Setuju", "Tukar pilihan", "Buang data lama"): what will happen, a word the
// person types to confirm (checked here, in the viewer's language, never by the box) and the PIN when the app lock is
// on. The PIN goes into the one request [UnlinkSubmit] makes and is dropped with the sheet; a refusal is worded under
// the fields and the sheet stays open, any other answer closes it.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show PinField;
import '../enrol/pin_policy.dart' show pinLength;
import 'unlink_text.dart';

/// Runs the action with [pin] (null when the app lock is off); returns the refusal code, or null when accepted.
typedef UnlinkSubmit = Future<String?> Function(String? pin);

Future<void> showUnlinkConfirmSheet(
  BuildContext context, {
  required String title,
  required String body,
  required String action,
  required bool needsPin,
  required UnlinkSubmit submit,
  String? word,
  bool destructive = false,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => UnlinkConfirmSheet(
      title: title,
      body: body,
      action: action,
      needsPin: needsPin,
      submit: submit,
      word: word,
      destructive: destructive,
    ),
  );
}

class UnlinkConfirmSheet extends StatefulWidget {
  const UnlinkConfirmSheet({
    super.key,
    required this.title,
    required this.body,
    required this.action,
    required this.needsPin,
    required this.submit,
    this.word,
    this.destructive = false,
  });

  final String title;
  final String body;
  final String action;
  final bool needsPin;
  final UnlinkSubmit submit;

  /// The word to type; null when the choice leaves nothing behind and only the PIN is asked.
  final String? word;
  final bool destructive;

  @override
  State<UnlinkConfirmSheet> createState() => _UnlinkConfirmSheetState();
}

class _UnlinkConfirmSheetState extends State<UnlinkConfirmSheet> {
  final _typed = TextEditingController();
  final _pin = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _typed.dispose();
    _pin.dispose();
    super.dispose();
  }

  bool get _ready {
    final w = widget.word;
    final wordOk = w == null || _typed.text.trim().toLowerCase() == w.toLowerCase();
    return wordOk && (!widget.needsPin || _pin.text.length == pinLength);
  }

  Future<void> _go() async {
    if (_busy || !_ready) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final code = await widget.submit(widget.needsPin ? _pin.text : null);
    if (!mounted) return;
    if (code == null) {
      Navigator.of(context).pop();
      return;
    }
    _pin.clear();
    setState(() {
      _busy = false;
      _error = code;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return SingleChildScrollView(
      child: Padding(
        key: const ValueKey('unlink-confirm-sheet'),
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(widget.title, style: text.titleLarge),
            const SizedBox(height: 8),
            Text(widget.body, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            if (widget.word != null) ...[
              const SizedBox(height: 16),
              TextField(
                key: const ValueKey('unlink-confirm-field'),
                controller: _typed,
                autocorrect: false,
                enableSuggestions: false,
                textAlign: TextAlign.center,
                decoration: InputDecoration(labelText: s.backupConfirmLabel(widget.word!)),
                onChanged: (_) => setState(() => _error = null),
              ),
            ],
            if (widget.needsPin) ...[
              const SizedBox(height: 12),
              PinField(
                key: const ValueKey('unlink-confirm-pin'),
                controller: _pin,
                label: s.linkPinLabel,
                autofocus: widget.word == null,
                onChanged: (_) => setState(() => _error = null),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(
                unlinkCodeText(s, _error!),
                key: const ValueKey('unlink-confirm-error'),
                style: text.bodyMedium!.copyWith(color: SurauColors.dangerInk),
              ),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    key: const ValueKey('unlink-confirm-cancel'),
                    onPressed: _busy ? null : () => Navigator.of(context).pop(),
                    child: Text(s.actionCancel),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    key: const ValueKey('unlink-confirm-go'),
                    onPressed: _busy || !_ready ? null : _go,
                    style: widget.destructive
                        ? FilledButton.styleFrom(backgroundColor: SurauColors.danger, foregroundColor: Colors.white)
                        : null,
                    child: Text(widget.action),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
