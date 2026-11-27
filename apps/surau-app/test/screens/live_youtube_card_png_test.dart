// The YouTube account card of the Live screen in its four states, in BM and EN,
// saved as PNGs for review. Nothing is written unless YT_CARD_PNG_DIR names a folder, so the normal suite only
// checks that every state renders in both languages.

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart';

import '../features/fakes.dart' show fixedNow;
import '../features/shell/harness.dart';

Future<void> _shot(WidgetTester tester, String name) async {
  final dir = Platform.environment['YT_CARD_PNG_DIR'];
  if (dir == null || dir.isEmpty) return;
  final card = find.byKey(const ValueKey('live-youtube-account'));
  final box = tester.renderObject<RenderBox>(card);
  final topLeft = box.localToGlobal(Offset.zero);
  final rect = topLeft & box.size;
  RenderObject? r = tester.binding.renderViews.first;
  RenderRepaintBoundary? boundary;
  void visit(RenderObject o) {
    if (boundary == null && o is RenderRepaintBoundary) boundary = o;
    o.visitChildren(visit);
  }

  visit(r);
  const ratio = 2.0;
  final bytes = await tester.runAsync(() async {
    final img = await boundary!.toImage(pixelRatio: ratio);
    final rec = ui.PictureRecorder();
    final canvas = Canvas(rec);
    final src = Rect.fromLTWH(rect.left * ratio, rect.top * ratio, rect.width * ratio, rect.height * ratio);
    canvas.drawImageRect(img, src, Rect.fromLTWH(0, 0, src.width, src.height), Paint());
    final out = await rec.endRecording().toImage(src.width.round(), src.height.round());
    return (await out.toByteData(format: ui.ImageByteFormat.png))!.buffer.asUint8List();
  });
  Directory(dir).createSync(recursive: true);
  File('$dir/$name.png').writeAsBytesSync(bytes!);
}

void main() {
  final states = <String, LiveBoxStatus>{
    'signed-out': const LiveBoxStatus(),
    'pending': LiveBoxStatus(
      youtube: YoutubeAccount.signingIn(
        userCode: 'BQXR-TKMW',
        verificationUrl: 'https://www.google.com/device',
        expiresAt: fixedNow().add(const Duration(minutes: 9, seconds: 30)),
      ),
    ),
    'signed-in': const LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau Contoh')),
    'expired': const LiveBoxStatus(youtube: YoutubeAccount.signedOut(reason: YoutubeSignOutReason.expired)),
    'revoked': const LiveBoxStatus(youtube: YoutubeAccount.signedOut(reason: YoutubeSignOutReason.revoked)),
    // 2026.11.13: away from the surau the cloud answers with the box's flag; no sign-in or sign-out button
    'away-signed-in': const LiveBoxStatus(youtube: YoutubeAccount.signedIn('Surau Contoh'), youtubeSignInHere: false),
    'away-signed-out': const LiveBoxStatus(youtubeSignInHere: false),
  };
  for (final lang in [AppLang.ms, AppLang.en]) {
    for (final e in states.entries) {
      testWidgets('card ${e.key} (${lang.code})', (tester) async {
        final h = await pumpShell(
          tester,
          roles: const ['admin'],
          overrides: [livePublisherProvider.overrideWithValue(FakePublisher()), liveBoxProvider.overrideWith(() => LiveBoxNotifier(e.value))],
        );
        if (lang != AppLang.ms) await h.container.read(appLangProvider.notifier).set(lang);
        h.router.go('/live');
        await settle(tester);
        final card = find.byKey(const ValueKey('live-youtube-account'));
        await reveal(tester, card);
        expect(card, findsOneWidget);
        final away = !e.value.youtubeSignInHere;
        expect(find.byKey(const ValueKey('live-youtube-at-surau')), away ? findsOneWidget : findsNothing);
        if (away) {
          expect(find.byKey(const ValueKey('live-youtube-signout')), findsNothing);
          expect(find.byIcon(Icons.login_rounded), findsNothing);
          if (e.value.youtube.signedIn) {
            expect(find.textContaining('Surau Contoh'), findsWidgets);
          }
        }
        await _shot(tester, '${e.key}-${lang.code}');
      });
    }
  }
}
