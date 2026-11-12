// Pratonton: the surau's real kiosk page inside a TV-shaped frame, read
// only (builder's call 8: `?preview=1`, the session token handed over by
// postMessage, Bearer on the kiosk read routes, no pairing row). Six
// chips put the screen in a state worth looking at: `Biasa` is the live
// clock; `Azan`, `Iqamah`, `Solat` and `Jumaat` give the page a `now`
// placed inside that stage of today's prayer day, computed from the box's
// own bundle the way `packages/core/src/kiosk/state.ts` builds its
// stages; `Tiada data` lands on a day the box has no row for. The page's
// clock runs on from that instant, so the person watches the countdown.
// On Android the WebView accepts the box's certificate only when it is
// byte-identical to the leaf the app's pinned connection received (see
// content/preview_tls.dart); otherwise one calm line and a retry button.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../content/preview_host.dart';
import '../content/preview_tls.dart';
import '../features/common/help_card.dart';
import '../features/common/time_words.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';

const String bundlePath = '/api/kiosk/bundle';
const String surauInfoPath = '/api/surau/info';

// ---- the clock a phase chip hands the page (pure) ----

enum PreviewPhase { biasa, azan, iqamah, solat, jumaat, tiadaData }

/// Kuala Lumpur, the offset used when the box does not say another.
const int defaultUtcOffsetMinutes = 480;

Duration _off(int minutes) => Duration(minutes: minutes);
const List<String> _solat = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'];
const List<String> _dayKeys = ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu'];

/// `2026-11-03T16:25:00+08:00`: the form the kiosk page's `?now=` reads, in
/// the surau's own offset ([utcOffsetMinutes], Kuala Lumpur by default).
String formatKl(DateTime t, {int utcOffsetMinutes = defaultUtcOffsetMinutes}) {
  final l = t.toUtc().add(_off(utcOffsetMinutes));
  String p(int n) => n.toString().padLeft(2, '0');
  final a = utcOffsetMinutes.abs();
  final sign = utcOffsetMinutes < 0 ? '-' : '+';
  return '${l.year.toString().padLeft(4, '0')}-${p(l.month)}-${p(l.day)}'
      'T${p(l.hour)}:${p(l.minute)}:${p(l.second)}$sign${p(a ~/ 60)}:${p(a % 60)}';
}

/// The `utcOffsetMinutes` of a `GET /api/surau/info` answer: a whole number
/// of minutes between -720 and 840, else 480.
int utcOffsetOf(Map<String, dynamic>? info) {
  final v = info?['utcOffsetMinutes'];
  if (v is num && v == v.roundToDouble() && v >= -720 && v <= 840) return v.toInt();
  return defaultUtcOffsetMinutes;
}

/// The instant the kiosk page should start its clock at for [phase], from
/// the bundle (`days`, `settings`, `serverTime`) as `GET /api/kiosk/bundle`
/// answers. Null for [PreviewPhase.biasa] (the live clock) and when the
/// bundle cannot show that phase (no row for today, the stage's feature
/// off, no Friday loaded).
DateTime? previewNowFor(
  PreviewPhase phase,
  Map<String, dynamic> bundle, {
  int utcOffsetMinutes = defaultUtcOffsetMinutes,
}) {
  final off = _off(utcOffsetMinutes);
  if (phase == PreviewPhase.biasa) return null;
  final days = _days(bundle);
  final settings = bundle['settings'] is Map
      ? (bundle['settings'] as Map).cast<String, dynamic>()
      : const <String, dynamic>{};
  final serverTime = DateTime.tryParse(bundle['serverTime'] as String? ?? '')?.toUtc() ??
      DateTime.now().toUtc();
  final today = _klDateOf(serverTime, off);

  if (phase == PreviewPhase.tiadaData) {
    var last = today;
    for (final d in days) {
      final date = d['date'] as String;
      if (date.compareTo(last) > 0) last = date;
    }
    return _klInstant(_addDays(last, 1, off), '12:00', off);
  }

  if (phase == PreviewPhase.jumaat) {
    final fridays = [
      for (final d in days)
        if ((d['date'] as String).compareTo(today) >= 0 && _klWeekday(d['date'] as String) == 5) d,
    ]..sort((a, b) => (a['date'] as String).compareTo(b['date'] as String));
    if (fridays.isEmpty) return null;
    return _middleOf(_stages(fridays.first, settings, off), _StageKind.khutbah, 'jumaat');
  }

  final row = days.where((d) => d['date'] == today).firstOrNull;
  if (row == null) return null;
  final prayer = _referencePrayer(row, settings, serverTime, off);
  final stages = _stages(row, settings, off);
  return switch (phase) {
    PreviewPhase.azan => _middleOf(stages, _StageKind.azanCountdown, prayer),
    PreviewPhase.iqamah => _middleOf(stages, _StageKind.iqamah, prayer),
    PreviewPhase.solat => _middleOf(stages, _StageKind.solat, prayer),
    _ => null,
  };
}

List<Map<String, dynamic>> _days(Map<String, dynamic> bundle) => [
  for (final d in (bundle['days'] as List? ?? const []))
    if (d is Map && d['date'] is String && d['times'] is Map) d.cast<String, dynamic>(),
];

/// The next prayer after the box's clock on [row], else the day's last;
/// zohor is `jumaat` on a Friday with the feature on, as the box names it.
String _referencePrayer(
  Map<String, dynamic> row,
  Map<String, dynamic> settings,
  DateTime at,
  Duration off,
) {
  final times = (row['times'] as Map).cast<String, dynamic>();
  final date = row['date'] as String;
  final fridayOn = _klWeekday(date) == 5 && _on(settings['jumaat']);
  String name(String key) => key == 'zohor' && fridayOn ? 'jumaat' : key;
  for (final key in _solat) {
    final t = _klInstantOrNull(date, times[key], off);
    if (t != null && t.isAfter(at)) return name(key);
  }
  return name('isyak');
}

/// The middle of the first stage of [kind] for [prayer], whole minutes.
DateTime? _middleOf(List<_Stage> stages, _StageKind kind, String prayer) {
  for (final s in stages) {
    if (s.kind == kind && s.prayer == prayer) {
      final mid = s.start.add(s.end.difference(s.start) ~/ 2);
      return DateTime.utc(mid.year, mid.month, mid.day, mid.hour, mid.minute);
    }
  }
  return null;
}

enum _StageKind { azanCountdown, masukWaktu, khutbah, iqamah, solat }

class _Stage {
  const _Stage(this.start, this.end, this.kind, this.prayer);

  final DateTime start;
  final DateTime end;
  final _StageKind kind;
  final String prayer;
}

/// Port of `buildStages` in core's kiosk state machine for the five
/// prayers (syuruk, isyraq and tarawih are not previewed), same defaults.
List<_Stage> _stages(Map<String, dynamic> day, Map<String, dynamic> settings, Duration off) {
  final out = <_Stage>[];
  final date = day['date'] as String;
  final times = (day['times'] as Map).cast<String, dynamic>();
  final dayKey = _dayKeys[_klWeekday(date)];
  final fridayOn = _klWeekday(date) == 5 && _on(settings['jumaat']);
  final az = _feat(settings['azanCountdown']);
  final mw = _feat(settings['masukWaktu']);
  final iq = _feat(settings['iqamahCountdown']);
  final ss = _feat(settings['solatScreen']);
  final jm = _feat(settings['jumaat']);

  for (final key in _solat) {
    final t = _klInstantOrNull(date, times[key], off);
    if (t == null) continue;
    final prayer = key == 'zohor' && fridayOn ? 'jumaat' : key;
    void push(DateTime start, DateTime end, _StageKind kind) =>
        out.add(_Stage(start, end, kind, prayer));

    if (_on(az)) {
      final before = az['minutesBefore'];
      final m = _num(before is Map ? before[key] : null, 10);
      if (m > 0) push(t.subtract(_minutes(m)), t, _StageKind.azanCountdown);
    }

    var cursor = t;
    if (_on(mw)) {
      final s = _num(mw['screenSeconds'], 60);
      if (s > 0) {
        final end = t.add(Duration(milliseconds: (s * 1000).round()));
        push(t, end, _StageKind.masukWaktu);
        cursor = end;
      }
    }

    if (prayer == 'jumaat') {
      final kh = _num(jm['khutbahMinutes'], 20);
      if (kh > 0) {
        final end = cursor.add(_minutes(kh));
        push(cursor, end, _StageKind.khutbah);
        cursor = end;
      }
      final iqm = _num(jm['iqamahMinutes'], 7);
      if (iqm > 0) {
        final end = cursor.add(_minutes(iqm));
        push(cursor, end, _StageKind.iqamah);
        cursor = end;
      }
      final sm = _num(jm['solatMinutes'], 15);
      if (sm > 0) push(cursor, cursor.add(_minutes(sm)), _StageKind.solat);
      continue;
    }

    if (_on(iq)) {
      final m = _minutesFor(iq['minutes'], dayKey, key, 10);
      final end = t.add(_minutes(m));
      if (end.isAfter(cursor)) {
        push(cursor, end, _StageKind.iqamah);
        cursor = end;
      }
    }
    if (_on(ss)) {
      final m = _minutesFor(ss['minutes'], dayKey, key, 15);
      if (m > 0) {
        final end = cursor.add(_minutes(m));
        push(cursor, end, _StageKind.solat);
        cursor = end;
      }
    }
  }
  return out;
}

Map<String, dynamic> _feat(Object? v) =>
    v is Map ? v.cast<String, dynamic>() : const <String, dynamic>{};

/// Core's `on`: a feature is on unless it says `enabled: false`.
bool _on(Object? f) => !(f is Map && f['enabled'] == false);

num _num(Object? v, num fallback) => v is num && v.isFinite ? v : fallback;

num _minutesFor(Object? table, String day, String prayer, num fallback) {
  if (table is Map) {
    final row = table[day];
    if (row is Map) return _num(row[prayer], fallback);
  }
  return fallback;
}

Duration _minutes(num m) => Duration(milliseconds: (m * 60000).round());

/// KL wall-clock date + `HH:mm[:ss]` -> instant (UTC), core's `klInstant`.
DateTime _klInstant(String date, String hhmm, Duration off) {
  final d = date.split('-').map(int.parse).toList();
  final t = hhmm.split(':').map(int.parse).toList();
  return DateTime.utc(d[0], d[1], d[2], t[0], t[1], t.length > 2 ? t[2] : 0).subtract(off);
}

DateTime? _klInstantOrNull(String date, Object? hhmm, Duration off) {
  if (hhmm is! String || !RegExp(r'^\d{2}:\d{2}(:\d{2})?$').hasMatch(hhmm)) return null;
  try {
    return _klInstant(date, hhmm, off);
  } on FormatException {
    return null;
  }
}

String _klDateOf(DateTime t, Duration off) {
  final l = t.toUtc().add(off);
  String p(int n) => n.toString().padLeft(2, '0');
  return '${l.year.toString().padLeft(4, '0')}-${p(l.month)}-${p(l.day)}';
}

/// 0 = Sunday, as core's `klWeekday`.
int _klWeekday(String date) {
  final d = date.split('-').map(int.parse).toList();
  return DateTime.utc(d[0], d[1], d[2]).weekday % 7;
}

String _addDays(String date, int n, Duration off) =>
    _klDateOf(_klInstant(date, '12:00', off).add(Duration(days: n)), off);

// ---- the screen ----

/// What the screen asks of its host: where, as whom, from when, the box's
/// pinned leaf certificate, and a way to say the WebView's certificate did
/// not match it (Android).
/// [generation] changes on `Muat semula` so the host reloads.
class PreviewRequest {
  const PreviewRequest({
    required this.box,
    required this.token,
    required this.now,
    required this.generation,
    required this.onSslError,
    this.utcOffsetMinutes = defaultUtcOffsetMinutes,
    this.poster,
    this.pinnedLeaf,
  });

  final Uri box;
  final String token;
  final DateTime? now;

  /// The surau's offset from UTC in minutes, for writing `?now=`.
  final int utcOffsetMinutes;
  final int generation;
  final SslRefused onSslError;

  /// Android: the box's current leaf over the pinned connection; null where
  /// the browser decides trust.
  final LeafFetcher? pinnedLeaf;

  /// One poster to show on its own (the poster editor's preview); null for
  /// the TV's normal rotation.
  final PreviewPoster? poster;
}

typedef PreviewBuilder = Widget Function(BuildContext context, PreviewRequest request);

/// The real host: a WebView on Android, an iframe on the web.
Widget defaultPreviewBuilder(BuildContext context, PreviewRequest r) => PreviewHost(
  r.box,
  r.token,
  key: ValueKey('preview-${r.generation}-${r.now?.millisecondsSinceEpoch}-${r.poster?.assetId ?? ''}'),
  now: r.now,
  utcOffsetMinutes: r.utcOffsetMinutes,
  poster: r.poster,
  onSslError: r.onSslError,
  pinnedLeaf: r.pinnedLeaf,
);

class PreviewScreen extends ConsumerStatefulWidget {
  const PreviewScreen({super.key, this.previewBuilder = defaultPreviewBuilder});

  /// Tests inject a stand-in for the WebView/iframe.
  final PreviewBuilder previewBuilder;

  @override
  ConsumerState<PreviewScreen> createState() => _PreviewScreenState();
}

class _PreviewScreenState extends ConsumerState<PreviewScreen> {
  PreviewPhase _phase = PreviewPhase.biasa;
  int _generation = 0;
  bool _sslError = false;
  String _expectedSha = '-';
  String _presentedSha = '-';

  void _reload() => setState(() {
    _generation++;
    _sslError = false;
  });

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final t = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final box = ref.watch(enrolledBoxProvider);
    final session = ref.watch(sessionProvider);
    final bundleRead = ref.watch(boxJsonProvider(bundlePath));
    final bundle = bundleRead.value?.value;
    final info = ref.watch(boxJsonProvider(surauInfoPath)).value?.value;
    final offset = utcOffsetOf(info);
    final now = bundle == null ? null : previewNowFor(_phase, bundle, utcOffsetMinutes: offset);

    return ShellPage(
      title: s.navPreview,
      actions: [
        IconButton(
          tooltip: t.previewReload,
          onPressed: _reload,
          icon: const Icon(Icons.refresh_rounded),
        ),
      ],
      body: SurauTheme.page(
        children: [
          Text(t.previewIntro, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final p in PreviewPhase.values)
                ChoiceChip(
                  label: Text(_phaseLabel(t, p)),
                  selected: _phase == p,
                  onSelected: p == PreviewPhase.biasa || (bundle != null && previewNowFor(p, bundle, utcOffsetMinutes: offset) != null)
                      ? (_) => setState(() {
                          _phase = p;
                          _sslError = false;
                        })
                      : null,
                ),
            ],
          ),
          // `hasError` rather than `!isLoading`: Riverpod retries a failed
          // read with backoff and reports loading meanwhile.
          if (bundle == null && bundleRead.hasError) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Text(
                    t.previewPhaseNeedsData,
                    style: text.bodySmall,
                  ),
                ),
                TextButton(
                  onPressed: () => ref.read(boxJsonProvider(bundlePath).notifier).refresh(),
                  child: Text(s.actionRetry),
                ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          _TvFrame(
            child: box == null || session == null
                ? _Notice(t.previewNoSession)
                : _sslError
                ? _TlsFailed(onRetry: _reload)
                : widget.previewBuilder(
                    context,
                    PreviewRequest(
                      box: box.box,
                      token: session.token,
                      now: now,
                      utcOffsetMinutes: offset,
                      generation: _generation,
                      pinnedLeaf: deps.boxLeaf == null ? null : () => deps.boxLeaf!(box),
                      onSslError: (expected, presented) {
                        if (mounted && !_sslError) {
                          setState(() {
                            _sslError = true;
                            _expectedSha = expected;
                            _presentedSha = presented;
                          });
                        }
                      },
                    ),
                  ),
          ),
          if (_sslError) ...[
            const SizedBox(height: 12),
            TechnicalDetails(
              rows: [
                (label: t.previewTlsExpected, value: _expectedSha),
                (label: t.previewTlsPresented, value: _presentedSha),
              ],
            ),
          ],
          const SizedBox(height: 12),
          Row(
            children: [
              const Icon(Icons.schedule_rounded, size: 20, color: SurauColors.muted),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  now == null
                      ? t.previewLive
                      : t.previewClockFrom(whenWords(
                            deps.toLocal(now),
                            today: deps.toLocal(deps.now()),
                          )),
                  style: text.bodyMedium!.copyWith(
                    color: SurauColors.muted,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  static String _phaseLabel(S t, PreviewPhase p) => switch (p) {
    PreviewPhase.biasa => t.previewPhaseBiasa,
    PreviewPhase.azan => t.previewPhaseAzan,
    PreviewPhase.iqamah => t.previewPhaseIqamah,
    PreviewPhase.solat => t.previewPhaseSolat,
    PreviewPhase.jumaat => t.previewPhaseJumaat,
    PreviewPhase.tiadaData => t.previewPhaseNoData,
  };
}

/// A 16:9 panel on the kiosk's glass with its gold hairline: the TV.
class _TvFrame extends StatelessWidget {
  const _TvFrame({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: SurauColors.glass,
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        border: Border.all(color: SurauColors.goldHairline),
      ),
      clipBehavior: Clip.antiAlias,
      child: AspectRatio(aspectRatio: 16 / 9, child: child),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge!.copyWith(color: Colors.white),
        ),
      ),
    );
  }
}

/// On glass: the preview could not be connected safely; one calm line and
/// a retry. The figures are behind `Butiran teknikal` under the frame.
class _TlsFailed extends StatelessWidget {
  const _TlsFailed({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final t = S.of(context);
    final text = Theme.of(context).textTheme;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.lock_outline_rounded, color: SurauColors.gold, size: 32),
              const SizedBox(height: 10),
              Text(
                t.previewTlsFailed,
                key: const ValueKey('preview-tls-failed'),
                textAlign: TextAlign.center,
                style: text.titleSmall!.copyWith(color: Colors.white),
              ),
              const SizedBox(height: 14),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded),
                label: Text(t.actionRetry),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
