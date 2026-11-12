// Rekod import (Plan 13, mockup screen 4b): every file import of this surau
// with who did it and when, and undo. The box refuses an undo when a later
// import or correction took over a date; the reason it gives is shown.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../features/common/time_words.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import 'location_screen.dart';
import 'prayer_repository.dart';

class ImportRecordsScreen extends ConsumerStatefulWidget {
  const ImportRecordsScreen({super.key});

  @override
  ConsumerState<ImportRecordsScreen> createState() => _ImportRecordsScreenState();
}

class _ImportRecordsScreenState extends ConsumerState<ImportRecordsScreen> {
  List<ImportRecord>? _records;
  Map<String, String> _names = const {};
  String? _error;
  String? _done;
  String? _undoing;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null) return;
    try {
      final list = await repo.imports();
      if (mounted) setState(() => _records = list);
    } catch (e) {
      if (mounted) setState(() => _error = prayerErrorText(S.of(context), e));
      return;
    }
    try {
      final body = await ref.read(gatewayProvider)!.getFresh('/api/users');
      final users = body['users'];
      if (users is List && mounted) {
        setState(() {
          _names = {
            for (final u in users)
              if (u is Map && u['id'] is String && u['name'] is String) u['id'] as String: u['name'] as String,
          };
        });
      }
    } catch (_) {
      // A person's name is a help; the record stands without it.
    }
  }

  String _who(ImportRecord r) {
    final a = r.actor;
    if (a == null) return '-';
    final id = a.startsWith('user:') ? a.substring(5) : a;
    return _names[id] ?? (a.startsWith('user:') ? '-' : a);
  }

  String _when(String? iso) {
    final t = iso == null ? null : DateTime.tryParse(iso);
    if (t == null) return '-';
    final local = ref.read(appDepsProvider).toLocal(t);
    return '${shortDateMs(isoDate(local))}, ${timeOfDayWords(local)}';
  }

  String _overlap(S s, String? v) => switch (v) {
    'replace' => s.impOverlapReplace,
    'keep' => s.impOverlapKeep,
    'fillEmpty' => s.impOverlapFill,
    _ => v ?? '-',
  };

  Future<void> _undo(ImportRecord r) async {
    final s = S.of(context);
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null) return;
    final ok = await confirmDialog(
      context,
      title: s.rekUndoTitle,
      body: s.rekUndoBody(r.inserted, r.replaced),
      confirm: s.rekUndo,
      destructive: true,
    );
    if (!ok || !mounted) return;
    setState(() {
      _undoing = r.id;
      _error = null;
      _done = null;
    });
    try {
      final restored = await repo.undoImport(r.id);
      if (!mounted) return;
      setState(() {
        _undoing = null;
        _done = s.rekUndone(restored);
      });
      await _load();
    } on PrayerError catch (e) {
      if (!mounted) return;
      setState(() => _undoing = null);
      if (e.kind == PrayerFailure.conflict) {
        await showDialog<void>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text(s.rekBlockedTitle),
            content: Text(e.message),
            actions: [FilledButton(onPressed: () => Navigator.of(context).pop(), child: Text(s.rekBlockedOk))],
          ),
        );
      } else {
        setState(() => _error = e.message);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _undoing = null;
        _error = prayerErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final list = _records;
    return ShellPage(
      title: s.rekTitle,
      body: SurauTheme.page(
        children: [
          Text(s.rekIntro, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 12),
          if (_done != null) ...[DoneLine(_done!), const SizedBox(height: 12)],
          if (_error != null) ...[ErrorLine(_error!), const SizedBox(height: 12)],
          if (list == null && _error == null) const LinearProgressIndicator(minHeight: 2),
          if (list != null && list.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Text(s.rekNone, textAlign: TextAlign.center, style: text.bodyLarge),
            ),
          if (list != null)
            for (final r in list) ...[_record(s, text, r), const SizedBox(height: 12)],
        ],
      ),
    );
  }

  Widget _record(S s, TextTheme text, ImportRecord r) {
    final undone = r.undone;
    Widget field(String k, String v) => SizedBox(
      width: 160,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(k, style: text.bodySmall),
          Text(v, style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600)),
        ],
      ),
    );
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.description_outlined, color: Color(0xFF7A5AA6), size: 26),
                const SizedBox(width: 10),
                Expanded(child: Text(r.fileName ?? '-', style: text.titleSmall)),
                const SizedBox(width: 8),
                undone
                    ? StateChip(
                        label: s.rekStateUndone(shortDateMs(isoDate(ref.read(appDepsProvider).toLocal(DateTime.parse(r.undoneAt!))))),
                        background: SurauColors.paperDeep,
                        foreground: SurauColors.muted,
                      )
                    : StateChip(label: s.rekStateActive, background: SurauColors.tealSoft, foreground: SurauColors.teal),
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 12,
              runSpacing: 10,
              children: [
                field(s.rekSha, (r.sha256 ?? '').padRight(8).substring(0, 8)),
                field(s.rekRows, '${r.rows}'),
                field(s.rekRange, s.rekRangeValue(shortDateMs(r.dateFrom ?? ''), shortDateMs(r.dateTo ?? ''))),
                field(s.rekOverlap, _overlap(s, r.overlap)),
                field(s.rekWho, _who(r)),
                field(s.rekWhen, _when(r.createdAt)),
              ],
            ),
            if (!undone) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  key: ValueKey('rek-undo-${r.id}'),
                  onPressed: _undoing == null ? () => _undo(r) : null,
                  icon: const Icon(Icons.undo_rounded),
                  label: Text(s.rekUndo),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
