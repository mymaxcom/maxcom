// The shared box QR vectors (packages/core/test/fixtures/box-qr-vectors.json), read in place, and a box that answers
// as the vector's box would: its `GET /api/box/info`, then whatever the test wants for the completion route.

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../features/fakes.dart';

List<Map<String, dynamic>> boxQrCases() {
  final f = File('../../packages/core/test/fixtures/box-qr-vectors.json');
  final j = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  return (j['cases'] as List).cast<Map<String, dynamic>>();
}

/// The first vector of [type] that has an HTTPS address (the phone can reach it).
Map<String, dynamic> boxQrCase(String type) => boxQrCases().firstWhere(
  (c) => (c['payload'] as Map)['type'] == type && (c['payload'] as Map)['box'] != '' && (c['payload'] as Map)['caSha256'] != null,
);

String boxQrText(String type) => boxQrCase(type)['text'] as String;
Map<String, dynamic> boxQrPayloadJson(String type) => (boxQrCase(type)['payload'] as Map).cast<String, dynamic>();

/// `GET /api/box/info` as the vector's own box answers it, in [state].
http.Response boxInfoResponse(String type, {String state = 'setup', String? keyFp}) {
  final p = boxQrPayloadJson(type);
  return jsonResponse(200, {
    'boxId': p['boxId'],
    'keyFp': keyFp ?? p['keyFp'],
    'name': p['name'],
    'state': state,
    'reason': state == 'recovery' ? 'no_admin' : 'none',
    'linked': p['linked'],
    'https': true,
    'caSha256': p['caSha256'],
  });
}

const completedBody = {
  'deviceId': 'dev-new',
  'userId': 'user-new',
  'roles': ['admin'],
  'pinRequired': false,
  'appLock': true,
  'recoveryCode': 'ABCD-EFGH-JKLM-NPQR',
  'surauId': 'abcdefghijkl',
  'boxName': 'MAXCOM Dewan Utama',
  'surauName': 'Surau Al-Hidayah',
};
