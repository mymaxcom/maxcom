import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/content/adjusted_picture.dart';
import 'package:surau_app/content/image_ref.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../fakes.dart';
import 'harness.dart';

class _Reach implements ReachSink {
  BoxReach r = BoxReach.unknown;
  @override
  BoxReach get reach => r;
  @override
  void markUp(DateTime at) => r = r.up(at);
  @override
  void markDown(DateTime at) => r = r.failed(at);
}

void main() {
  late FakeBox box;
  late _Reach reach;
  late int expired;

  BoxGateway gateway() {
    final enrolled = fixtureBox();
    return BoxGateway(
      client: box.client(enrolled.box),
      token: 'tok-1',
      cache: ReadCache(),
      reach: reach,
      now: fixedNow,
      onSessionExpired: () => expired++,
    );
  }

  setUp(() {
    reach = _Reach();
    expired = 0;
  });

  test('upload, analysis and bytes: a 401 reaches onSessionExpired', () async {
    box = FakeBox(
      (r) async => jsonResponse(401, {
        'errors': ['Sesi tamat. Sila buka kunci semula'],
      }),
    );
    final g = gateway();
    await expectLater(
      g.uploadAsset(Uint8List.fromList([1, 2]), 'image/jpeg'),
      throwsA(isA<SessionExpired>()),
    );
    await expectLater(
      g.getFresh('/api/assets/a/analyze'),
      throwsA(isA<SessionExpired>()),
    );
    await expectLater(g.getBytes('/assets/a'), throwsA(isA<SessionExpired>()));
    expect(expired, 3);
  });

  test(
    'upload is refused while the box is away; analysis is never cached',
    () async {
      var calls = 0;
      box = FakeBox((r) async {
        calls++;
        return jsonResponse(200, {'n': calls});
      });
      final g = gateway();
      expect((await g.getFresh('/api/assets/a/analyze'))['n'], 1);
      expect((await g.getFresh('/api/assets/a/analyze'))['n'], 2);
      expect(g.cache.isEmpty, isTrue);
      reach.markDown(fixedNow());
      await expectLater(
        g.uploadAsset(Uint8List(1), 'image/jpeg'),
        throwsA(isA<OfflineWriteRefused>()),
      );
    },
  );

  testWidgets(
    'a picture fetch that failed is retried, not remembered as no picture',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      final id = 'a' * 64;
      var fail = true;
      h.handlers['GET /assets/$id'] = (r) async {
        if (fail) throw http.ClientException('away');
        return http.Response.bytes(
          fixtureLogoPng(),
          200,
          headers: {'content-type': 'image/png'},
        );
      };
      final c = h.container;
      final sub = c.listen(assetBytesProvider(id), (_, _) {});
      addTearDown(sub.close);
      await expectLater(
        c.read(assetBytesProvider(id).future),
        throwsA(isA<BoxUnreachable>()),
      );
      expect(c.read(assetBytesProvider(id)).hasError, isTrue);

      fail = false;
      c.invalidate(assetBytesProvider(id));
      final bytes = await c.read(assetBytesProvider(id).future);
      expect(bytes, isNotNull);
    },
  );

  testWidgets(
    'a 404 is a plain null; the thumbnail of a failed fetch taps to retry',
    (tester) async {
      final h = await pumpShell(tester, roles: const ['admin']);
      final id = 'b' * 64;
      var fail = true;
      h.handlers['GET /assets/$id'] = (r) async {
        if (fail) throw http.ClientException('away');
        return http.Response.bytes(
          fixtureLogoPng(),
          200,
          headers: {'content-type': 'image/png'},
        );
      };
      expect(
        await h.container.read(assetBytesProvider('c' * 64).future),
        isNull,
      );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: h.container,
          child: MaterialApp(
            locale: const Locale('ms'),
            localizationsDelegates: S.localizationsDelegates,
            supportedLocales: S.supportedLocales,
            home: Scaffold(
              body: AssetPicture(
                value: ImageRef(id).toJson(),
                slot: ImageSlot.poster,
              ),
            ),
          ),
        ),
      );
      await settle(tester);
      expect(find.byKey(const ValueKey('picture-retry')), findsOneWidget);
      fail = false;
      await tester.tap(find.byKey(const ValueKey('picture-retry')));
      await settle(tester);
      expect(find.byKey(const ValueKey('picture-retry')), findsNothing);
    },
  );
}
