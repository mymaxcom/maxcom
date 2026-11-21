// The box's display name (`meta.box_name`, `PUT /api/box/name`, 1..60 characters). By default it follows the
// surau name (`box1-Surau Contoh`); a name the user typed is kept. The text under the field says so.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../l10n/generated/s.dart';
import '../common/error_text.dart';

/// Whether [name] is a name the box accepts (1..60 characters after trimming).
bool validBoxName(String name) {
  final n = name.trim();
  return n.isNotEmpty && n.runes.length <= 60;
}

Future<void> showBoxNameDialog(BuildContext context, WidgetRef ref, String current) async {
  final done = await showDialog<bool>(
    context: context,
    builder: (_) => _BoxNameDialog(current: current),
  );
  if (done == true) await ref.read(healthProvider.notifier).refresh();
}

class _BoxNameDialog extends ConsumerStatefulWidget {
  const _BoxNameDialog({required this.current});

  final String current;

  @override
  ConsumerState<_BoxNameDialog> createState() => _BoxNameDialogState();
}

class _BoxNameDialogState extends ConsumerState<_BoxNameDialog> {
  late final TextEditingController _c = TextEditingController(text: widget.current);
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final s = S.of(context);
    final nav = Navigator.of(context);
    final name = _c.text.trim();
    if (!validBoxName(name)) {
      setState(() => _error = s.errcBadBoxName);
      return;
    }
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await gateway.put('/api/box/name', {'name': name});
      if (mounted) nav.pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = errorText(S.of(context), e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return AlertDialog(
      title: Text(s.boxNameRenameTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            key: const ValueKey('box-name-field'),
            controller: _c,
            autofocus: true,
            maxLength: 60,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _save(),
            decoration: InputDecoration(labelText: s.dashBoxName, errorText: _error),
          ),
          const SizedBox(height: 4),
          Text(s.boxNameFollowsHint, key: const ValueKey('box-name-hint'), style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(false), child: Text(s.actionCancel)),
        FilledButton(key: const ValueKey('box-name-save'), onPressed: _busy ? null : _save, child: Text(s.settingsSave)),
      ],
    );
  }
}
