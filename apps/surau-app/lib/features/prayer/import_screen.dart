// Import waktu solat (Plan 13, mockup screen 4): pick a CSV or Excel file,
// let the box check it without writing anything, read the errors or the
// preview, choose what happens to overlapping days, then save what was
// shown (the file's sha256 is sent back, so a changed file is refused). An
// e-Solat yearly file is detected by the box and saved as official days.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import 'file_pick.dart';
import 'location_screen.dart';
import 'prayer_repository.dart';
import 'widgets/country_picker.dart';
import 'widgets/month_grid.dart';

typedef PrayerFilePicker = Future<PickedFile?> Function();
typedef TemplateSaver = Future<void> Function(String fileName, Uint8List bytes);

const int _csvMaxBytes = 1024 * 1024;

/// A file name the box accepts: 1 to 120 letters, digits, spaces, dots,
/// dashes, underscores or brackets.
String safeFileName(String name) {
  final clean = name.replaceAll(RegExp(r'[^A-Za-z0-9 ._()-]'), '_');
  return clean.length > 120 ? clean.substring(clean.length - 120) : clean;
}

class ImportScreen extends ConsumerStatefulWidget {
  const ImportScreen({super.key, this.filePicker, this.templateSaver});

  final PrayerFilePicker? filePicker;
  final TemplateSaver? templateSaver;

  @override
  ConsumerState<ImportScreen> createState() => _ImportScreenState();
}

class _ImportScreenState extends ConsumerState<ImportScreen> {
  PickedFile? _file;
  String? _kind;
  String? _text;
  String? _sheet;
  ImportPreview? _preview;
  String _overlap = 'replace';
  int? _templateYear;
  bool _busy = false;
  String? _error;
  ImportApplied? _applied;
  Map<String, dynamic>? _officialDone;

  Future<PickedFile?> _pickDefault() => pickFile(extensions: const ['csv', 'xlsx'], maxBytes: pickMaxBytes);

  /// The app has no way to save a file on a device yet: the CSV goes to the
  /// clipboard. See the report of Plan 13 Task 9.
  Future<void> _saveDefault(String name, Uint8List bytes) async {
    final s = S.of(context);
    if (name.endsWith('.csv')) {
      await Clipboard.setData(ClipboardData(text: utf8.decode(bytes, allowMalformed: true)));
      if (mounted) toast(context, s.impTemplateCopied);
    } else if (mounted) {
      toast(context, s.impTemplateExcelNone);
    }
  }

  Future<void> _downloadTemplate(String kind, int year) async {
    final s = S.of(context);
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null || _busy) return;
    final save = widget.templateSaver ?? _saveDefault;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final bytes = await repo.templateBytes(kind, year);
      await save('waktu-solat-$year.$kind', bytes);
    } catch (e) {
      if (mounted) setState(() => _error = prayerErrorText(s, e));
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _pick() async {
    final s = S.of(context);
    final picked = await (widget.filePicker ?? _pickDefault)();
    if (picked == null || !mounted) return;
    setState(() {
      _preview = null;
      _applied = null;
      _officialDone = null;
      _sheet = null;
      _error = null;
    });
    if (picked.tooBig) {
      setState(() => _error = s.impTooBig);
      return;
    }
    final lower = picked.name.toLowerCase();
    final kind = lower.endsWith('.xlsx') ? 'xlsx' : (lower.endsWith('.csv') ? 'csv' : null);
    if (kind == null) {
      setState(() => _error = s.impWrongType);
      return;
    }
    if (kind == 'csv' && picked.bytes.length > _csvMaxBytes) {
      setState(() => _error = s.impTooBig);
      return;
    }
    String? text;
    if (kind == 'csv') {
      try {
        text = utf8.decode(picked.bytes);
      } on FormatException {
        setState(() => _error = s.impUnreadable);
        return;
      }
      if (text.startsWith('﻿')) text = text.substring(1);
    }
    setState(() {
      _file = picked;
      _kind = kind;
      _text = text;
    });
    await _runPreview();
  }

  Future<void> _runPreview() async {
    final s = S.of(context);
    final repo = ref.read(prayerRepositoryProvider);
    final file = _file;
    if (repo == null || file == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final p = await repo.previewImportFile(
        kind: _kind!,
        name: safeFileName(file.name),
        text: _text,
        bytes: _kind == 'xlsx' ? file.bytes : null,
        sheet: _sheet,
        overlap: _overlap,
      );
      if (!mounted) return;
      setState(() {
        _preview = p;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = prayerErrorText(s, e);
      });
    }
  }

  int get _total => _preview?.perMonth.values.fold<int>(0, (a, b) => a + b) ?? 0;

  Future<void> _confirmAndSave(String target, String? zone) async {
    final s = S.of(context);
    final p = _preview;
    if (p == null) return;
    final official = p.isOfficialHint;
    final written = p.wouldInsert + p.wouldReplace;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(official ? s.impConfirmOfficialTitle(zone ?? '') : s.impConfirmTitle(written, target)),
        content: Text(official ? s.impConfirmOfficialBody : s.impConfirmBody(p.wouldInsert, p.wouldReplace)),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(s.actionCancel)),
          FilledButton(
            key: const ValueKey('imp-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(s.impSave),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final repo = ref.read(prayerRepositoryProvider);
    final file = _file;
    if (repo == null || file == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (official) {
        final out = await repo.importOfficialCsv(zone!, _text!);
        if (mounted) {
          setState(() {
            _officialDone = out;
            _busy = false;
            _preview = null;
          });
        }
      } else {
        final out = await repo.applyImportFile(
          kind: _kind!,
          name: safeFileName(file.name),
          text: _text,
          bytes: _kind == 'xlsx' ? file.bytes : null,
          sheet: _sheet,
          overlap: _overlap,
          expectSha256: p.sha256!,
        );
        if (mounted) {
          setState(() {
            _applied = out;
            _busy = false;
            _preview = null;
          });
        }
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = prayerErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final settings = ref.watch(settingsProvider).value?.value;
    final deps = ref.watch(appDepsProvider);
    final location = featureValues(settings, 'location');
    final zone = (settings?['zone'] is Map ? (settings!['zone'] as Map)['zone'] : null) as String?;
    final info = ref.watch(surauInfoProvider);
    final isMy = location['country'] == 'MY';
    final target = info?.name ?? s.productName;
    final city = (location['city'] as String? ?? '').trim();
    final where = isMy && zone != null ? s.impTargetZone(zone) : (city.isEmpty ? '' : city);
    final done = _applied != null || _officialDone != null;
    final step = done || _preview == null ? (done ? 2 : 0) : 1;
    final today = deps.toLocal(deps.now());
    final year = _templateYear ?? today.year;
    return ShellPage(
      title: s.impTitle,
      body: SurauTheme.page(
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  const Icon(Icons.mosque_outlined, color: SurauColors.teal, size: 28),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(s.impTargetLabel, style: text.labelSmall!.copyWith(color: SurauColors.muted, fontWeight: FontWeight.w700)),
                        Text(target, style: text.titleSmall),
                        Text(
                          [if (where.isNotEmpty) where, location['timezone'] as String? ?? ''].join(', '),
                          style: text.bodySmall,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          _steps(s, text, step),
          const SizedBox(height: 12),
          if (_busy) ...[const LinearProgressIndicator(minHeight: 3), const SizedBox(height: 12)],
          if (_error != null) ...[ErrorLine(_error!), const SizedBox(height: 12)],
          if (_applied != null) ...[
            DoneLine(s.impDone, detail: s.impDoneDetail(_applied!.inserted, _applied!.replaced, _applied!.skipped)),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: () => context.go(AppRoutes.prayerImports), child: Text(s.impGoRecords)),
            const SizedBox(height: 12),
          ],
          if (_officialDone != null) ...[
            DoneLine(s.impDone, detail: s.impOfficialDone(zone ?? '')),
            const SizedBox(height: 12),
          ],
          if (_preview == null) ..._start(s, text, year, today.year) else ..._review(s, text, target, zone),
        ],
      ),
    );
  }

  Widget _steps(S s, TextTheme text, int step) {
    final names = [s.impStepPick, s.impStepCheck, s.impStepConfirm];
    return Row(
      children: [
        for (var i = 0; i < 3; i++)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(height: 4, color: i <= step ? SurauColors.teal : SurauColors.line),
                  const SizedBox(height: 4),
                  Text(
                    '${i + 1}. ${names[i]}',
                    style: text.labelSmall!.copyWith(
                      color: i == step ? SurauColors.teal : SurauColors.muted,
                      fontWeight: i == step ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  List<Widget> _start(S s, TextTheme text, int year, int thisYear) => [
    SectionLabel(s.impTemplateTitle),
    Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SegmentedButton<int>(
              showSelectedIcon: false,
              segments: [
                for (final y in [thisYear, thisYear + 1]) ButtonSegment(value: y, label: Text('$y')),
              ],
              selected: {year},
              onSelectionChanged: (v) => setState(() => _templateYear = v.first),
            ),
            const SizedBox(height: 10),
            Text(s.impTemplateHelp, style: text.bodySmall),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  key: const ValueKey('imp-template-csv'),
                  onPressed: _busy ? null : () => _downloadTemplate('csv', year),
                  icon: const Icon(Icons.download_rounded),
                  label: Text(s.impTemplateCsv),
                ),
                OutlinedButton.icon(
                  key: const ValueKey('imp-template-xlsx'),
                  onPressed: _busy ? null : () => _downloadTemplate('xlsx', year),
                  icon: const Icon(Icons.download_rounded),
                  label: Text(s.impTemplateExcel),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(s.impColumnsTitle, style: text.titleSmall),
            const SizedBox(height: 4),
            Text(s.impColumnsList, style: text.bodySmall),
          ],
        ),
      ),
    ),
    const SizedBox(height: 14),
    FilledButton.icon(
      key: const ValueKey('imp-pick'),
      onPressed: _busy ? null : _pick,
      icon: const Icon(Icons.upload_file_rounded),
      label: Text(s.impPick),
    ),
    const SizedBox(height: 8),
    Text(s.impPickHelp, textAlign: TextAlign.center, style: text.bodySmall),
  ];

  String _monthLabel(String ym) {
    final y = ym.substring(0, 4);
    final m = int.tryParse(ym.substring(5, 7)) ?? 1;
    return '${monthsShortMs[m - 1]} $y';
  }

  List<Widget> _review(S s, TextTheme text, String target, String? zone) {
    final p = _preview!;
    final file = _file!;
    final blocked = p.errors.isNotEmpty || (p.isOfficialHint && zone == null);
    final written = p.wouldInsert + p.wouldReplace;
    return [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              const Icon(Icons.description_outlined, color: SurauColors.teal, size: 28),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(file.name, style: text.titleSmall),
                    Text('sha256 ${(p.sha256 ?? '').padRight(8).substring(0, 8)}', style: text.bodySmall),
                  ],
                ),
              ),
              TextButton(onPressed: _busy ? null : _pick, child: Text(s.impPickOther)),
            ],
          ),
        ),
      ),
      if (p.sheets.length > 1) ...[
        const SizedBox(height: 12),
        PickerField(
          key: const ValueKey('imp-sheet'),
          label: s.impSheet,
          value: _sheet ?? p.sheets.first,
          onTap: () async {
            final v = await showPickerSheet<String>(
              context,
              title: s.impSheet,
              current: _sheet ?? p.sheets.first,
              items: [for (final x in p.sheets) PickerItem(value: x, title: x)],
            );
            if (v != null && mounted) {
              setState(() => _sheet = v);
              await _runPreview();
            }
          },
        ),
      ],
      const SizedBox(height: 12),
      if (p.isOfficialHint)
        InfoBox(child: Text(s.impEsolatDetected(zone ?? '')))
      else if (p.errors.isNotEmpty) ...[
        InfoBox(
          tone: InfoTone.red,
          icon: Icons.error_outline_rounded,
          child: Text(s.impErrors(p.errors.length), style: const TextStyle(fontWeight: FontWeight.w700)),
        ),
        const SizedBox(height: 12),
        SectionLabel(s.impErrorsTitle),
        Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < p.errors.length; i++) ...[
                if (i > 0) const Divider(),
                Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(width: 78, child: Text(s.impRow(p.errors[i].row), style: text.titleSmall)),
                      Expanded(child: Text(p.errors[i].message, style: text.bodyMedium)),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ] else ...[
        InfoBox(
          icon: Icons.check_circle_outline_rounded,
          child: Text(s.impClean(_total, shortDateMs(p.rangeFrom ?? ''), shortDateMs(p.rangeTo ?? ''))),
        ),
        if (p.columns.isNotEmpty) ...[
          const SizedBox(height: 12),
          SectionLabel(s.impDetectedColumns),
          Text(p.columns.join(', '), style: text.bodySmall),
        ],
        const SizedBox(height: 14),
        SectionLabel(s.impPerMonth),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final e in p.perMonth.entries)
              StateChip(
                label: '${_monthLabel(e.key)}: ${e.value}',
                background: SurauColors.tealSoft,
                foreground: SurauColors.teal,
              ),
          ],
        ),
        const SizedBox(height: 14),
        SectionLabel(s.impFirstWeek),
        MonthGrid(days: p.firstWeek, showStrip: false, dateLabel: _shortDay),
        const SizedBox(height: 12),
        SectionLabel(s.impLastWeek),
        MonthGrid(days: p.lastWeek, showStrip: false, dateLabel: _shortDay),
        if (p.fileShadowed) ...[
          const SizedBox(height: 14),
          InfoBox(
            key: const ValueKey('imp-file-unused'),
            tone: InfoTone.gold,
            icon: Icons.info_outline_rounded,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.impFileUnused),
                TextButton(
                  key: const ValueKey('imp-file-unused-link'),
                  onPressed: () => context.go(AppRoutes.settingsPrayerSources),
                  child: Text(s.srcTitle),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 14),
        SectionLabel(s.impOverlapTitle),
        Card(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  s.impOverlapCounts(p.overlaps['official'] ?? 0, p.overlaps['file'] ?? 0, p.overlaps['calc'] ?? 0),
                  style: text.bodyMedium,
                ),
                const SizedBox(height: 8),
                for (final (v, title, note) in [
                  ('replace', s.impOverlapReplace, s.impOverlapReplaceNote),
                  ('keep', s.impOverlapKeep, s.impOverlapKeepNote),
                  ('fillEmpty', s.impOverlapFill, s.impOverlapFillNote),
                ])
                  InkWell(
                    key: ValueKey('imp-overlap-$v'),
                    onTap: _busy
                        ? null
                        : () async {
                            setState(() => _overlap = v);
                            await _runPreview();
                          },
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Row(
                        children: [
                          Icon(
                            _overlap == v ? Icons.radio_button_checked_rounded : Icons.radio_button_unchecked_rounded,
                            color: _overlap == v ? SurauColors.teal : SurauColors.outline,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(title, style: text.titleSmall),
                                Text(note, style: text.bodySmall),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                const Divider(),
                const SizedBox(height: 6),
                Text(
                  s.impWouldWrite(written, p.wouldInsert, p.wouldReplace, p.wouldSkip),
                  style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ),
        ),
      ],
      const SizedBox(height: 16),
      FilledButton(
        key: const ValueKey('imp-save'),
        onPressed: blocked || _busy ? null : () => _confirmAndSave(target, zone),
        child: Text(s.impSave),
      ),
    ];
  }

  String _shortDay(ResolvedDay d) {
    final t = DateTime.parse(d.date);
    return '${t.day} ${monthsShortMs[t.month - 1]}';
  }
}
