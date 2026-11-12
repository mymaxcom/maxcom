// Plan 6 Task 13: the words of the recording clean-up (Bahasa Malaysia),
// on the upload card and on the live summary.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/features/registry.g.dart' as reg;
import 'package:surau_app/features/settings_form.dart';
import 'package:surau_app/features/upload/upload_widgets.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/l10n/generated/s_en.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';
import 'package:surau_app/upload/recording_cleanup.dart';
import 'package:surau_app/upload/upload_queue.dart';

Widget _wrap(Widget child, {Locale locale = const Locale('ms')}) =>
    MaterialApp(
      locale: locale,
      localizationsDelegates: S.localizationsDelegates,
      supportedLocales: S.supportedLocales,
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );

UploadJob _doneJob() => UploadJob(
  id: 'j1',
  sessionId: 's1',
  kuliahId: null,
  parts: const [
    UploadPart(
      index: 1,
      source: 'android:joined',
      bytes: 100,
      offset: 100,
      videoId: 'abc',
      state: UploadPartState.done,
    ),
  ],
  joined: true,
  allowMobile: false,
  createdAt: DateTime.utc(2026, 11, 6, 2),
);

CleanupRecord _record({DateTime? verifiedAt, DateTime? deletedAt}) =>
    CleanupRecord(
      sessionId: 's1',
      kuliahId: null,
      durationSec: 1800,
      recordedAt: DateTime.utc(2026, 11, 6, 1),
      names: const ['MAXCOM-2026-11-06-siaran-01.mp4'],
      bytes: 100,
      verifiedAt: verifiedAt,
      deletedAt: deletedAt,
    );

Widget _card({CleanupRecord? cleanup, int keepDays = 1}) => UploadJobCard(
  job: _doneJob(),
  kuliah: null,
  policy: UploadPolicy.run,
  localOf: (t) => t,
  showMobileToggle: false,
  busy: false,
  onPause: () {},
  onResume: () {},
  onRetry: () {},
  onAllowMobile: (_) {},
  onRemove: () {},
  onWatch: (_) {},
  cleanup: cleanup,
  keepDays: keepDays,
);

Widget _summary({int? keep, int duration = 1800, int? yt = 1800}) =>
    LiveSummarySheet(
      durationSec: duration,
      youtubeSeconds: yt,
      recorded: true,
      web: false,
      kuliah: null,
      watchUrl: 'https://www.youtube.com/watch?v=abc',
      onWatch: (_) {},
      onSave: () {},
      cleanupKeepDays: keep,
    );

void main() {
  group('settings page Pembersihan rakaman', () {
    final feature = reg.features.firstWhere((f) => f.key == 'recordingCleanup');

    testWidgets('is in the cloud group with its Bahasa Malaysia name', (
      tester,
    ) async {
      expect(feature.group, 'awan');
      expect(feature.labelMs, 'Pembersihan rakaman');
      expect(feature.defaultEnabled, isTrue);
      expect(feature.defaults, {'keepDays': 1});
    });

    testWidgets('keepDays is a choice of 0, 1, 3, 7 and 30 days', (
      tester,
    ) async {
      Object? changed;
      await tester.pumpWidget(
        _wrap(
          SettingsForm(
            feature: feature,
            values: const {'keepDays': 1},
            errors: const {},
            onChanged: (k, v) => changed = v,
          ),
        ),
      );
      expect(find.text('Simpan selepas disahkan di YouTube'), findsOneWidget);
      final menu = find.byKey(const ValueKey('setting-keepDays'));
      expect(menu, findsOneWidget);
      await tester.tap(menu);
      await tester.pumpAndSettle();
      for (final t in ['Padam serta merta', '3 hari', '7 hari', '30 hari']) {
        expect(find.text(t), findsWidgets, reason: t);
      }
      await tester.tap(find.text('7 hari').last);
      await tester.pumpAndSettle();
      expect(changed, 7);
    });
  });

  group('upload card', () {
    testWidgets('no clean-up record: no clean-up line', (tester) async {
      await tester.pumpWidget(_wrap(_card()));
      expect(find.byKey(const ValueKey('upload-cleanup-j1')), findsNothing);
    });

    testWidgets('waiting for verification: no line yet', (tester) async {
      await tester.pumpWidget(_wrap(_card(cleanup: _record())));
      expect(find.byKey(const ValueKey('upload-cleanup-j1')), findsNothing);
    });

    testWidgets('verified: says the day the files leave this device', (
      tester,
    ) async {
      final rec = _record(verifiedAt: DateTime.utc(2026, 11, 6, 12));
      await tester.pumpWidget(_wrap(_card(cleanup: rec, keepDays: 3)));
      expect(
        find.text('Akan dipadam daripada peranti pada 9 Nov 2026'),
        findsOneWidget,
      );
    });

    testWidgets('deleted: says so', (tester) async {
      final rec = _record(
        verifiedAt: DateTime.utc(2026, 11, 6, 12),
        deletedAt: DateTime.utc(2026, 11, 7, 13),
      );
      await tester.pumpWidget(_wrap(_card(cleanup: rec)));
      expect(find.text('Dipadam daripada peranti'), findsOneWidget);
      expect(find.textContaining('Akan dipadam'), findsNothing);
    });

    testWidgets('English words exist too', (tester) async {
      final rec = _record(verifiedAt: DateTime.utc(2026, 11, 6, 12));
      await tester.pumpWidget(
        _wrap(_card(cleanup: rec), locale: const Locale('en')),
      );
      expect(
        find.textContaining('Will be deleted from this device on'),
        findsOneWidget,
      );
    });
  });

  group('live summary', () {
    testWidgets('a live that covered it: deleted after 1 day', (tester) async {
      await tester.pumpWidget(_wrap(_summary(keep: 1)));
      expect(
        find.text(
          'Rakaman akan dipadam selepas 1 hari kerana YouTube sudah menerima siaran penuh',
        ),
        findsOneWidget,
      );
    });

    testWidgets('7 days', (tester) async {
      await tester.pumpWidget(_wrap(_summary(keep: 7)));
      expect(find.textContaining('selepas 7 hari'), findsOneWidget);
    });

    testWidgets('keepDays 0: as soon as YouTube confirms', (tester) async {
      await tester.pumpWidget(_wrap(_summary(keep: 0)));
      expect(
        find.text(
          'Rakaman akan dipadam sebaik sahaja YouTube mengesahkan siaran penuh',
        ),
        findsOneWidget,
      );
    });

    testWidgets('not set (feature off or not covered): no line', (tester) async {
      await tester.pumpWidget(_wrap(_summary()));
      expect(find.byKey(const ValueKey('live-cleanup-note')), findsNothing);
    });

    testWidgets('a live with a gap never promises a deletion', (tester) async {
      await tester.pumpWidget(_wrap(_summary(keep: 1, yt: 1000)));
      expect(find.byKey(const ValueKey('live-cleanup-note')), findsNothing);
    });

    testWidgets('English singular and plural', (tester) async {
      await tester.pumpWidget(
        _wrap(_summary(keep: 1), locale: const Locale('en')),
      );
      expect(find.textContaining('after 1 day because'), findsOneWidget);
      await tester.pumpWidget(
        _wrap(_summary(keep: 3), locale: const Locale('en')),
      );
      await tester.pump();
      expect(find.textContaining('after 3 days because'), findsOneWidget);
    });
  });

  test('the words carry no dash, arrow or approximation sign', () {
    final bad = RegExp('[–—→≈←-]');
    final ms = SMs();
    final en = SEn();
    for (final t in [
      ms.uploadDeleteOn('9 Nov 2026'),
      ms.uploadDeleted,
      ms.liveCleanupAfterDays(1),
      ms.liveCleanupAfterDays(30),
      ms.liveCleanupNow,
      en.uploadDeleteOn('9 Nov 2026'),
      en.uploadDeleted,
      en.liveCleanupAfterDays(1),
      en.liveCleanupAfterDays(3),
      en.liveCleanupNow,
    ]) {
      expect(bad.hasMatch(t), isFalse, reason: t);
    }
  });
}
