// Waktu solat: how far ahead the box's prayer data for the surau's zone
// reaches (`daysAhead` from health, red when under a month), and the two
// ways to add a year: the box fetching it from e-Solat itself
// (`POST /api/prayer/import {zone, year, source: 'esolat'}`) or the
// person handing over the yearly CSV from the e-Solat site (`{zone,
// csv}`). The box answers with the rows it inserted and replaced, shown
// as `Ditambah n, diganti m`; health is re-read so the count moves.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../features/csv_file_pick.dart';
import '../features/data_sources.dart';
import '../features/prayer/day_sheet.dart';
import '../features/prayer/location_screen.dart';
import '../features/prayer/prayer_repository.dart';
import '../features/prayer/widgets/country_picker.dart';
import '../features/prayer/widgets/month_grid.dart';
import '../features/prayer_year.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String prayerImportPath = '/api/prayer/import';

/// Under this many days of data the count turns red with a nudge.
const int prayerDaysLow = 30;

/// Hands back the CSV text to send, or null when the person backed out.
typedef CsvPicker = Future<String?> Function(BuildContext context);

/// The zone from `GET /api/settings` (`zone.zone`), null when unknown.
String? zoneOf(Map<String, dynamic>? settings) {
  final z = settings?['zone'];
  if (z is Map && z['zone'] is String && (z['zone'] as String).isNotEmpty) {
    return z['zone'] as String;
  }
  return null;
}

class PrayerDataScreen extends ConsumerStatefulWidget {
  const PrayerDataScreen({super.key, this.csvPicker, this.csvFilePicker});

  /// A real file pick (web build); null uses the platform one, if any.
  final CsvFilePicker? csvFilePicker;

  /// A platform file picker, when one is wired; by default a sheet the
  /// person pastes the CSV into.
  final CsvPicker? csvPicker;

  @override
  ConsumerState<PrayerDataScreen> createState() => _PrayerDataScreenState();
}

class _PrayerDataScreenState extends ConsumerState<PrayerDataScreen> {
  String? _working;
  String? _error;
  (int inserted, int replaced)? _result;

  /// The year the admin picked; null follows the default.
  int? _pickedYear;

  PrayerStatus? _status;
  PrayerDays? _month;
  PrayerDays? _year;
  DateTime? _shownMonth;
  int? _shownYear;
  bool _yearView = false;
  bool _gridLoading = false;
  String? _gridError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _reloadGrid());
  }

  String get _todayIso {
    final fromBox = _status?.today?.date;
    if (fromBox != null && fromBox.isNotEmpty) return fromBox;
    final deps = ref.read(appDepsProvider);
    return isoDate(deps.toLocal(deps.now()));
  }

  String _monthEnd(DateTime m) => isoDate(DateTime.utc(m.year, m.month + 1, 0));

  /// Reads the status and whichever of month or year is on screen; every
  /// failure leaves the rest of the page working.
  Future<void> _reloadGrid() async {
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null || !mounted) return;
    final s = S.of(context);
    setState(() {
      _gridLoading = true;
      _gridError = null;
    });
    try {
      final status = await repo.status();
      if (!mounted) return;
      _status = status;
      final today = DateTime.parse(_todayIso);
      final month = _shownMonth ?? DateTime.utc(today.year, today.month);
      final year = _shownYear ?? today.year;
      final days = _yearView
          ? await repo.days('$year-01-01', '$year-12-31')
          : await repo.days(isoDate(month), _monthEnd(month));
      if (!mounted) return;
      setState(() {
        _shownMonth = month;
        _shownYear = year;
        if (_yearView) {
          _year = days;
        } else {
          _month = days;
        }
        _gridLoading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _gridLoading = false;
        _gridError = e is PrayerError ? e.message : s.pdLoadFailed;
      });
    }
  }

  void _stepMonth(int delta) {
    final m = _shownMonth;
    if (m == null) return;
    _shownMonth = DateTime.utc(m.year, m.month + delta);
    _reloadGrid();
  }

  Future<void> _openDay(ResolvedDay day) async {
    final changed = await showDaySheet(context, day);
    if (changed && mounted) await _reloadGrid();
  }

  Map<String, Map<String, int>> _flagsOf(PrayerDays? days) => {
    for (final f in days?.crossCheck.flagged ?? const <CrossFlag>[]) f.date: f.diffs,
  };

  String? _sourceLine(S t) {
    final today = _status?.today;
    if (today == null) return null;
    switch (today.source) {
      case 'official':
        final year = int.tryParse(today.date.substring(0, 4));
        final y = _status!.officialYears.where((e) => e.year == year).firstOrNull;
        return y?.fetchedAt == null ? t.pdSourceOfficial : t.pdSourceOfficialOn(shortDateMs(y!.fetchedAt!));
      case 'file':
        return t.pdSourceFile;
      default:
        return t.pdSourceCalc;
    }
  }

  List<Widget> _gridSection(S t, TextTheme text) {
    final month = _shownMonth;
    final flags = _flagsOf(_month);
    final flaggedCount = _month?.crossCheck.flagged.length ?? 0;
    return [
      Row(
        children: [
          Expanded(child: SectionLabel(t.pdDaysTitle)),
          SegmentedButton<bool>(
            key: const ValueKey('pd-view'),
            showSelectedIcon: false,
            segments: [
              ButtonSegment(value: false, label: Text(t.pdViewMonth)),
              ButtonSegment(value: true, label: Text(t.pdViewYear)),
            ],
            selected: {_yearView},
            onSelectionChanged: (v) {
              setState(() => _yearView = v.first);
              _reloadGrid();
            },
          ),
        ],
      ),
      const SizedBox(height: 8),
      SourceLegend(hasOfficial: _status?.hasOfficial ?? true, withFlag: !_yearView),
      const SizedBox(height: 10),
      if (_gridLoading) ...[const LinearProgressIndicator(minHeight: 2), const SizedBox(height: 8)],
      if (_gridError != null) ...[
        ErrorLine(_gridError!),
        const SizedBox(height: 8),
        OutlinedButton(onPressed: _reloadGrid, child: Text(t.actionRetry)),
      ],
      if (!_yearView && month != null) ...[
        if (flaggedCount > 0) ...[
          InfoBox(
            tone: InfoTone.gold,
            icon: Icons.warning_amber_rounded,
            child: Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(t.pdFlagged(flaggedCount)),
                TextButton(
                  onPressed: () => context.go(AppRoutes.settingsPrayerSources),
                  child: Text(t.pdAdjustLink),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],
        Row(
          children: [
            IconButton(
              key: const ValueKey('pd-prev'),
              tooltip: t.pdPrevMonth,
              icon: const Icon(Icons.chevron_left_rounded),
              color: SurauColors.teal,
              onPressed: () => _stepMonth(-1),
            ),
            Expanded(
              child: Text(
                '${monthsLongMs[month.month - 1]} ${month.year}',
                textAlign: TextAlign.center,
                style: text.titleMedium,
              ),
            ),
            IconButton(
              key: const ValueKey('pd-next'),
              tooltip: t.pdNextMonth,
              icon: const Icon(Icons.chevron_right_rounded),
              color: SurauColors.teal,
              onPressed: () => _stepMonth(1),
            ),
          ],
        ),
        const SizedBox(height: 6),
        if ((_month?.days ?? const []).isEmpty && !_gridLoading)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(t.pdMonthEmpty, textAlign: TextAlign.center, style: text.bodyMedium),
          )
        else
          MonthGrid(days: _month?.days ?? const [], flags: flags, today: _todayIso, onTapDay: _openDay),
        const SizedBox(height: 8),
        Text(t.pdTapHint, style: text.bodySmall),
      ],
      if (_yearView && _shownYear != null) ...[
        SegmentedButton<int>(
          key: const ValueKey('pd-year-pick'),
          showSelectedIcon: false,
          segments: [
            for (final y in [DateTime.parse(_todayIso).year, DateTime.parse(_todayIso).year + 1])
              ButtonSegment(value: y, label: Text('$y')),
          ],
          selected: {_shownYear!},
          onSelectionChanged: (v) {
            _shownYear = v.first;
            _reloadGrid();
          },
        ),
        const SizedBox(height: 10),
        YearGrid(
          year: _shownYear!,
          days: _year?.days ?? const [],
          today: _todayIso,
          onTapMonth: (m) {
            setState(() {
              _yearView = false;
              _shownMonth = DateTime.utc(_shownYear!, m);
            });
            _reloadGrid();
          },
        ),
      ],
    ];
  }

  Widget _links(S t) {
    Widget link(String key, IconData icon, String label, String route) => ListTile(
      key: ValueKey(key),
      leading: Icon(icon),
      title: Text(label),
      trailing: const Icon(Icons.chevron_right_rounded),
      onTap: () => context.go(route),
    );
    return RowsCard(
      children: [
        link('pd-link-import', Icons.upload_file_rounded, t.pdLinkImport, AppRoutes.prayerImport),
        link('pd-link-imports', Icons.history_rounded, t.pdLinkRecords, AppRoutes.prayerImports),
      ],
    );
  }

  /// Asks before loading over data the box already holds.
  Future<bool> _confirmReplace(int year) async {
    final t = S.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(t.prayerDataReplaceTitle),
        content: Text(t.prayerDataReplaceNote(year)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(t.actionCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(t.prayerDataReplaceAction),
          ),
        ],
      ),
    );
    return ok == true && mounted;
  }

  Future<void> _import(
    Map<String, Object> body,
    String workingText, {
    required int year,
    required bool replaces,
  }) async {
    final s = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null || _working != null) return;
    if (replaces && !await _confirmReplace(year)) return;
    setState(() {
      _working = workingText;
      _error = null;
      _result = null;
    });
    try {
      final out = await gateway.post(prayerImportPath, body);
      if (!mounted) return;
      setState(() {
        _working = null;
        _result = (
          (out['inserted'] as num?)?.toInt() ?? 0,
          (out['replaced'] as num?)?.toInt() ?? 0,
        );
      });
      await ref.read(healthProvider.notifier).refresh();
      await _reloadGrid();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _working = null;
        _error = writeErrorText(s, e);
      });
    }
  }

  Future<void> _uploadCsv(String zone, int year, bool replaces) async {
    final t = S.of(context);
    final picker = widget.csvPicker ?? _pasteSheet;
    final csv = await picker(context);
    if (csv == null || !mounted) return;
    await _import(
      {'zone': zone, 'csv': csv},
      t.prayerDataWorkingUpload,
      year: year,
      replaces: replaces,
    );
  }

  Future<String?> _pasteSheet(BuildContext context) =>
      showModalBottomSheet<String>(
        context: context,
        useSafeArea: true,
        isScrollControlled: true,
        constraints: const BoxConstraints(maxWidth: 520),
        builder: (context) => _PasteSheet(filePicker: widget.csvFilePicker),
      );

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final t = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    // The page can open before the signed-in connection is ready.
    ref.listen(prayerRepositoryProvider, (prev, next) {
      if (prev == null && next != null) _reloadGrid();
    });
    final health = ref.watch(healthProvider).value?.value;
    final settings = ref.watch(settingsProvider).value?.value;
    final zone = zoneOf(settings);
    final days = health?.daysAhead;
    final low = days != null && days > 0 && days < prayerDaysLow;
    final today = deps.toLocal(deps.now());
    final year =
        _pickedYear ?? defaultPrayerYear(daysAhead: days, today: today);
    final replaces = replacesExistingData(
      year: year,
      daysAhead: days,
      today: today,
    );
    final none = noDataThisYear(days);
    final canAct = zone != null && _working == null;
    final esolat = dataSourceName(settings, 'esolat');
    final sourceLine = _sourceLine(t);

    final left = <Widget>[
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        days == null ? '?' : '$days',
                        style: text.displayMedium!.copyWith(
                          color: low ? SurauColors.danger : SurauColors.teal,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Text(
                            days == null
                                ? t.prayerDataDaysUnknown
                                : t.prayerDataDaysAhead,
                            style: text.bodyLarge!.copyWith(
                              color: SurauColors.muted,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      if (zone != null)
                        StateChip(
                          label: t.prayerDataZone(zone),
                          background: SurauColors.tealSoft,
                          foreground: SurauColors.teal,
                        )
                      else
                        Text(t.prayerDataZoneUnknown, style: text.bodyMedium),
                    ],
                  ),
                  if (none || low) ...[
                    const SizedBox(height: 12),
                    Text(
                      none ? t.prayerDataNoYear(today.year) : t.prayerDataLow,
                      style: text.bodyMedium!.copyWith(
                        color: SurauColors.dangerInk,
                      ),
                    ),
                  ],
                  if (sourceLine != null) ...[
                    const SizedBox(height: 10),
                    Text(sourceLine, style: text.bodyMedium),
                  ],
                ],
              ),
            ),
          ),
          for (final w in _status?.warnings ?? const <String>[]) ...[
            const SizedBox(height: 10),
            InfoBox(tone: InfoTone.gold, icon: Icons.warning_amber_rounded, child: Text(w)),
          ],
          const SizedBox(height: 20),
          if (_working != null) ...[
            Card(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(_working!, style: text.titleSmall),
                    const SizedBox(height: 12),
                    const ClipRRect(
                      borderRadius: BorderRadius.all(Radius.circular(4)),
                      child: LinearProgressIndicator(minHeight: 8),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
          ],
          if (_result != null) ...[
            DoneLine(
              t.prayerDataResultTitle,
              detail: t.prayerDataResult(_result!.$1, _result!.$2),
            ),
            const SizedBox(height: 16),
          ],
          if (_error != null) ...[
            ErrorLine(_error!),
            const SizedBox(height: 16),
          ],
          SectionLabel(t.prayerDataUpdateTitle),
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(t.prayerDataYearChoose, style: text.titleSmall),
                  const SizedBox(height: 8),
                  SegmentedButton<int>(
                    key: const ValueKey('prayer-year'),
                    showSelectedIcon: false,
                    segments: [
                      for (final y in [today.year, today.year + 1])
                        ButtonSegment<int>(value: y, label: Text('$y')),
                    ],
                    selected: {year},
                    onSelectionChanged: (v) =>
                        setState(() => _pickedYear = v.first),
                  ),
                  const SizedBox(height: 10),
                  Text(t.prayerDataYearLine(year), style: text.bodyMedium),
                  if (replaces) ...[
                    const SizedBox(height: 6),
                    Text(
                      t.prayerDataReplaceNote(year),
                      style: text.bodySmall!.copyWith(
                        color: SurauColors.dangerInk,
                      ),
                    ),
                  ],
                  const SizedBox(height: 10),
                  FilledButton.icon(
                    onPressed: canAct
                        ? () => _import(
                            {'zone': zone, 'year': year, 'source': 'esolat'},
                            t.prayerDataWorkingFetch,
                            year: year,
                            replaces: replaces,
                          )
                        : null,
                    icon: const Icon(Icons.cloud_download_rounded),
                    label: Text(
                      t.fetchFromSource(esolat),
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(t.prayerDataFetchHint, style: text.bodySmall),
                  const SizedBox(height: 18),
                  OutlinedButton.icon(
                    onPressed: canAct
                        ? () => _uploadCsv(zone, year, replaces)
                        : null,
                    icon: const Icon(Icons.upload_file_rounded),
                    label: Text(t.prayerDataUploadCsv),
                  ),
                  const SizedBox(height: 8),
                  Text(t.prayerDataUploadHint, style: text.bodySmall),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          _links(t),
    ];
    final right = _gridSection(t, text);

    return ShellPage(
      title: s.navPrayerData,
      body: LayoutBuilder(
        builder: (context, c) {
          final wide = c.maxWidth >= 820;
          return ContentColumn(
            maxWidth: wide ? 1040 : SurauTheme.contentMaxWidth,
            child: ListView(
              padding: SurauTheme.pagePadding,
              children: wide
                  ? [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(flex: 4, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: left)),
                          const SizedBox(width: 24),
                          Expanded(flex: 5, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: right)),
                        ],
                      ),
                    ]
                  : [...left, const SizedBox(height: 20), ...right],
            ),
          );
        },
      ),
    );
  }
}

/// A big field to paste the e-Solat CSV into; pops the text, refuses
/// empty.
class _PasteSheet extends StatefulWidget {
  const _PasteSheet({this.filePicker});

  final CsvFilePicker? filePicker;

  @override
  State<_PasteSheet> createState() => _PasteSheetState();
}

class _PasteSheetState extends State<_PasteSheet> {
  final _csv = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _csv.dispose();
    super.dispose();
  }

  CsvFilePicker? get _picker =>
      widget.filePicker ?? (csvFilePickSupported ? pickCsvFile : null);

  Future<void> _pickFile() async {
    final t = S.of(context);
    final picked = await _picker!();
    if (picked == null || !mounted) return;
    if (picked.tooBig) {
      setState(() => _error = t.prayerDataFileTooBig);
    } else if (picked.unreadable || (picked.text ?? '').trim().isEmpty) {
      setState(
        () => _error = picked.unreadable
            ? t.prayerDataFileUnreadable
            : t.prayerDataPasteEmpty,
      );
    } else {
      Navigator.of(context).pop(picked.text);
    }
  }

  void _submit() {
    final t = S.of(context);
    if (_csv.text.trim().isEmpty) {
      setState(() => _error = t.prayerDataPasteEmpty);
      return;
    }
    Navigator.of(context).pop(_csv.text);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final t = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        4,
        20,
        24 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(t.prayerDataPasteTitle, style: text.titleLarge),
          const SizedBox(height: 4),
          Text(
            t.prayerDataPasteHint,
            style: text.bodyMedium!.copyWith(color: SurauColors.muted),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _csv,
            autofocus: true,
            minLines: 6,
            maxLines: 10,
            keyboardType: TextInputType.multiline,
            autocorrect: false,
            enableSuggestions: false,
            style: text.bodyMedium!.copyWith(
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
            decoration: InputDecoration(
              labelText: t.prayerDataPasteLabel,
              alignLabelWithHint: true,
            ),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorLine(_error!),
          ],
          const SizedBox(height: 20),
          if (_picker != null) ...[
            OutlinedButton.icon(
              onPressed: _pickFile,
              icon: const Icon(Icons.folder_open_rounded),
              label: Text(t.prayerDataPickFile),
            ),
            const SizedBox(height: 8),
          ],
          FilledButton(onPressed: _submit, child: Text(s.actionUpload)),
          const SizedBox(height: 4),
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(s.actionCancel),
          ),
        ],
      ),
    );
  }
}
