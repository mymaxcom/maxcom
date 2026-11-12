// The qari: the known EveryAyah reciters by name; `Lain-lain` reveals the
// folder name row and `Cuba sambungan`.

import 'package:flutter/material.dart';

import '../../l10n/generated/s.dart';
import '../registry.g.dart';
import 'field_meta.dart';
import 'named_dropdown.dart';
import 'test_button.dart';

const String _other = 'other';

class ReciterDropdown extends StatefulWidget {
  const ReciterDropdown({
    super.key,
    required this.path,
    required this.label,
    required this.value,
    required this.meta,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String path;
  final String label;
  final String value;
  final FieldMeta meta;
  final void Function(Object? value) onChanged;
  final String? error;
  final bool readOnly;

  @override
  State<ReciterDropdown> createState() => _ReciterDropdownState();
}

class _ReciterDropdownState extends State<ReciterDropdown> {
  static bool _known(String folder) => folder != _other && reciters.any((r) => r[0] == folder);

  late bool _typing = !_known(widget.value);
  late final TextEditingController _folder = TextEditingController(text: _known(widget.value) ? '' : widget.value);

  @override
  void didUpdateWidget(covariant ReciterDropdown old) {
    super.didUpdateWidget(old);
    if (widget.value == old.value) return;
    if (_known(widget.value)) {
      // A reset or another device chose a known reciter.
      _typing = false;
    } else if (_folder.text != widget.value) {
      _typing = true;
      _folder.text = widget.value;
    }
  }

  @override
  void dispose() {
    _folder.dispose();
    super.dispose();
  }

  List<String> get _shown => reciters.firstWhere((r) => r[0] == (_typing ? _other : widget.value));

  Future<void> _pick() async {
    final picked = await showPickerSheet<String>(
      context,
      title: widget.label,
      selected: _typing ? _other : widget.value,
      options: [for (final r in reciters) PickerOption(r[0], r[1], subtitle: r[2])],
    );
    if (picked == null || !mounted) return;
    if (picked == _other) {
      setState(() => _typing = true);
      widget.onChanged(_folder.text);
    } else {
      setState(() {
        _typing = false;
        _folder.text = '';
      });
      widget.onChanged(picked);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final row = _shown;
    return FieldFrame(
      label: widget.label,
      error: _typing ? null : widget.error,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PickerButton(
            key: ValueKey('setting-${widget.path}'),
            title: row[1],
            subtitle: row[2],
            onTap: widget.readOnly ? null : _pick,
          ),
          if (_typing) ...[
            const SizedBox(height: 14),
            TextField(
              key: ValueKey('setting-${widget.path}-folder'),
              controller: _folder,
              enabled: !widget.readOnly,
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.none,
              decoration: InputDecoration(
                labelText: s.settingsReciterFolder,
                helperText: s.settingsReciterFolderHelp,
                helperMaxLines: 3,
                errorText: widget.error,
                errorMaxLines: 3,
              ),
              onChanged: widget.onChanged,
            ),
            if (widget.meta.testable && !widget.readOnly) ...[
              const SizedBox(height: 10),
              ListenableBuilder(
                listenable: _folder,
                builder: (context, _) => TestButton(
                  body: {'kind': 'reciter', 'folder': _folder.text},
                  enabled: _folder.text.isNotEmpty && widget.error == null,
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }
}
