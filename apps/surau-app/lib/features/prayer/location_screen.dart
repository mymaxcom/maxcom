// Lokasi surau (Plan 13, mockup screen 1): country, time zone, and the place
// found by search or typed as coordinates. The box does the search, once per
// press of Cari. Outside Malaysia the save waits for coordinates, because
// prayer times there are calculated. Inside it, the nearest JAKIM zone is
// suggested and only applied when the admin presses Guna.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart';
import '../../screens/widgets/pieces.dart';
import '../settings_form.dart' show copyJson;
import '../settings_repository.dart';
import '../shell/permissions.dart';
import '../validate.dart' show featureByKey;
import 'prayer_repository.dart';
import 'widgets/coordinate_fields.dart';
import 'widgets/country_picker.dart';

/// Null until unlocked. Every prayer-source screen reads the box through it.
final prayerRepositoryProvider = Provider<PrayerRepository?>((ref) {
  final gateway = ref.watch(gatewayProvider);
  return gateway == null ? null : PrayerRepository(gateway);
});

/// The feature's settings from the box over its registry defaults (deep),
/// without `enabled`: what a prayer form edits and diffs against.
Map<String, dynamic> featureValues(Map<String, dynamic>? settings, String key) {
  Object? merge(Object? d, Object? b) {
    if (d is Map) {
      return <String, dynamic>{
        for (final e in d.entries)
          e.key as String: b is Map && b.containsKey(e.key) ? merge(e.value, b[e.key]) : copyJson(e.value),
      };
    }
    return copyJson(b);
  }

  final box = settings?[key];
  return merge(featureByKey(key)?.defaults ?? const {}, box is Map ? box : const {}) as Map<String, dynamic>;
}

/// The text of a failed write or search, in the person's language.
String prayerErrorText(S s, Object e) => switch (e) {
  PrayerError(:final message) => message,
  SettingsSaveError(:final message) => message,
  _ => writeErrorText(s, e),
};

const List<String> monthsShortMs = ['Jan', 'Feb', 'Mac', 'Apr', 'Mei', 'Jun', 'Jul', 'Ogos', 'Sep', 'Okt', 'Nov', 'Dis'];

const List<String> monthsLongMs = [
  'Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun', 'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember',
];

/// `2026-11-06` as `6 Nov 2026`.
String shortDateMs(String iso) {
  final d = DateTime.tryParse(iso);
  return d == null ? iso : '${d.day} ${monthsShortMs[d.month - 1]} ${d.year}';
}

/// [t] (UTC or local) as `yyyy-mm-dd` of its own fields.
String isoDate(DateTime t) =>
    '${t.year.toString().padLeft(4, '0')}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}';

double _haversineKm(double aLat, double aLon, double bLat, double bLon) {
  double rad(double d) => d * math.pi / 180;
  final dLat = rad(bLat - aLat);
  final dLon = rad(bLon - aLon);
  final h = math.pow(math.sin(dLat / 2), 2) + math.cos(rad(aLat)) * math.cos(rad(bLat)) * math.pow(math.sin(dLon / 2), 2);
  return 2 * 6371 * math.asin(math.sqrt(h));
}

/// How far a zone's centre may be and still be suggested (as the box does).
const double zoneSuggestMaxKm = 150;

/// The zone whose centre is nearest the coordinates; null when none is near.
ZoneInfo? nearestZone(List<ZoneInfo> zones, double lat, double lon) {
  ZoneInfo? best;
  var bestKm = double.infinity;
  for (final z in zones) {
    if (z.removed || z.lat == null || z.lon == null) continue;
    final km = _haversineKm(lat, lon, z.lat!, z.lon!);
    if (km < bestKm) {
      best = z;
      bestKm = km;
    }
  }
  return bestKm <= zoneSuggestMaxKm ? best : null;
}

class LocationScreen extends ConsumerWidget {
  const LocationScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final settings = ref.watch(settingsProvider).value?.value;
    return ShellPage(
      title: s.locTitle,
      body: settings == null
          ? const LinearProgressIndicator(minHeight: 2)
          : _LocationForm(
              settings: settings,
              readOnly: !canSee(ref.watch(rolesProvider), 'settings:write'),
            ),
    );
  }
}

enum _Mode { search, coordinates }

class _LocationForm extends ConsumerStatefulWidget {
  const _LocationForm({required this.settings, required this.readOnly});

  final Map<String, dynamic> settings;
  final bool readOnly;

  @override
  ConsumerState<_LocationForm> createState() => _LocationFormState();
}

class _LocationFormState extends ConsumerState<_LocationForm> {
  late final Map<String, dynamic> _start = featureValues(widget.settings, 'location');
  late String _country = _start['country'] as String? ?? 'MY';
  late String _timezone = _start['timezone'] as String? ?? 'Asia/Kuala_Lumpur';
  late final _city = TextEditingController(text: _start['city'] as String? ?? '');
  late final _latitude = TextEditingController(
    text: _start['latitude'] is num ? formatCoordinate(_start['latitude'] as num) : '',
  );
  late final _longitude = TextEditingController(
    text: _start['longitude'] is num ? formatCoordinate(_start['longitude'] as num) : '',
  );
  final _query = TextEditingController();

  List<CountryInfo> _countries = const [];
  List<ZoneInfo> _zones = const [];
  // Set once the person picks a zone; coordinates stop suggesting after that.
  bool _zonePicked = false;
  int _zoneAsk = 0;
  _Mode _mode = _Mode.search;
  List<LocationHit>? _hits;
  String? _attribution;
  int? _pickedHit;
  bool _searching = false;
  String? _searchError;
  bool _offline = false;
  bool _busy = false;
  String? _error;
  String? _loadError;

  bool get _inMalaysia => _country == 'MY';

  String? get _savedZone {
    final z = widget.settings['zone'];
    return z is Map && z['zone'] is String ? z['zone'] as String : null;
  }

  double? get _lat => parseLatitude(_latitude.text);
  double? get _lon => parseLongitude(_longitude.text);
  bool get _located => _lat != null && _lon != null;
  bool get _coordinatesBlank => _latitude.text.trim().isEmpty && _longitude.text.trim().isEmpty;

  /// Malaysia may save with no coordinates (JAKIM needs none); elsewhere
  /// they are mandatory; half-typed or wrong ones never save.
  bool get _canSave => _located || (_inMalaysia && _coordinatesBlank);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _city.dispose();
    _latitude.dispose();
    _longitude.dispose();
    _query.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null) return;
    try {
      final countries = await repo.countries(lang: S.of(context).localeName == 'en' ? 'en' : 'ms');
      if (mounted) setState(() => _countries = countries);
    } catch (e) {
      if (mounted) setState(() => _loadError = prayerErrorText(S.of(context), e));
    }
    try {
      final list = await repo.zones();
      if (mounted) setState(() => _zones = list.zones);
    } catch (_) {
      // The suggestion is a help, not a need: the page works without it.
    }
  }

  List<String> get _countryZones =>
      _countries.where((c) => c.code == _country).firstOrNull?.timezones ?? const [];

  void _setCountry(String code, {bool keepPlace = false}) {
    setState(() {
      if (code != _country && !keepPlace) {
        // Coordinates and the town belong to the old country.
        _latitude.clear();
        _longitude.clear();
        _city.clear();
        _hits = null;
        _pickedHit = null;
      }
      _country = code;
      final zones = _countryZones;
      if (zones.isNotEmpty && !zones.contains(_timezone)) _timezone = zones.first;
      _error = null;
    });
  }

  Future<void> _pickTimezone() async {
    final s = S.of(context);
    final own = _countryZones;
    final others = {for (final c in _countries) ...c.timezones}.difference(own.toSet()).toList()..sort();
    final picked = await showPickerSheet<String>(
      context,
      title: s.locTimezone,
      current: _timezone,
      searchHint: s.locTimezoneSearch,
      items: [
        for (final z in own) PickerItem(value: z, title: z, group: s.locTimezoneOwn),
        for (final z in others) PickerItem(value: z, title: z, group: s.locTimezoneOther),
      ],
    );
    if (picked != null && mounted) {
      setState(() {
        _timezone = picked;
        _zonePicked = true;
      });
    }
  }

  /// Preselect the zone of the country that fits the longitude, for a country
  /// with several zones, until the person picks one themselves.
  Future<void> _suggestZone() async {
    final repo = ref.read(prayerRepositoryProvider);
    final lat = _lat;
    final lon = _lon;
    if (repo == null || _zonePicked || lat == null || lon == null || _countryZones.length < 2) return;
    final country = _country;
    final ask = ++_zoneAsk;
    final zone = await repo.suggestTimezone(country, lon);
    if (!mounted || zone == null || ask != _zoneAsk || _zonePicked || country != _country) return;
    if (_countryZones.contains(zone) && zone != _timezone) setState(() => _timezone = zone);
  }

  Future<void> _search() async {
    final s = S.of(context);
    final q = _query.text.trim();
    final repo = ref.read(prayerRepositoryProvider);
    if (q.isEmpty || repo == null || _searching) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _searching = true;
      _searchError = null;
      _offline = false;
      _hits = null;
      _pickedHit = null;
    });
    try {
      final found = await repo.searchLocation(q);
      if (!mounted) return;
      setState(() {
        _searching = false;
        _hits = found.results;
        _attribution = found.attribution;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _searching = false;
        _searchError = prayerErrorText(s, e);
        if (e is PrayerError && e.kind == PrayerFailure.offline) {
          _offline = true;
          _mode = _Mode.coordinates;
        }
      });
    }
  }

  void _useHit(int index) {
    final hit = _hits![index];
    final code = hit.country?.toUpperCase();
    if (code != null && code != _country && _countries.any((c) => c.code == code)) {
      _setCountry(code, keepPlace: true);
    }
    setState(() {
      _pickedHit = index;
      _latitude.text = formatCoordinate(hit.lat);
      _longitude.text = formatCoordinate(hit.lon);
      _city.text = hit.city ?? hit.label.split(',').first.trim();
      _error = null;
    });
    _suggestZone();
  }

  Future<void> _save() async {
    final s = S.of(context);
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null || !_canSave || _busy) return;
    final patch = diffPatch(_saved, {
      'country': _country,
      'timezone': _timezone,
      'latitude': _lat,
      'longitude': _lon,
      'city': _city.text.trim(),
    });
    if (patch.isEmpty) {
      toast(context, s.locNoChange);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await repo.save('location', patch);
      if (!mounted) return;
      setState(() => _busy = false);
      toast(context, s.locSaved);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = prayerErrorText(s, e);
      });
    }
  }

  Map<String, dynamic> get _saved => featureValues(widget.settings, 'location');

  Future<void> _useZone(String code) async {
    final s = S.of(context);
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null || _busy) return;
    setState(() => _busy = true);
    try {
      final all = await repo.save('zone', {'zone': code});
      if (!mounted) return;
      setState(() => _busy = false);
      final warnings = all['warnings'];
      toast(context, warnings is List && warnings.isNotEmpty ? '${warnings.first}' : s.locZoneUsed(code));
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
    final write = !widget.readOnly;
    final country = _countries.where((c) => c.code == _country).firstOrNull;
    final zones = _countryZones;
    final suggested = _inMalaysia && _located ? nearestZone(_zones, _lat!, _lon!) : null;
    return SurauTheme.page(
      children: [
        Text(_inMalaysia ? s.locIntroMy : s.locIntro, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        const SizedBox(height: 14),
        if (_loadError != null) ...[ErrorLine(_loadError!), const SizedBox(height: 12)],
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                CountryField(
                  key: const ValueKey('loc-country'),
                  countries: _countries,
                  code: _country,
                  onChanged: write ? _setCountry : null,
                ),
                const SizedBox(height: 16),
                PickerField(
                  key: const ValueKey('loc-timezone'),
                  label: s.locTimezone,
                  value: _timezone,
                  sub: zones.length > 1 ? s.locZonesCount(zones.length) : s.locTimezoneFromCountry,
                  onTap: write && _countries.isNotEmpty ? _pickTimezone : null,
                ),
                if (_inMalaysia) ...[
                  const SizedBox(height: 14),
                  Row(
                    key: const ValueKey('loc-zone-row'),
                    children: [
                      Expanded(
                        child: Text(
                          _savedZone == null ? s.locZoneNone : s.locZoneRow(_savedZone!),
                          style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
                        ),
                      ),
                      TextButton(
                        onPressed: () => context.go(AppRoutes.settingsZone),
                        child: Text(s.locChange),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
        if (write) ...[
          const SizedBox(height: 20),
          SectionLabel(s.locHowTitle),
          SegmentedButton<_Mode>(
            showSelectedIcon: false,
            segments: [
              ButtonSegment(value: _Mode.search, label: Text(s.locModeSearch)),
              ButtonSegment(value: _Mode.coordinates, label: Text(s.locModeCoordinates)),
            ],
            selected: {_mode},
            onSelectionChanged: (v) => setState(() => _mode = v.first),
          ),
          const SizedBox(height: 12),
          if (_mode == _Mode.search) ..._searchPanel(s, text) else ..._coordinatePanel(s, text),
        ],
        if (_located) ...[
          const SizedBox(height: 16),
          _summary(s, text, country),
        ],
        if (suggested != null && suggested.code != _savedZone && write) ...[
          const SizedBox(height: 12),
          InfoBox(
            tone: InfoTone.gold,
            icon: Icons.place_outlined,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.locSuggestTitle(suggested.code), style: const TextStyle(fontWeight: FontWeight.w700)),
                Text(suggested.name),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  children: [
                    FilledButton(
                      key: const ValueKey('loc-suggest-use'),
                      onPressed: _busy ? null : () => _useZone(suggested.code),
                      child: Text(s.locSuggestUse(suggested.code)),
                    ),
                    TextButton(
                      onPressed: () => context.go(AppRoutes.settingsZone),
                      child: Text(s.locSuggestOther),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
        if (!_inMalaysia && country != null) ...[
          const SizedBox(height: 12),
          InfoBox(child: Text(s.locNoOfficial(country.name))),
        ],
        const SizedBox(height: 12),
        InfoBox(
          tone: InfoTone.gold,
          icon: Icons.warning_amber_rounded,
          child: Text(s.locChangeWarning),
        ),
        if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
        if (write) ...[
          const SizedBox(height: 16),
          FilledButton(
            key: const ValueKey('loc-save'),
            onPressed: _canSave && !_busy ? _save : null,
            child: Text(s.locSave),
          ),
          if (!_canSave && !_inMalaysia) ...[
            const SizedBox(height: 8),
            Text(s.locNeedCoordinates, textAlign: TextAlign.center, style: text.bodyMedium!.copyWith(color: SurauColors.dangerInk)),
          ],
        ],
      ],
    );
  }

  List<Widget> _searchPanel(S s, TextTheme text) => [
    Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextField(
                    key: const ValueKey('loc-search'),
                    controller: _query,
                    textInputAction: TextInputAction.search,
                    decoration: InputDecoration(labelText: s.locSearchLabel, hintText: s.locSearchHint),
                    onSubmitted: (_) => _search(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const ValueKey('loc-search-go'),
                  onPressed: _searching ? null : _search,
                  style: FilledButton.styleFrom(minimumSize: const Size(72, 58), padding: const EdgeInsets.symmetric(horizontal: 14)),
                  child: Text(s.locSearchGo),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(s.locSearchHelp, style: text.bodySmall),
            if (_searching) ...[
              const SizedBox(height: 12),
              const LinearProgressIndicator(minHeight: 3),
            ],
            if (_searchError != null) ...[const SizedBox(height: 12), ErrorLine(_searchError!)],
          ],
        ),
      ),
    ),
    if (_hits != null) ...[
      const SizedBox(height: 12),
      SectionLabel(s.locResultsTitle(_hits!.length, _query.text.trim())),
      Card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < _hits!.length; i++) ...[
              if (i > 0) const Divider(),
              InkWell(
                onTap: () => _useHit(i),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 16, 12),
                  child: Row(
                    children: [
                      Icon(
                        _pickedHit == i ? Icons.radio_button_checked_rounded : Icons.radio_button_unchecked_rounded,
                        color: _pickedHit == i ? SurauColors.teal : SurauColors.outline,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(_hits![i].label, style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600)),
                            Text(
                              [
                                if (_hits![i].city != null) _hits![i].city!,
                                '${formatCoordinate(_hits![i].lat)}, ${formatCoordinate(_hits![i].lon)}',
                                if (_hits![i].country != null) _hits![i].country!,
                              ].join(', '),
                              style: text.bodySmall,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
            if (_hits!.isEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(s.locNoResults, style: text.bodyMedium),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: Text(_attribution ?? s.locAttribution, style: text.bodySmall),
            ),
          ],
        ),
      ),
    ],
  ];

  List<Widget> _coordinatePanel(S s, TextTheme text) => [
    if (_searchError != null) ...[ErrorLine(_searchError!), const SizedBox(height: 8)],
    if (_offline) ...[
      InfoBox(icon: Icons.wifi_off_rounded, child: Text(s.locOfflineHint)),
      const SizedBox(height: 12),
    ],
    Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            CoordinateFields(latitude: _latitude, longitude: _longitude, onChanged: () {
              setState(() {});
              _suggestZone();
            }),
            const SizedBox(height: 10),
            Text(s.locCoordinatesHelp, style: text.bodySmall),
          ],
        ),
      ),
    ),
  ];

  Widget _summary(S s, TextTheme text, CountryInfo? country) {
    Widget row(String k, String v) => Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 104, child: Text(k, style: text.bodySmall)),
          Expanded(child: Text(v, style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600))),
        ],
      ),
    );
    return Card(
      key: const ValueKey('loc-summary'),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.verified_outlined, color: SurauColors.teal),
                const SizedBox(width: 8),
                Text(s.locConfirmed, style: text.titleSmall),
              ],
            ),
            const SizedBox(height: 10),
            row(s.locCountry, country?.name ?? _country),
            row(s.locTimezone, _timezone),
            row(s.locCoordinates, '${formatCoordinate(_lat!)}, ${formatCoordinate(_lon!)}'),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('loc-city'),
              controller: _city,
              enabled: !widget.readOnly,
              maxLength: 80,
              decoration: InputDecoration(labelText: s.locCity, helperText: s.locCityHelp, counterText: ''),
            ),
          ],
        ),
      ),
    );
  }
}
