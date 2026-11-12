import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/device_key.dart';
import 'package:surau_app/box/device_key_android.dart';
import 'package:surau_app/box/device_key_software.dart';

Uint8List hex(String s) {
  final out = Uint8List(s.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String toHex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Map<String, dynamic> readVectors() => jsonDecode(
      File('test/fixtures/vectors/node-signed.json').readAsStringSync(),
    ) as Map<String, dynamic>;

Map<String, String> strMap(Object? o) =>
    (o as Map<String, dynamic>).map((k, v) => MapEntry(k, v as String));

/// Re-encode r||s as DER the way Java's Signature does.
Uint8List p1363ToDer(Uint8List sig) {
  Uint8List intOf(Uint8List b) {
    var i = 0;
    while (i < b.length - 1 && b[i] == 0) {
      i++;
    }
    var v = b.sublist(i);
    if (v[0] & 0x80 != 0) v = Uint8List.fromList([0, ...v]);
    return Uint8List.fromList([0x02, v.length, ...v]);
  }

  final body = [...intOf(sig.sublist(0, 32)), ...intOf(sig.sublist(32))];
  return Uint8List.fromList([0x30, body.length, ...body]);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final v = readVectors();
  final publicJwk = strMap(v['publicJwk']);
  final message = hex(v['messageHex'] as String);
  final nodeSig = unB64url(v['signatureB64url'] as String);

  test('unlockMessage equals the Node message bytes', () {
    expect(
      toHex(unlockMessage(
          v['boxId'] as String, v['deviceId'] as String, v['nonce'] as String)),
      v['messageHex'],
    );
    expect(toHex(unlockMessage('a1b2c3d4e5f60718', 'dev1', 'nonce')),
        v['messageHex']);
  });

  group('verifyP256', () {
    test('accepts the Node signature, rejects after flipping one byte', () {
      expect(verifyP256(publicJwk, message, nodeSig), isTrue);
      for (final i in [0, 31, 32, 63]) {
        final bad = Uint8List.fromList(nodeSig)..[i] ^= 1;
        expect(verifyP256(publicJwk, message, bad), isFalse, reason: 'byte $i');
      }
      final badMsg = Uint8List.fromList(message)..[0] ^= 1;
      expect(verifyP256(publicJwk, badMsg, nodeSig), isFalse);
    });

    test('rejects wrong lengths, zero and out-of-range r/s', () {
      expect(verifyP256(publicJwk, message, nodeSig.sublist(0, 63)), isFalse);
      expect(verifyP256(publicJwk, message, Uint8List(65)), isFalse);
      expect(verifyP256(publicJwk, message, Uint8List(64)), isFalse);
      expect(
          verifyP256(publicJwk, message, Uint8List(64)..fillRange(0, 64, 0xff)),
          isFalse);
    });

    test('rejects a JWK that is not exactly kty, crv, x, y', () {
      expect(verifyP256({...publicJwk, 'd': 'AAAA'}, message, nodeSig), isFalse);
      expect(verifyP256({...publicJwk, 'alg': 'ES256'}, message, nodeSig), isFalse);
      expect(verifyP256({...publicJwk, 'crv': 'P-384'}, message, nodeSig), isFalse);
      expect(verifyP256({...publicJwk, 'kty': 'RSA'}, message, nodeSig), isFalse);
      final noY = Map<String, String>.of(publicJwk)..remove('y');
      expect(verifyP256(noY, message, nodeSig), isFalse);
    });

    test('rejects a point that is not on the curve', () {
      final off = {...publicJwk, 'y': publicJwk['x']!};
      expect(verifyP256(off, message, nodeSig), isFalse);
    });
  });

  group('SoftwareDeviceKey', () {
    test('fromJwk signs 64 bytes that verify, deterministic (RFC 6979)', () async {
      final key = SoftwareDeviceKey.fromJwk(v['privateJwk'] as Map<String, dynamic>);
      expect(await key.exists(), isTrue);
      expect(await key.publicJwk(), publicJwk);
      final s1 = await key.sign(message);
      final s2 = await key.sign(message);
      expect(s1.length, 64);
      expect(s1, s2);
      expect(verifyP256(publicJwk, message, s1), isTrue);
    });

    test('fromJwk refuses a private key that does not match x/y', () {
      final priv = Map<String, dynamic>.of(v['privateJwk'] as Map<String, dynamic>);
      priv['d'] = b64url(Uint8List(32)..[31] = 7);
      expect(() => SoftwareDeviceKey.fromJwk(priv), throwsFormatException);
    });

    test('generate gives a clean public JWK and clear removes the key', () async {
      final key = SoftwareDeviceKey.random();
      final jwk = await key.generate();
      expect(jwk.keys.toSet(), {'kty', 'crv', 'x', 'y'});
      expect(jwk['kty'], 'EC');
      expect(jwk['crv'], 'P-256');
      expect(unB64url(jwk['x']!).length, 32);
      expect(unB64url(jwk['y']!).length, 32);
      final sig = await key.sign(message);
      expect(verifyP256(jwk, message, sig), isTrue);
      await key.clear();
      expect(await key.exists(), isFalse);
      await expectLater(key.sign(message), throwsStateError);
      await expectLater(key.publicJwk(), throwsStateError);
    });

    test('signatures are always 64 bytes over many messages', () async {
      final key = SoftwareDeviceKey.random();
      final jwk = await key.publicJwk();
      for (var i = 0; i < 300; i++) {
        final m = Uint8List.fromList(utf8.encode('m$i'));
        final s = await key.sign(m);
        expect(s.length, 64);
        expect(verifyP256(jwk, m, s), isTrue);
      }
    });

    test('a dart-signed.json in the committed shape verifies (written to a temp dir)', () async {
      // The committed test/fixtures/vectors/dart-signed.json changes only
      // through `node scripts/gen-app-fixtures.mjs --vectors`; a test run
      // must never rewrite it with a random signature.
      final key = SoftwareDeviceKey.fromJwk(v['privateJwk'] as Map<String, dynamic>);
      final sig = await key.sign(message);
      final out = {
        'publicJwk': publicJwk,
        'messageHex': toHex(message),
        'signatureB64url': b64url(sig),
      };
      final dir = Directory.systemTemp.createTempSync('surau-vectors-');
      addTearDown(() => dir.deleteSync(recursive: true));
      final file = File('${dir.path}/dart-signed.json')
        ..writeAsStringSync('${const JsonEncoder.withIndent('  ').convert(out)}\n');
      expect(sig.length, 64);
      final back = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      expect(
        verifyP256(
          (back['publicJwk'] as Map).cast<String, String>(),
          message,
          unB64url(back['signatureB64url'] as String),
        ),
        isTrue,
      );
    });
  });

  group('AndroidDeviceKey over a mocked Keystore channel', () {
    const channel = MethodChannel(keystoreChannelName);
    late SoftwareDeviceKey fake; // plays the Keystore
    late List<String> calls;

    setUp(() {
      fake = SoftwareDeviceKey.random();
      calls = [];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        switch (call.method) {
          case 'exists':
            return fake.exists();
          case 'generate':
          case 'publicKey':
            if (call.method == 'generate') await fake.generate();
            final jwk = await fake.publicJwk();
            return Uint8List.fromList(
                [0x04, ...unB64url(jwk['x']!), ...unB64url(jwk['y']!)]);
          case 'sign':
            return p1363ToDer(await fake.sign(call.arguments as Uint8List));
          case 'clear':
            await fake.clear();
            return null;
        }
        throw MissingPluginException();
      });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });

    test('generate returns a clean JWK and self-checks with a signature', () async {
      final key = AndroidDeviceKey();
      final jwk = await key.generate();
      expect(jwk.keys.toSet(), {'kty', 'crv', 'x', 'y'});
      expect(calls, containsAllInOrder(['generate', 'sign']));
      final sig = await key.sign(message);
      expect(sig.length, 64);
      expect(verifyP256(jwk, message, sig), isTrue);
      expect(await key.publicJwk(), jwk);
    });

    test('a store whose public key does not match its signatures is cleared', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        final other = SoftwareDeviceKey.random();
        switch (call.method) {
          case 'generate':
            final jwk = await fake.generate().then((_) => fake.publicJwk());
            return Uint8List.fromList(
                [0x04, ...unB64url(jwk['x']!), ...unB64url(jwk['y']!)]);
          case 'sign':
            return p1363ToDer(await other.sign(call.arguments as Uint8List));
          case 'clear':
            return null;
        }
        return null;
      });
      await expectLater(AndroidDeviceKey().generate(), throwsStateError);
      expect(calls.last, 'clear');
    });

    test('native errors become a BM StateError without platform detail', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        throw PlatformException(
            code: 'keystore_failed', message: 'secret internal detail');
      });
      final key = AndroidDeviceKey();
      await expectLater(
        key.sign(message),
        throwsA(isA<StateError>().having(
            (e) => e.message, 'message', isNot(contains('secret')))),
      );
      expect(await key.exists(), isFalse);
    });

    test('malformed public point is rejected', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async => Uint8List(64));
      await expectLater(
          AndroidDeviceKey().publicJwk(), throwsFormatException);
    });
  });
}
