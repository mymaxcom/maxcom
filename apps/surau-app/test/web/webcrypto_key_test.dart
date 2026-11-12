@TestOn('browser')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/device_key.dart';
import 'package:surau_app/box/device_key_software.dart';
import 'package:surau_app/box/device_key_web.dart';
import 'package:web/web.dart' as web;

void main() {
  final message = Uint8List.fromList(utf8.encode('surau-unlock\nbox\ndev\nn'));
  test('secure context with subtle crypto', () {
    expect(web.window.isSecureContext, isTrue);
  });

  var n = 0;
  WebCryptoDeviceKey fresh() =>
      WebCryptoDeviceKey(dbName: 'surau-device-test-${n++}-${DateTime.now().microsecondsSinceEpoch}');

  test('generate, then exists() is true after re-opening the store', () async {
    final name = 'surau-device-test-persist-${DateTime.now().microsecondsSinceEpoch}';
    final a = WebCryptoDeviceKey(dbName: name);
    expect(await a.exists(), isFalse);
    final jwk = await a.generate();
    expect(jwk.keys.toSet(), {'kty', 'crv', 'x', 'y'});
    expect(unB64url(jwk['x']!).length, 32);
    expect(unB64url(jwk['y']!).length, 32);
    final b = WebCryptoDeviceKey(dbName: name); // a new instance: new DB connection
    expect(await b.exists(), isTrue);
    expect(await b.publicJwk(), jwk);
    await b.clear();
    expect(await a.exists(), isFalse);
  });

  test('sign gives 64 bytes P1363 that the software verifier accepts', () async {
    final key = fresh();
    final jwk = await key.generate();
    for (var i = 0; i < 20; i++) {
      final m = Uint8List.fromList(utf8.encode('m$i'));
      final sig = await key.sign(m);
      expect(sig.length, 64);
      expect(verifyP256(jwk, m, sig), isTrue);
    }
    final sig = await key.sign(message);
    final flipped = Uint8List.fromList(sig)..[10] ^= 1;
    expect(verifyP256(jwk, message, flipped), isFalse);
    await key.clear();
  });

  test('the private key cannot be exported (non-extractable)', () async {
    final name = 'surau-device-test-export-${DateTime.now().microsecondsSinceEpoch}';
    final key = WebCryptoDeviceKey(dbName: name);
    await key.generate();
    // Read the stored pair straight from IndexedDB, as page script could.
    final stored = await _readRecord(name);
    final priv = stored['privateKey']! as web.CryptoKey;
    expect(priv.extractable, isFalse);
    var rejected = false;
    try {
      await web.window.crypto.subtle.exportKey('jwk', priv).toDart;
    } catch (_) {
      rejected = true;
    }
    expect(rejected, isTrue);
    await key.clear();
  });

  test('sign without a key fails with a BM error', () async {
    final key = fresh();
    await expectLater(key.sign(message), throwsStateError);
    await expectLater(key.publicJwk(), throwsStateError);
  });

  test('generate replaces the previous key', () async {
    final key = fresh();
    final a = await key.generate();
    final b = await key.generate();
    expect(a['x'] == b['x'] && a['y'] == b['y'], isFalse);
    expect(await key.publicJwk(), b);
    await key.clear();
  });
}

Future<JSObject> _readRecord(String dbName) async {
  final db = await _openDb(dbName);
  final tx = db.transaction('keys'.toJS, 'readonly');
  final req = tx.objectStore('keys').get('device-key'.toJS);
  final done = Completer<JSObject>();
  tx.oncomplete = ((web.Event _) => done.complete(req.result! as JSObject)).toJS;
  final out = await done.future;
  db.close();
  return out;
}

Future<web.IDBDatabase> _openDb(String name) {
  final c = Completer<web.IDBDatabase>();
  final req = web.window.indexedDB.open(name, 1);
  req.onsuccess = ((web.Event _) => c.complete(req.result! as web.IDBDatabase)).toJS;
  return c.future;
}

