// Fakes shared by the enrol and unlock tests: a deterministic DeviceKey,
// an in-memory trust check, a biometric PIN seal and a box answered by a
// MockClient. Nothing here talks to a platform channel or the network.

import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/box/device_key.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/unlock/biometric_pin.dart';

/// The surau and its helper, as `GET /api/surau/info` answers.
const fixtureInfoJson = <String, Object?>{
  'name': 'Surau D\'Waqaf',
  'kind': 'surau',
  'shortAddress': 'Jalan Mahabbah 3, Taman Mahabbah',
  'help': {
    'name': 'Encik Hafiz',
    'phone': '012-345 6789',
    'email': 'hafiz@contoh.my',
  },
};

/// 2026-11-04 22:45 Malaysian time: the same day as the tests' clock, so
/// the invitation line reads "Jemputan sah hingga 10:45 malam".
const int fixtureExpToday = 1793803500000;

/// Enrolment payload for a loopback box, as the box's QR would carry it,
/// with the people-and-place fields of contract 2026-11-04. [legacy] omits
/// them, as a payload from an older box would.
String fixturePayload({
  String box = 'https://127.0.0.1:8443',
  String? caSha256 =
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  int exp = 1893456000000,
  String user = 'Ustaz Ali',
  String code = 'ABCD-EFGH-2345',
  List<String> roles = const ['admin'],
  String? invitedBy = 'Encik Hafiz',
  bool legacy = false,
  Object? appLock,
}) {
  final m = <String, Object?>{
    'v': 1,
    'mode': 'ip',
    'box': box,
    'boxId': '0123456789abcdef',
    'caSha256': ?caSha256,
    'code': code,
    'user': user,
    'exp': exp,
    'appLock': ?appLock,
    if (!legacy) ...{
      'surau': {'name': 'Surau D\'Waqaf', 'kind': 'surau'},
      'help': fixtureInfoJson['help'],
      'roles': roles,
      'invitedBy': ?invitedBy,
    },
  };
  return 'surau1:${base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '')}';
}

const fixtureJwk = <String, String>{
  'kty': 'EC',
  'crv': 'P-256',
  'x': 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  'y': 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

/// Signs by hashing nothing: the "signature" is the first 64 bytes of the
/// message repeated, so a test can recompute it. Records every call.
class FakeDeviceKey implements DeviceKey {
  FakeDeviceKey({this.present = false});

  bool present;
  int generateCalls = 0;
  int clearCalls = 0;
  final List<Uint8List> signed = [];

  static Uint8List fakeSignature(Uint8List message) {
    final out = Uint8List(64);
    for (var i = 0; i < 64; i++) {
      out[i] = message.isEmpty ? 0 : message[i % message.length];
    }
    return out;
  }

  @override
  Future<bool> exists() async => present;

  @override
  Future<Map<String, String>> generate() async {
    generateCalls++;
    present = true;
    return Map.of(fixtureJwk);
  }

  @override
  Future<Map<String, String>> publicJwk() async {
    if (!present) throw StateError('no key');
    return Map.of(fixtureJwk);
  }

  @override
  Future<Uint8List> sign(Uint8List message) async {
    if (!present) throw StateError('no key');
    signed.add(message);
    return fakeSignature(message);
  }

  @override
  Future<void> clear() async {
    clearCalls++;
    present = false;
  }
}

class FakeTrust implements EnrolTrust {
  FakeTrust({this.fail = false, this.pinsCa = false});

  bool fail;

  @override
  final bool pinsCa;
  final List<(Uri, String?)> calls = [];
  final List<String?> commits = [];

  @override
  Future<void> commit(String? caSha256) async {
    commits.add(caSha256);
  }

  @override
  Future<void> establish(Uri box, String? caSha256) async {
    calls.add((box, caSha256));
    if (fail) throw const TrustError('Sijil akar tidak sepadan');
  }
}

class FakeBiometricPin implements BiometricPin {
  FakeBiometricPin({this.isAvailable = false, this.sealed});

  bool isAvailable;
  bool sealFails = false;
  String? sealed;

  /// What [open] answers; null = the prompt failed or was cancelled.
  String? Function()? onOpen;

  /// When set, [open] throws it (BiometricCancelled, BiometricLockedOut).
  Object? openThrows;
  int openCalls = 0;

  @override
  Future<bool> available() async => isAvailable;

  @override
  Future<bool> hasSealedPin() async => sealed != null;

  @override
  Future<bool> seal(String pin) async {
    if (sealFails) return false;
    sealed = pin;
    return true;
  }

  @override
  Future<String?> open() async {
    openCalls++;
    final t = openThrows;
    if (t != null) throw t;
    final f = onOpen;
    return f != null ? f() : sealed;
  }

  @override
  Future<void> clear() async => sealed = null;
}

/// A box that answers from [handler]; every request is kept in [seen].
class FakeBox {
  FakeBox(this.handler);

  final Future<http.Response> Function(http.Request r) handler;
  final List<http.Request> seen = [];

  http.Request? byPath(String path) {
    for (final r in seen) {
      if (r.url.path == path) return r;
    }
    return null;
  }

  Map<String, dynamic> bodyOf(String path) =>
      jsonDecode(byPath(path)!.body) as Map<String, dynamic>;

  BoxClient client(Uri box) => BoxClient(
    box,
    MockClient((r) async {
      seen.add(r);
      return handler(r);
    }),
  );
}

http.Response jsonResponse(
  int status,
  Object body, {
  Map<String, String>? headers,
}) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json', ...?headers},
);

const sessionJson = {
  'token': 'tok-1',
  'expiresAt': '2026-11-05T00:00:00.000Z',
  'user': {
    'id': 'u1',
    'name': 'Ustaz Ali',
    'roles': ['admin'],
  },
};

/// A box that enrols and unlocks happily.
Future<http.Response> happyBox(http.Request r) async {
  switch (r.url.path) {
    case '/api/enrol/complete':
      return jsonResponse(200, {
        'deviceId': 'dev-1',
        'userId': 'u1',
        'roles': ['admin'],
        'pinRequired': false,
      });
    case '/api/auth/challenge':
      return jsonResponse(200, {'nonce': 'nonce-1', 'expiresAt': 'x'});
    case '/api/auth/unlock':
      return jsonResponse(200, sessionJson);
    case '/api/surau/info':
      return jsonResponse(200, fixtureInfoJson);
  }
  return jsonResponse(404, {
    'errors': ['tiada'],
  });
}

EnrolledBox fixtureBox({
  List<String> roles = const ['admin'],
  bool appLock = true,
}) => EnrolledBox(
  box: Uri.parse('https://127.0.0.1:8443'),
  boxId: '0123456789abcdef',
  deviceId: 'dev-1',
  userId: 'u1',
  userName: 'Ustaz Ali',
  roles: roles,
  caSha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  appLock: appLock,
);

/// Captures the URIs a help card tried to open.
class FakeOpener {
  final List<Uri> opened = [];

  Future<bool> call(Uri uri) async {
    opened.add(uri);
    return true;
  }
}

/// A fixed clock: 2026-11-04 14:30 UTC (22:30 in Malaysia).
DateTime fixedNow() => DateTime.utc(2026, 11, 4, 14, 30);

/// Malaysian time without the host's zone: UTC+8, read as local fields.
DateTime fixedToLocal(DateTime t) => t.toUtc().add(const Duration(hours: 8));
