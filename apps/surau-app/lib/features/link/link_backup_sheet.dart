// The sheet of the three backup actions ("Buang sandaran", "Buang data lama", "Kembali ke data sebelum dipautkan"):
// what will happen, a word the person types to confirm, and the PIN when the app lock is on. The PIN goes into the one
// request [BackupSubmit] makes and is dropped with the sheet; a refusal is worded under the fields and the sheet stays
// open, any other answer closes it.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show PinField;
import '../enrol/pin_policy.dart' show pinLength;
import 'link_text.dart';

/// Runs the action with [pin] (null when the app lock is off); returns the refusal code, or null when it was accepted.
typedef BackupSubmit = Future<String?> Function(String? pin);

Future<void> showBackupSheet(
  BuildContext context, {
  required String title,
  required String body,
  required String word,
  required String action,
  required bool needsPin,
  required BackupSubmit submit,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _BackupSheet(title: title, body: body, word: word, action: action, needsPin: needsPin, submit: submit),
  );
}

class _BackupSheet extends StatefulWidget {
  const _BackupSheet({
    required this.title,
    required this.body,
    required this.word,
    required this.action,
    required this.needsPin,
    required this.submit,
  });

  final String title;
  final String body;
  final String word;
  final String action;
  final bool needsPin;
  final BackupSubmit submit;

  @override
  State<_BackupSheet> createState() => _BackupSheetState();
}

class _BackupSheetState extends State<_BackupSheet> {
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

  bool get _ready =>
      _typed.text.trim().toLowerCase() == widget.word.toLowerCase() && (!widget.needsPin || _pin.text.length == pinLength);

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
        key: const ValueKey('backup-sheet'),
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(widget.title, style: text.titleLarge),
            const SizedBox(height: 8),
            Text(widget.body, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('backup-confirm-field'),
              controller: _typed,
              autocorrect: false,
              enableSuggestions: false,
              textAlign: TextAlign.center,
              decoration: InputDecoration(labelText: s.backupConfirmLabel(widget.word)),
              onChanged: (_) => setState(() => _error = null),
            ),
            if (widget.needsPin) ...[
              const SizedBox(height: 12),
              PinField(
                key: const ValueKey('backup-pin-field'),
                controller: _pin,
                label: s.linkPinLabel,
                onChanged: (_) => setState(() => _error = null),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(linkCodeText(s, _error!), key: const ValueKey('backup-error'), style: text.bodyMedium!.copyWith(color: SurauColors.dangerInk)),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    key: const ValueKey('backup-cancel'),
                    onPressed: _busy ? null : () => Navigator.of(context).pop(),
                    child: Text(s.actionCancel),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    key: const ValueKey('backup-go'),
                    onPressed: _busy || !_ready ? null : _go,
                    style: FilledButton.styleFrom(backgroundColor: SurauColors.danger, foregroundColor: Colors.white),
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
