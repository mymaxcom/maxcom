// Susunan kad di skrin TV: the rotation cards in their turn order, each
// with a drag handle and up and down buttons; switched-off cards are dimmed
// (the TV skips them). `Simpan` writes the new position of exactly the cards
// that moved; `Pulihkan susunan asal` writes the registry's order back.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../features/registry.g.dart';
import '../features/settings_repository.dart';
import '../features/validate.dart' show featureByKey;
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

class SettingsOrderScreen extends ConsumerStatefulWidget {
  const SettingsOrderScreen({super.key});

  @override
  ConsumerState<SettingsOrderScreen> createState() => _SettingsOrderScreenState();
}

class _SettingsOrderScreenState extends ConsumerState<SettingsOrderScreen> {
  /// The list as rearranged here; null while it matches the box.
  List<String>? _edited;
  bool _busy = false;
  String? _error;

  Map<String, dynamic> _box(String key) {
    final settings = ref.read(settingsProvider).value?.value ?? const <String, dynamic>{};
    final v = settings[key];
    return v is Map ? v.cast<String, dynamic>() : const {};
  }

  int _storedOrder(String key) {
    final v = _box(key)['order'];
    if (v is num) return v.toInt();
    final d = featureByKey(key)?.defaults['order'];
    return d is num ? d.toInt() : 99;
  }

  int _defaultOrder(String key) => (featureByKey(key)!.defaults['order'] as num).toInt();

  List<String> get _fromBox => [...orderedFeatures]..sort((a, b) => _storedOrder(a).compareTo(_storedOrder(b)));

  bool _isOn(String key) {
    final enabled = _box(key)['enabled'];
    return enabled is bool ? enabled : featureByKey(key)!.defaultEnabled;
  }

  int _seconds(String key) {
    final v = _box(key)['durationSeconds'] ?? featureByKey(key)!.defaults['durationSeconds'];
    return v is num ? v.toInt() : 0;
  }

  void _move(List<String> current, int from, int to) {
    final next = [...current];
    next.insert(to, next.removeAt(from));
    setState(() {
      _edited = next;
      _error = null;
    });
  }

  Future<void> _run(Map<String, int> writes, String done) async {
    final s = S.of(context);
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null || writes.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      for (final e in writes.entries) {
        await repo.save(e.key, {'order': e.value});
      }
      if (!mounted) return;
      setState(() {
        _busy = false;
        _edited = null;
      });
      toast(context, done);
    } catch (e) {
      if (!mounted) return;
      // Cards already written stay written; Simpan sends only what is left.
      setState(() {
        _busy = false;
        _error = e is SettingsSaveError ? e.message : writeErrorText(s, e);
      });
    }
  }

  Future<void> _save(List<String> current) => _run({
    for (final (i, key) in current.indexed)
      if (_storedOrder(key) != i + 1) key: i + 1,
  }, S.of(context).settingsOrderSaved);

  Future<void> _restore() => _run({
    for (final key in orderedFeatures)
      if (_storedOrder(key) != _defaultOrder(key)) key: _defaultOrder(key),
  }, S.of(context).settingsOrderRestored);

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    ref.watch(settingsProvider);
    final current = _edited ?? _fromBox;
    final changed = [for (final (i, key) in current.indexed) _storedOrder(key) != i + 1].any((c) => c);
    return ShellPage(
      title: s.settingsOrderRow,
      body: SurauTheme.page(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
            child: Text(s.settingsOrderIntro, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          ),
          Card(
            clipBehavior: Clip.antiAlias,
            child: ReorderableListView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              buildDefaultDragHandles: false,
              itemCount: current.length,
              onReorderItem: (from, to) {
                if (!_busy) _move(current, from, to);
              },
              itemBuilder: (context, i) {
                final key = current[i];
                final on = _isOn(key);
                return Material(
                  key: ValueKey('order-$key'),
                  color: SurauColors.card,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (i > 0) const Divider(),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(4, 8, 6, 8),
                        child: Row(
                          children: [
                            ReorderableDragStartListener(
                              index: i,
                              enabled: !_busy,
                              child: const SizedBox(
                                width: 44,
                                height: 48,
                                child: Icon(Icons.drag_handle_rounded, color: SurauColors.outline),
                              ),
                            ),
                            Opacity(
                              opacity: on ? 1 : 0.5,
                              child: Container(
                                width: 30,
                                height: 30,
                                alignment: Alignment.center,
                                decoration: const BoxDecoration(color: SurauColors.tealSoft, shape: BoxShape.circle),
                                child: Text(
                                  '${i + 1}',
                                  key: ValueKey('order-number-$key'),
                                  style: text.labelLarge!.copyWith(
                                    color: SurauColors.glass,
                                    fontWeight: FontWeight.w700,
                                    fontFeatures: const [FontFeature.tabularFigures()],
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    featureByKey(key)!.labelMs,
                                    style: text.bodyLarge!.copyWith(
                                      fontWeight: FontWeight.w600,
                                      color: on ? SurauColors.text : SurauColors.muted,
                                    ),
                                  ),
                                  Text(
                                    on
                                        ? s.settingsOrderSeconds(_seconds(key))
                                        : '${s.settingsOrderSeconds(_seconds(key))}, ${s.settingsOrderOff}',
                                    style: text.bodySmall,
                                  ),
                                ],
                              ),
                            ),
                            IconButton(
                              key: ValueKey('order-up-$key'),
                              tooltip: s.settingsOrderUp,
                              color: SurauColors.teal,
                              onPressed: _busy || i == 0 ? null : () => _move(current, i, i - 1),
                              icon: const Icon(Icons.keyboard_arrow_up_rounded),
                            ),
                            IconButton(
                              key: ValueKey('order-down-$key'),
                              tooltip: s.settingsOrderDown,
                              color: SurauColors.teal,
                              onPressed: _busy || i == current.length - 1 ? null : () => _move(current, i, i + 1),
                              icon: const Icon(Icons.keyboard_arrow_down_rounded),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 16),
          if (_error != null) ...[
            ErrorLine(_error!),
            const SizedBox(height: 16),
          ],
          FilledButton.icon(
            key: const ValueKey('order-save'),
            onPressed: changed && !_busy ? () => _save(current) : null,
            icon: const Icon(Icons.check_rounded),
            label: Text(s.settingsSave),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            key: const ValueKey('order-restore'),
            onPressed: _busy ? null : _restore,
            icon: const Icon(Icons.refresh_rounded),
            label: Text(s.settingsOrderRestore),
          ),
        ],
      ),
    );
  }
}
