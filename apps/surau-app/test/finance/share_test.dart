import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/finance/share.dart';
import 'package:surau_app/features/finance/share_stub.dart' as stub;

const String pdf = 'application/pdf';
const String xlsx =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

Uint8List bytes([int n = 10]) => Uint8List.fromList(List.filled(n, 7));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('my.maxcom/share');
  final calls = <MethodCall>[];

  void handler(Future<Object?> Function(MethodCall call)? f) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (c) {
          calls.add(c);
          return f == null ? Future.value(null) : f(c);
        });
  }

  setUp(calls.clear);
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('argument rules (mirrored in ShareChannel.kt)', () {
    test('plain names pass', () {
      for (final n in [
        'Laporan-2026-10.pdf',
        'a',
        'x' * 100,
        'Laporan Oktober.pdf',
      ]) {
        expect(shareNameOk(n), isTrue, reason: n);
      }
    });

    test('empty, long, path and traversal names are refused', () {
      for (final n in [
        '',
        'x' * 101,
        'a/b.pdf',
        r'a\b.pdf',
        '..',
        '../x.pdf',
        'a..b.pdf',
        'a\u0000b.pdf',
        'a\nb.pdf',
      ]) {
        expect(shareNameOk(n), isFalse, reason: n);
      }
    });

    test('only the three types are allowed', () {
      for (final m in [pdf, 'text/csv', xlsx]) {
        expect(() => checkShareArgs('a.pdf', m, bytes()), returnsNormally);
      }
      for (final m in [
        'text/html',
        'application/zip',
        '',
        'application/pdf; x=1',
      ]) {
        expect(
          () => checkShareArgs('a.pdf', m, bytes()),
          throwsA(isA<ShareArgsError>()),
          reason: m,
        );
      }
    });

    test('empty and oversize content are refused', () {
      expect(
        () => checkShareArgs('a.pdf', pdf, Uint8List(0)),
        throwsA(isA<ShareArgsError>()),
      );
      expect(
        () => checkShareArgs('a.pdf', pdf, Uint8List(shareMaxBytes + 1)),
        throwsA(isA<ShareArgsError>()),
      );
      expect(
        () => checkShareArgs('a.pdf', pdf, Uint8List(shareMaxBytes)),
        returnsNormally,
      );
    });

    test('a refused argument never reaches the platform', () async {
      handler(null);
      await expectLater(
        shareBytes(bytes(), '../x.pdf', mime: pdf),
        throwsA(isA<ShareArgsError>()),
      );
      await expectLater(
        saveBytes(bytes(), 'a/b.pdf', mime: pdf),
        throwsA(isA<ShareArgsError>()),
      );
      await expectLater(
        shareBytes(bytes(), 'a.pdf', mime: 'text/html'),
        throwsA(isA<ShareArgsError>()),
      );
      expect(calls, isEmpty);
    });
  });

  group('the facade picks the platform half', () {
    test('under the VM tests the Android half is chosen', () {
      expect(shareImplementation, 'android');
    });

    test('the stub (no Android, no browser) saves and sends nothing', () async {
      expect(stub.implementation, 'stub');
      expect((await stub.share(bytes(), 'a.pdf', pdf)).via, 'other');
      expect((await stub.share(bytes(), 'a.pdf', pdf)).completed, isFalse);
      expect((await stub.save(bytes(), 'a.pdf', pdf)).saved, isFalse);
    });
  });

  group('Android channel', () {
    test(
      'share sends bytes, name and type, and returns the chosen app class',
      () async {
        handler((c) async => {'via': 'whatsapp', 'completed': true});
        final r = await shareBytes(bytes(3), 'Laporan.pdf', mime: pdf);
        expect(r.via, 'whatsapp');
        expect(r.completed, isTrue);
        expect(calls.single.method, 'share');
        final a = calls.single.arguments as Map;
        expect(a['filename'], 'Laporan.pdf');
        expect(a['mime'], pdf);
        expect(a['bytes'], bytes(3));
      },
    );

    test(
      'email and other are passed through; anything else becomes other',
      () async {
        for (final (said, want) in [
          ('email', 'email'),
          ('other', 'other'),
          ('telegram', 'other'),
          ('', 'other'),
        ]) {
          handler((c) async => {'via': said, 'completed': true});
          expect(
            (await shareBytes(bytes(), 'a.pdf', mime: pdf)).via,
            want,
            reason: said,
          );
        }
      },
    );

    test('a chooser the system did not report is not completed', () async {
      handler((c) async => {'via': 'other', 'completed': false});
      final r = await shareBytes(bytes(), 'a.pdf', mime: pdf);
      expect(r.via, 'other');
      expect(r.completed, isFalse);
    });

    test('a failed share is ShareFailed with no detail', () async {
      handler(
        (c) async => throw PlatformException(
          code: 'failed',
          message: 'Laporan.pdf secret',
        ),
      );
      await expectLater(
        shareBytes(bytes(), 'Laporan.pdf', mime: pdf),
        throwsA(
          isA<ShareFailed>().having(
            (e) => e.toString(),
            'text',
            isNot(contains('Laporan')),
          ),
        ),
      );
    });

    test('save to Downloads reports saved', () async {
      handler((c) async => {'saved': true});
      final r = await saveBytes(bytes(), 'a.pdf', mime: pdf);
      expect(r.saved, isTrue);
      expect(r.sharedInstead, isFalse);
      expect(calls.map((c) => c.method), ['save']);
    });

    test(
      'an older phone (saved: false) falls back to the share sheet',
      () async {
        handler(
          (c) async => c.method == 'save'
              ? {'saved': false}
              : {'via': 'other', 'completed': true},
        );
        final r = await saveBytes(bytes(), 'a.pdf', mime: pdf);
        expect(r.saved, isFalse);
        expect(r.sharedInstead, isTrue);
        expect(calls.map((c) => c.method), ['save', 'share']);
      },
    );

    test(
      'a failed Downloads write also falls back to the share sheet',
      () async {
        handler((c) async {
          if (c.method == 'save') throw PlatformException(code: 'failed');
          return {'via': 'other', 'completed': false};
        });
        final r = await saveBytes(bytes(), 'a.pdf', mime: pdf);
        expect(r.sharedInstead, isTrue);
        expect(calls.map((c) => c.method), ['save', 'share']);
      },
    );

    test(
      'saveAndShare sends the finance PDF with the PDF type by default',
      () async {
        handler((c) async => {'via': 'email', 'completed': true});
        final r = await saveAndShare(bytes(), 'Laporan-2026-10.pdf');
        expect(r.via, 'email');
        expect((calls.single.arguments as Map)['mime'], pdf);
      },
    );

    test('a template download (XLSX) uses the same helper', () async {
      handler((c) async => {'saved': true});
      expect(
        (await saveBytes(bytes(), 'Templat.xlsx', mime: xlsx)).saved,
        isTrue,
      );
    });
  });
}
