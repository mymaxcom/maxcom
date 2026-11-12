// Zon JAKIM (Plan 13, mockup screen 3): the zone list from e-Solat, by state,
// each with what this MAXCOM holds. A listed zone with no data is saved with
// a warning and fetched afterwards. A suggestion is never applied by itself.
// Malaysia only: elsewhere the page says so and offers nothing.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../features/common/time_words.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import '../settings_repository.dart';
import '../shell/permissions.dart';
import 'location_screen.dart';
import 'prayer_repository.dart';
import 'widgets/coordinate_fields.dart';
import 'widgets/country_picker.dart';

class ZoneScreen extends ConsumerStatefulWidget {
  const ZoneScreen({super.key});

  @override
  ConsumerState<ZoneScreen> createState() => _ZoneScreenState();
}

class _ZoneScreenState extends ConsumerState<ZoneScreen> {
  ZoneList? _list;
  String? _loadError;
  bool _loading = true;
  String? _pending;
  bool _busy = false;
  bool _refreshing = false;
  String? _error;
  String? _note;
  String? _saveWarning;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null) return;
    try {
      final list = await repo.zones();
      if (mounted) {
        setState(() {
          _list = list;
          _loading = false;
          _loadError = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loading = false;
          _loadError = prayerErrorText(S.of(context), e);
        });
      }
    }
  }

  String _tag(S s, ZoneInfo z) =>
      z.years.isEmpty ? s.zonNoData : s.zonHasData(z.years.join(', '));

  Future<void> _pick(String current, List<ZoneInfo> zones, ZoneInfo? suggested) async {
    final s = S.of(context);
    PickerItem<String> item(ZoneInfo z, String group) => PickerItem(
      value: z.code,
      title: z.code,
      subtitle: z.name,
      group: group,
      tag: _tag(s, z),
      tagStrong: z.years.isNotEmpty,
    );
    final picked = await showPickerSheet<String>(
      context,
      title: s.zonField,
      current: _pending ?? current,
      searchHint: s.zonSearch,
      pinned: [if (suggested != null) item(suggested, s.zonSuggestedGroup)],
      items: [for (final z in zones) if (!z.removed) item(z, z.state ?? z.code.substring(0, 3))],
    );
    if (picked == null || !mounted) return;
    setState(() {
      _pending = picked == current ? null : picked;
      _error = null;
      _note = null;
      _saveWarning = null;
    });
  }

  Future<void> _save() async {
    final s = S.of(context);
    final code = _pending;
    final repo = ref.read(settingsRepositoryProvider);
    if (code == null || repo == null || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _note = null;
      _saveWarning = null;
    });
    try {
      final all = await repo.save('zone', {'zone': code});
      if (!mounted) return;
      final warnings = all['warnings'];
      setState(() {
        _busy = false;
        _pending = null;
        if (warnings is List && warnings.isNotEmpty) {
          _saveWarning = '${warnings.first}';
        } else {
          _note = s.zonSaved(code);
        }
      });
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = prayerErrorText(s, e);
      });
    }
  }

  Future<void> _refresh() async {
    final s = S.of(context);
    final repo = ref.read(prayerRepositoryProvider);
    if (repo == null || _refreshing) return;
    setState(() {
      _refreshing = true;
      _error = null;
      _note = null;
    });
    try {
      final out = await repo.refreshZones();
      if (!mounted) return;
      setState(() {
        _refreshing = false;
        _note = s.zonRefreshed(out.count);
      });
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _refreshing = false;
        _error = prayerErrorText(s, e);
      });
    }
  }

  String _when(String iso) {
    final deps = ref.read(appDepsProvider);
    final t = DateTime.tryParse(iso);
    if (t == null) return iso;
    final local = deps.toLocal(t);
    return '${shortDateMs(isoDate(local))}, ${timeOfDayWords(local)}';
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final settings = ref.watch(settingsProvider).value?.value;
    final canWrite = canSee(ref.watch(rolesProvider), 'settings:write');
    final location = featureValues(settings, 'location');
    final Widget body;
    if (settings == null || (_loading && _list == null && location['country'] == 'MY')) {
      body = const LinearProgressIndicator(minHeight: 2);
    } else if (location['country'] != 'MY') {
      body = SurauTheme.page(
        children: [
          InfoBox(child: Text(s.zonMalaysiaOnly)),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: () => context.go(AppRoutes.settingsLocation), child: Text(s.locTitle)),
        ],
      );
    } else {
      body = _form(s, text, settings, location, canWrite);
    }
    return ShellPage(title: s.zonTitle, body: body);
  }

  Widget _form(S s, TextTheme text, Map<String, dynamic> settings, Map<String, dynamic> location, bool canWrite) {
    final zoneSetting = settings['zone'];
    final current = zoneSetting is Map && zoneSetting['zone'] is String ? zoneSetting['zone'] as String : '';
    final zones = _list?.zones ?? const <ZoneInfo>[];
    ZoneInfo? find(String code) => zones.where((z) => z.code == code).firstOrNull;
    final shownCode = _pending ?? current;
    final shown = find(shownCode);
    final suggestCode = _list?.suggested?.code;
    final suggested = suggestCode == null ? null : find(suggestCode);
    final lat = location['latitude'];
    final lon = location['longitude'];
    final city = (location['city'] as String? ?? '').trim();
    final place = lat is num && lon is num ? '${formatCoordinate(lat)}, ${formatCoordinate(lon)}' : s.zonNoCoordinates;
    final warning = _list?.warning;
    return SurauTheme.page(
      children: [
        if (_loadError != null) ...[ErrorLine(_loadError!), const SizedBox(height: 12)],
        if (warning != null) ...[
          InfoBox(tone: InfoTone.red, icon: Icons.warning_amber_rounded, child: Text(warning)),
          const SizedBox(height: 12),
        ],
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const Icon(Icons.place_outlined, color: SurauColors.teal, size: 26),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(city.isEmpty ? s.zonPlaceUnnamed : city, style: text.titleSmall),
                          Text('$place, Malaysia', style: text.bodySmall),
                        ],
                      ),
                    ),
                    TextButton(onPressed: () => context.go(AppRoutes.settingsLocation), child: Text(s.locChange)),
                  ],
                ),
                const SizedBox(height: 12),
                PickerField(
                  key: const ValueKey('zon-picker'),
                  label: s.zonField,
                  value: shown == null ? shownCode : '${shown.code}, ${shown.state ?? ''}',
                  sub: shown == null ? s.zonUnknown : '${shown.name}\n${_tag(s, shown)}',
                  onTap: canWrite && zones.isNotEmpty ? () => _pick(current, zones, suggested) : null,
                ),
              ],
            ),
          ),
        ),
        if (_pending != null && shown != null && shown.years.isEmpty) ...[
          const SizedBox(height: 12),
          InfoBox(tone: InfoTone.gold, child: Text(s.zonWillFetch(shown.code))),
        ],
        if (suggested != null && suggested.code != shownCode && canWrite) ...[
          const SizedBox(height: 12),
          InfoBox(
            tone: InfoTone.gold,
            icon: Icons.place_outlined,
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(s.zonSuggested(suggested.code), style: const TextStyle(fontWeight: FontWeight.w700)),
                      Text(suggested.name),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const ValueKey('zon-suggest-use'),
                  onPressed: () => setState(() {
                    _pending = suggested.code == current ? null : suggested.code;
                    _note = null;
                  }),
                  child: Text(s.zonUse),
                ),
              ],
            ),
          ),
        ],
        if (_saveWarning != null) ...[
          const SizedBox(height: 12),
          InfoBox(tone: InfoTone.gold, child: Text(_saveWarning!)),
        ],
        if (_note != null) ...[const SizedBox(height: 12), DoneLine(_note!)],
        if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
        if (canWrite) ...[
          const SizedBox(height: 14),
          FilledButton(
            key: const ValueKey('zon-save'),
            onPressed: _pending != null && !_busy ? _save : null,
            child: Text(s.zonSave),
          ),
        ],
        const SizedBox(height: 20),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(s.zonListTitle, style: text.titleSmall),
                const SizedBox(height: 4),
                Text(
                  _list?.fetchedAt == null
                      ? s.zonListCount(zones.where((z) => !z.removed).length)
                      : s.zonListMeta(zones.where((z) => !z.removed).length, _when(_list!.fetchedAt!)),
                  style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                ),
                if (canWrite) ...[
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    key: const ValueKey('zon-refresh'),
                    onPressed: _refreshing ? null : _refresh,
                    icon: const Icon(Icons.refresh_rounded),
                    label: Text(s.zonRefresh),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}
