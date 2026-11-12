// Sumber waktu solat (Plan 13, mockup screen 2): which source wins each day,
// how the local calculation is set up, today's times side by side, and the
// cross-check with its suggested adjustment. Differences are source minus
// calculation after the saved adjustment, so the suggestion is the saved
// adjustment plus the median: pressing it twice changes nothing more.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import '../settings_form.dart' show copyJson;
import '../settings_repository.dart';
import '../shell/permissions.dart';
import 'location_screen.dart';
import 'prayer_repository.dart';
import 'widgets/country_picker.dart';
import 'widgets/order_list.dart';

const List<String> prayerKeys = ['imsak', 'subuh', 'syuruk', 'zohor', 'asar', 'maghrib', 'isyak'];

const Map<String, String> prayerNamesMs = {
  'imsak': 'Imsak',
  'subuh': 'Subuh',
  'syuruk': 'Syuruk',
  'zohor': 'Zohor',
  'asar': 'Asar',
  'maghrib': 'Maghrib',
  'isyak': 'Isyak',
};

/// `METHODS` of packages/core/src/prayer/methods.ts, in its order.
const Map<String, String> methodLabelsMs = {
  'mwl': 'Liga Dunia Islam',
  'egyptian': 'Mesir',
  'karachi': 'Karachi',
  'ummAlQura': 'Umm al-Qura',
  'dubai': 'Dubai',
  'qatar': 'Qatar',
  'kuwait': 'Kuwait',
  'moonsighting': 'Jawatankuasa Moonsighting',
  'singapore': 'Singapura',
  'tehran': 'Tehran',
  'turkey': 'Turki (Diyanet)',
  'northAmerica': 'Amerika Utara (ISNA)',
  'jakim': 'JAKIM 18/18',
  'kemenag': 'Kemenag Indonesia 20/18',
  'uoif': 'UOIF Perancis 12/12',
  'morocco': 'Maghribi 19/17',
  'algeria': 'Algeria 18/17',
  'russia': 'Rusia 16/15',
};

/// The difference above which a day is flagged (`CROSS_CHECK_MINUTES`).
const int crossCheckMinutes = 2;

/// Under this latitude the high-latitude rule changes nothing.
const double highLatitudeFrom = 48;

int _toMinutes(String t) => int.parse(t.substring(0, 2)) * 60 + int.parse(t.substring(3, 5));

String _signed(int v) => v > 0 ? '+$v' : '$v';

class SourcesScreen extends ConsumerWidget {
  const SourcesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final settings = ref.watch(settingsProvider).value?.value;
    return ShellPage(
      title: s.srcTitle,
      body: settings == null
          ? const LinearProgressIndicator(minHeight: 2)
          : _SourcesForm(
              settings: settings,
              readOnly: !canSee(ref.watch(rolesProvider), 'settings:write'),
            ),
    );
  }
}

class _SourcesForm extends ConsumerStatefulWidget {
  const _SourcesForm({required this.settings, required this.readOnly});

  final Map<String, dynamic> settings;
  final bool readOnly;

  @override
  ConsumerState<_SourcesForm> createState() => _SourcesFormState();
}

class _SourcesFormState extends ConsumerState<_SourcesForm> {
  late List<String> _order = List<String>.from(_savedSources['sourceOrder'] as List);
  late bool _cross = _savedSources['crossCheck'] != false;
  late String _method = _savedCalc['method'] as String;
  late String _madhab = _savedCalc['madhab'] as String;
  late String _high = _savedCalc['highLatitude'] as String;
  late Map<String, int> _adjust = _adjustOf(_savedCalc);
  late int _imsak = (_savedCalc['imsakMinutes'] as num).toInt();

  PrayerStatus? _status;
  PrayerDays? _days;
  ResolvedDay? _calcToday;
  CountryInfo? _countryInfo;
  String? _loadError;
  bool _loading = true;
  bool _busy = false;
  String? _error;

  Map<String, dynamic> get _savedSources => featureValues(widget.settings, 'prayerSources');
  Map<String, dynamic> get _savedCalc => featureValues(widget.settings, 'prayerCalc');
  Map<String, dynamic> get _location => featureValues(widget.settings, 'location');

  static Map<String, int> _adjustOf(Map<String, dynamic> calc) {
    final a = calc['adjustMinutes'];
    return {for (final p in prayerKeys) p: a is Map && a[p] is num ? (a[p] as num).toInt() : 0};
  }

  /// Whether the box has an official source for this country: the box says so (status), not a hard-coded country.
  bool get _hasOfficial => _status?.hasOfficial ?? _countryInfo?.hasOfficial ?? false;

  String get _today {
    final fromBox = _status?.today?.date;
    if (fromBox != null && fromBox.isNotEmpty) return fromBox;
    final deps = ref.read(appDepsProvider);
    return isoDate(deps.toLocal(deps.now()));
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null) return;
    final lang = S.of(context).localeName == 'en' ? 'en' : 'ms';
    try {
      final status = await repo.status();
      if (!mounted) return;
      _status = status;
      final today = _today;
      final month = today.substring(0, 7);
      final y = int.parse(month.substring(0, 4));
      final m = int.parse(month.substring(5, 7));
      final last = DateTime.utc(y, m + 1, 0).day.toString().padLeft(2, '0');
      final results = await Future.wait([
        repo.days('$month-01', '$month-$last'),
        repo.calcPreview(today),
        repo.countries(lang: lang),
      ]);
      if (!mounted) return;
      final countries = results[2] as List<CountryInfo>;
      setState(() {
        _days = results[0] as PrayerDays;
        _calcToday = results[1] as ResolvedDay?;
        _countryInfo = countries.where((c) => c.code == _location['country']).firstOrNull;
        _loading = false;
        _loadError = null;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _loadError = prayerErrorText(S.of(context), e);
        });
      }
    }
  }

  List<String> get _visibleOrder => _hasOfficial ? _order : _order.where((o) => o != 'official').toList();

  void _move(int index, int delta) {
    setState(() {
      final visible = _visibleOrder;
      final item = visible.removeAt(index);
      visible.insert(index + delta, item);
      // Outside Malaysia the official row is hidden and stays last.
      _order = _hasOfficial ? visible : [...visible, 'official'];
      _error = null;
    });
  }

  void _useSuggestion() {
    final median = _days?.crossCheck.medianDiff ?? const <String, int>{};
    final saved = _adjustOf(_savedCalc);
    setState(() {
      _adjust = {
        for (final p in prayerKeys) p: (saved[p]! + (median[p] ?? 0)).clamp(-30, 30),
      };
    });
  }

  Future<void> _save() async {
    final s = S.of(context);
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null || _busy) return;
    final sources = diffPatch(_savedSources, {'sourceOrder': _order, 'crossCheck': _cross});
    final calc = diffPatch(_savedCalc, {
      'method': _method,
      'madhab': _madhab,
      'highLatitude': _high,
      'adjustMinutes': _adjust,
      'imsakMinutes': _imsak,
    });
    if (sources.isEmpty && calc.isEmpty) {
      toast(context, s.locNoChange);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (sources.isNotEmpty) await repo.save('prayerSources', sources);
      if (calc.isNotEmpty) await repo.save('prayerCalc', copyJson(calc) as Map<String, dynamic>);
      if (!mounted) return;
      setState(() => _busy = false);
      toast(context, s.srcSaved);
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = prayerErrorText(s, e);
      });
    }
  }

  String _methodLabel(S s, String key) {
    if (key != 'auto') return methodLabelsMs[key] ?? key;
    final def = _countryInfo?.method;
    return def == null ? s.srcMethodAuto : s.srcMethodAutoNamed(methodLabelsMs[def] ?? def);
  }

  String _madhabName(S s, String? key) => key == 'hanafi' ? s.srcMadhabHanafi : s.srcMadhabShafi;

  Future<void> _pickMethod() async {
    final s = S.of(context);
    final picked = await showPickerSheet<String>(
      context,
      title: s.srcMethod,
      current: _method,
      items: [
        PickerItem(value: 'auto', title: _methodLabel(s, 'auto')),
        for (final e in methodLabelsMs.entries) PickerItem(value: e.key, title: e.value),
      ],
    );
    if (picked != null && mounted) setState(() => _method = picked);
  }

  String _highLabel(S s, String key) => switch (key) {
    'middleOfNight' => s.srcHighMiddle,
    'seventhOfNight' => s.srcHighSeventh,
    'twilightAngle' => s.srcHighTwilight,
    _ => s.srcHighAuto,
  };

  Future<void> _pickHigh() async {
    final s = S.of(context);
    final picked = await showPickerSheet<String>(
      context,
      title: s.srcHigh,
      current: _high,
      items: [
        for (final k in const ['auto', 'middleOfNight', 'seventhOfNight', 'twilightAngle'])
          PickerItem(value: k, title: _highLabel(s, k)),
      ],
    );
    if (picked != null && mounted) setState(() => _high = picked);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return LayoutBuilder(
      builder: (context, c) {
        final wide = c.maxWidth >= 820;
        final left = _left(s, text);
        final right = _right(s, text);
        return ContentColumn(
          maxWidth: wide ? 1040 : SurauTheme.contentMaxWidth,
          child: ListView(
            padding: SurauTheme.pagePadding,
            children: wide
                ? [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: left)),
                        const SizedBox(width: 24),
                        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: right)),
                      ],
                    ),
                  ]
                : [...left, const SizedBox(height: 20), ...right],
          ),
        );
      },
    );
  }

  List<Widget> _left(S s, TextTheme text) {
    final write = !widget.readOnly;
    final latitude = _location['latitude'];
    final highApplies = latitude is num && latitude.abs() >= highLatitudeFrom;
    final officialYear = _status?.officialYears.isEmpty ?? true ? null : _status!.officialYears.last;
    OrderEntry entry(String id) => switch (id) {
      'official' => OrderEntry(
        id: id,
        title: s.srcOfficial,
        detail: s.srcOfficialDetail(_status?.zone ?? ''),
        note: officialYear == null
            ? s.srcOfficialNone
            : officialYear.fetchedAt == null
            ? s.srcOfficialStored('${officialYear.year}')
            : s.srcOfficialFetched('${officialYear.year}', shortDateMs(officialYear.fetchedAt!)),
      ),
      'calc' => OrderEntry(
        id: id,
        title: s.srcCalc,
        detail: '${_methodLabel(s, _method)}, ${_madhabName(s, _madhab == 'auto' ? _countryInfo?.madhab : _madhab)}',
        note: s.srcCalcNote,
      ),
      _ => OrderEntry(
        id: id,
        title: s.srcFile,
        detail: s.srcFileDetail,
        note: (_status?.daysFile ?? 0) > 0 ? s.srcFileDays(_status!.daysFile) : s.srcFileNone,
      ),
    };
    return [
      if (_loading) ...[const LinearProgressIndicator(minHeight: 2), const SizedBox(height: 12)],
      if (_loadError != null) ...[ErrorLine(_loadError!), const SizedBox(height: 12)],
      SectionLabel(s.srcOrderTitle),
      OrderList(entries: [for (final id in _visibleOrder) entry(id)], onMove: write ? _move : null),
      const SizedBox(height: 8),
      Text(_hasOfficial ? s.srcOrderHelpMy : s.srcOrderHelp, style: text.bodySmall),
      if (_hasOfficial && _order.first != 'official') ...[
        const SizedBox(height: 10),
        InfoBox(
          tone: InfoTone.red,
          icon: Icons.warning_amber_rounded,
          child: Text(s.srcOfficialNotFirst),
        ),
      ],
      const SizedBox(height: 20),
      SectionLabel(s.srcCalc),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              PickerField(
                key: const ValueKey('src-method'),
                label: s.srcMethod,
                value: _methodLabel(s, _method),
                onTap: write ? _pickMethod : null,
              ),
              const SizedBox(height: 16),
              Text(s.srcMadhab, style: text.titleSmall),
              const SizedBox(height: 6),
              SegmentedButton<String>(
                key: const ValueKey('src-madhab'),
                showSelectedIcon: false,
                segments: [
                  ButtonSegment(value: 'auto', label: Text(s.srcMadhabAuto)),
                  ButtonSegment(value: 'shafi', label: Text(s.srcMadhabShafi)),
                  ButtonSegment(value: 'hanafi', label: Text(s.srcMadhabHanafi)),
                ],
                selected: {_madhab},
                onSelectionChanged: write ? (v) => setState(() => _madhab = v.first) : null,
              ),
              const SizedBox(height: 16),
              PickerField(
                key: const ValueKey('src-highlat'),
                label: s.srcHigh,
                value: _highLabel(s, _high),
                sub: highApplies ? null : s.srcHighNoEffect,
                dimmed: !highApplies,
                onTap: write && highApplies ? _pickHigh : null,
              ),
              const SizedBox(height: 18),
              Row(
                children: [
                  Expanded(child: Text(s.srcAdjustTitle, style: text.titleSmall)),
                  if (write)
                    TextButton(
                      key: const ValueKey('src-adj-clear'),
                      onPressed: () => setState(() => _adjust = {for (final p in prayerKeys) p: 0}),
                      child: Text(s.srcAdjustClear),
                    ),
                ],
              ),
              for (final p in prayerKeys)
                _stepperRow(
                  label: prayerNamesMs[p]!,
                  id: 'src-adj-$p',
                  value: _adjust[p]!,
                  min: -30,
                  max: 30,
                  shown: _signed(_adjust[p]!),
                  onChanged: write ? (v) => setState(() => _adjust = {..._adjust, p: v}) : null,
                ),
              const Divider(height: 24),
              _stepperRow(
                label: s.srcImsakMinutes,
                id: 'src-imsak',
                value: _imsak,
                min: 5,
                max: 20,
                shown: s.srcMinutes(_imsak),
                onChanged: write ? (v) => setState(() => _imsak = v) : null,
              ),
            ],
          ),
        ),
      ),
    ];
  }

  Widget _stepperRow({
    required String label,
    required String id,
    required int value,
    required int min,
    required int max,
    required String shown,
    required ValueChanged<int>? onChanged,
  }) {
    final text = Theme.of(context).textTheme;
    final s = S.of(context);
    final set = onChanged;
    return Row(
      children: [
        Expanded(child: Text(label, style: text.bodyLarge)),
        IconButton(
          key: ValueKey('$id-minus'),
          tooltip: s.srcLess,
          icon: const Icon(Icons.remove_rounded),
          color: SurauColors.teal,
          onPressed: set == null || value <= min ? null : () => set(value - 1),
        ),
        SizedBox(
          width: 64,
          child: Text(
            shown,
            key: ValueKey('$id-value'),
            textAlign: TextAlign.center,
            style: text.titleSmall!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
          ),
        ),
        IconButton(
          key: ValueKey('$id-plus'),
          tooltip: s.srcMore,
          icon: const Icon(Icons.add_rounded),
          color: SurauColors.teal,
          onPressed: set == null || value >= max ? null : () => set(value + 1),
        ),
      ],
    );
  }

  List<Widget> _right(S s, TextTheme text) {
    final days = _days;
    final today = _today;
    final first = days?.days.where((d) => d.date == today).firstOrNull;
    final y = int.parse(today.substring(0, 4));
    final m = int.parse(today.substring(5, 7));
    final d = int.parse(today.substring(8, 10));
    return [
      SectionLabel(s.srcPreviewTitle('$d ${monthsLongMs[m - 1]} $y')),
      Card(child: _previewTable(s, text, first)),
      const SizedBox(height: 20),
      SectionLabel(s.srcCrossTitle),
      Card(child: _crossBlock(s, text, days, '${monthsLongMs[m - 1]} $y')),
      if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
      if (!widget.readOnly) ...[
        const SizedBox(height: 16),
        FilledButton(
          key: const ValueKey('src-save'),
          onPressed: _busy ? null : _save,
          child: Text(s.srcSave),
        ),
      ],
    ];
  }

  Widget _previewTable(S s, TextTheme text, ResolvedDay? first) {
    final calc = _calcToday;
    if (first == null && calc == null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Text(s.srcPreviewNone, style: text.bodyMedium),
      );
    }
    final firstName = switch (first?.source) {
      'official' => 'JAKIM ${_status?.zone ?? ''}'.trim(),
      'file' => s.srcFile,
      'calc' => s.srcCalcShort,
      _ => '',
    };
    final head = text.labelMedium!.copyWith(color: SurauColors.muted);
    final num = text.bodyMedium!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]);
    Widget cell(Widget c, {bool end = false}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 6),
      child: Align(alignment: end ? Alignment.centerRight : Alignment.centerLeft, child: c),
    );
    Widget row(List<Widget> cells, {Key? key}) => Padding(
      key: key,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        children: [
          Expanded(flex: 4, child: cells[0]),
          Expanded(flex: 4, child: cells[1]),
          Expanded(flex: 3, child: cells[2]),
          Expanded(flex: 2, child: cells[3]),
        ],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 6),
        row([
          cell(Text(s.srcPreviewPrayer, style: head)),
          cell(Text(firstName, style: head, maxLines: 1, overflow: TextOverflow.ellipsis)),
          cell(Text(s.srcCalcShort, style: head)),
          cell(Text(s.srcPreviewDiff, style: head), end: true),
        ]),
        const Divider(),
        for (final p in prayerKeys) _previewRow(p, first, calc, row, cell, num),
        const Divider(),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Text(s.srcPreviewNote, style: text.bodySmall),
        ),
      ],
    );
  }

  Widget _previewRow(
    String p,
    ResolvedDay? first,
    ResolvedDay? calc,
    Widget Function(List<Widget>, {Key? key}) row,
    Widget Function(Widget, {bool end}) cell,
    TextStyle num,
  ) {
    final a = first?.times[p];
    final b = calc?.times[p];
    final diff = a != null && b != null ? _toMinutes(a) - _toMinutes(b) : null;
    final over = diff != null && diff.abs() > crossCheckMinutes;
    return row(key: ValueKey('src-preview-$p'), [
      cell(Text(prayerNamesMs[p]!, style: num.copyWith(fontWeight: FontWeight.w600))),
      cell(Text(a ?? '-', style: num.copyWith(fontWeight: FontWeight.w700))),
      cell(Text(b ?? '-', style: num)),
      cell(
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
          decoration: over ? BoxDecoration(color: flagBackground, borderRadius: BorderRadius.circular(5)) : null,
          child: Text(
            diff == null ? '-' : _signed(diff),
            style: num.copyWith(
              color: over ? flagInk : (diff == 0 ? SurauColors.muted : SurauColors.text),
              fontWeight: over ? FontWeight.w700 : FontWeight.w400,
            ),
          ),
        ),
        end: true,
      ),
    ]);
  }

  Widget _crossBlock(S s, TextTheme text, PrayerDays? days, String monthWords) {
    final cross = days?.crossCheck;
    final write = !widget.readOnly;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 12, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.srcCrossToggle, style: text.titleSmall),
                    Text(s.srcCrossHelp, style: text.bodySmall),
                  ],
                ),
              ),
              Switch(
                key: const ValueKey('src-cross'),
                value: _cross,
                onChanged: write ? (v) => setState(() => _cross = v) : null,
              ),
            ],
          ),
          if (_cross && cross != null && cross.compared == 0) ...[
            const SizedBox(height: 8),
            Text(s.srcCrossNone, style: text.bodyMedium),
          ],
          if (_cross && cross != null && cross.compared > 0) ...[
            const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text('${cross.flagged.length}', style: text.displaySmall!.copyWith(color: SurauColors.teal)),
                const SizedBox(width: 10),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 5),
                    child: Text(s.srcCrossFlagged(monthWords), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(s.srcCrossLargest, style: text.titleSmall),
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final p in prayerKeys)
                  StateChip(
                    label: '${prayerNamesMs[p]} ${cross.maxDiff[p] ?? 0}',
                    background: (cross.maxDiff[p] ?? 0) > crossCheckMinutes ? SurauColors.goldSoft : SurauColors.paperDeep,
                    foreground: (cross.maxDiff[p] ?? 0) > crossCheckMinutes ? SurauColors.ink : SurauColors.muted,
                  ),
              ],
            ),
            const SizedBox(height: 12),
            if (cross.flagged.isEmpty)
              Row(
                children: [
                  const Icon(Icons.check_circle_outline_rounded, color: SurauColors.teal, size: 20),
                  const SizedBox(width: 8),
                  Expanded(child: Text(s.srcCrossOk, style: text.bodyMedium)),
                ],
              )
            else if (write) ...[
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  key: const ValueKey('src-suggest'),
                  onPressed: _useSuggestion,
                  icon: const Icon(Icons.tune_rounded),
                  label: Text(s.srcUseSuggestion),
                ),
              ),
              const SizedBox(height: 6),
              Text(s.srcSuggestionNote, style: text.bodySmall),
            ],
          ],
        ],
      ),
    );
  }
}

/// A difference over the limit: the mockup's `.fl`.
const Color flagBackground = Color(0xFFFFF6DB);
const Color flagInk = Color(0xFF8A5B00);
