// The one question after a joined, verified recording (2026.11.14): "Simpan rakaman di peranti?" in BM, EN and AR
// (goldens), who is asked, and the notes the live summary gives about the joined recording.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/live/live_screen.dart';
import 'package:surau_app/features/upload/keep_prompt.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/upload/recording_cleanup.dart';

import '../golden_sizes.dart';

Widget _wrap(Widget child, {Locale locale = const Locale('ms')}) => MaterialApp(
  locale: locale,
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(body: child),
);

CleanupRecord _rec(String id, {bool ask = true, DateTime? verifiedAt, String? choice, DateTime? deletedAt, DateTime? keptAt}) => CleanupRecord(
  sessionId: id,
  kuliahId: null,
  durationSec: 1800,
  recordedAt: DateTime.utc(2026, 11, 21, 1),
  names: const ['MAXCOM-2026-11-21-1930-subuh-all.mp4'],
  bytes: 100,
  verifiedAt: verifiedAt,
  ask: ask,
  choice: choice,
  deletedAt: deletedAt,
  keptAt: keptAt,
);

Widget _summary(List<String> notes, {bool web = false}) => LiveSummarySheet(
  durationSec: 1800,
  youtubeSeconds: 1800,
  recorded: true,
  web: web,
  kuliah: null,
  watchUrl: null,
  onWatch: (_) {},
  onSave: () {},
  recordingNotes: notes,
);

void main() {
  final verified = DateTime.utc(2026, 11, 21, 3);

  group('who is asked', () {
    test('only a verified recording that waits for its answer', () {
      expect(recordToAsk(null), isNull);
      expect(recordToAsk({'a': _rec('a')}), isNull, reason: 'YouTube has not confirmed yet: nothing is asked, the file stays');
      expect(recordToAsk({'a': _rec('a', verifiedAt: verified)})?.sessionId, 'a');
      expect(recordToAsk({'a': _rec('a', verifiedAt: verified, choice: 'keep')}), isNull, reason: 'asked once');
      expect(recordToAsk({'a': _rec('a', verifiedAt: verified, choice: 'delete')}), isNull);
      expect(recordToAsk({'a': _rec('a', verifiedAt: verified, ask: false)}), isNull, reason: 'a record from before this release');
      expect(recordToAsk({'a': _rec('a', verifiedAt: verified, deletedAt: verified)}), isNull);
      expect(recordToAsk({'a': _rec('a', verifiedAt: verified, keptAt: verified)}), isNull);
    });

    test('the answer is stored with the record and survives a restart', () {
      final r = CleanupRecord.fromJson(_rec('a', verifiedAt: verified, choice: 'delete').toJson());
      expect(r.ask, isTrue);
      expect(r.choice, 'delete');
      expect(CleanupRecord.fromJson(_rec('a').toJson()).needsAnswer, isFalse);
    });
  });

  for (final (name, locale, title, keep, del) in [
    ('bm', const Locale('ms'), 'Simpan rakaman di peranti?', 'Simpan', 'Padam'),
    ('en', const Locale('en'), 'Keep the recording on this device?', 'Keep', 'Delete'),
    ('ar', const Locale('ar'), 'هل تريد حفظ التسجيل على هذا الجهاز؟', 'احتفاظ', 'حذف'),
  ]) {
    testWidgets('the question, $name', (tester) async {
      await pumpAtSize(tester, _wrap(const KeepRecordingDialog(), locale: locale), GoldenSize.phone);
      expect(find.text(title), findsOneWidget);
      expect(find.widgetWithText(FilledButton, keep), findsOneWidget);
      expect(find.widgetWithText(TextButton, del), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('recording_keep_prompt_$name.png'));
    });
  }

  group('the live summary about the recording', () {
    testWidgets('joined, and the question to come', (tester) async {
      await pumpAtSize(tester, _wrap(_summary(const ['joined', 'askLater'])), GoldenSize.phone);
      expect(find.text('Rakaman digabungkan menjadi satu fail.'), findsOneWidget);
      expect(find.textContaining('anda akan ditanya sama ada mahu menyimpan rakaman'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('recording_summary_joined_bm.png'));
    });

    testWidgets('YouTube not confirmed: the recording is kept and the summary says so', (tester) async {
      await tester.pumpWidget(_wrap(_summary(const ['joined', 'keptUnconfirmed'])));
      expect(find.text('Salinan YouTube belum disahkan, jadi rakaman disimpan di peranti ini.'), findsOneWidget);
    });

    testWidgets('a join that failed says every part is kept', (tester) async {
      await tester.pumpWidget(_wrap(_summary(const ['joinFailed'])));
      expect(find.text('Rakaman tidak dapat digabungkan. Setiap bahagian disimpan seperti asalnya.'), findsOneWidget);
      expect(find.byKey(const ValueKey('live-rec-note-joinFailed')), findsOneWidget);
    });

    testWidgets('English and Arabic notes', (tester) async {
      await tester.pumpWidget(_wrap(_summary(const ['joined', 'askLater', 'keptUnconfirmed']), locale: const Locale('en')));
      expect(find.text('The recording was joined into one file.'), findsOneWidget);
      expect(find.textContaining('you will be asked whether to keep the recording'), findsOneWidget);
      await tester.pumpWidget(_wrap(_summary(const ['joined']), locale: const Locale('ar')));
      await tester.pump();
      expect(find.text('تم دمج التسجيل في ملف واحد.'), findsOneWidget);
    });

    testWidgets('no notes: nothing extra on the summary', (tester) async {
      await tester.pumpWidget(_wrap(_summary(const [])));
      expect(find.byKey(const ValueKey('live-rec-note-joined')), findsNothing);
    });
  });
}
