// "Sahkan dengan PIN anda": the sheet that asks for the PIN right before a link request that needs it. The PIN goes
// into the one request [submit] makes and is dropped with the sheet; a refusal (`wrong_pin`, `locked`) is worded under
// the field and the sheet stays open, any other answer closes it.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show PinField;
import '../enrol/pin_policy.dart' show pinLength;
import 'link_text.dart';

/// Runs the request with [pin]; returns the refusal code to show under the field, or null when the request was
/// accepted (or ended some other way the screen behind shows).
typedef LinkPinSubmit = Future<String?> Function(String pin);

/// Opens the sheet. [body] says what the PIN is for; [action] is the button's words.
Future<void> showLinkPinSheet(
  BuildContext context, {
  required String body,
  required String action,
  required LinkPinSubmit submit,
  String Function(S s, String code)? codeText,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _PinSheet(body: body, action: action, submit: submit, codeText: codeText),
  );
}

class _PinSheet extends StatefulWidget {
  const _PinSheet({required this.body, required this.action, required this.submit, this.codeText});

  final String body;
  final String action;
  final LinkPinSubmit submit;
  final String Function(S s, String code)? codeText;

  @override
  State<_PinSheet> createState() => _PinSheetState();
}

class _PinSheetState extends State<_PinSheet> {
  final _pin = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    if (_busy || _pin.text.length != pinLength) return;
    final typed = _pin.text;
    setState(() {
      _busy = true;
      _error = null;
    });
    final code = await widget.submit(typed);
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
    return Padding(
      key: const ValueKey('link-pin-sheet'),
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(s.linkPinTitle, style: text.titleLarge),
          const SizedBox(height: 8),
          Text(widget.body, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 16),
          PinField(
            key: const ValueKey('link-pin-field'),
            controller: _pin,
            label: s.linkPinLabel,
            autofocus: true,
            errorText: _error == null ? null : (widget.codeText ?? linkCodeText)(s, _error!),
            onChanged: (_) => setState(() => _error = null),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  key: const ValueKey('link-pin-cancel'),
                  onPressed: _busy ? null : () => Navigator.of(context).pop(),
                  child: Text(s.actionCancel),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  key: const ValueKey('link-pin-go'),
                  onPressed: _busy || _pin.text.length != pinLength ? null : _go,
                  child: Text(widget.action),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
