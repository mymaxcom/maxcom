import 'dart:async';
import 'dart:typed_data';

import 'package:http/browser_client.dart';
import 'package:http/http.dart' as http;

import '../features/enrol/enrol_flow.dart' show TrustError;
import 'box_client.dart' show BoxUnreachable;

const bool pinsCa = false;

/// The browser decides who to trust; [caDer] and [connect] do not apply.
http.Client createClient(Uint8List? caDer, Duration connect) =>
    BrowserClient();

/// The browser's own trust, which is the system's.
http.Client createSystemClient(Duration connect) => BrowserClient();

/// Through the browser's own trust (the root CA must be installed).
Future<Uint8List> fetchUnverified(
  Uri url, {
  required int maxBytes,
  required Duration connect,
  required Duration read,
}) async {
  final c = BrowserClient();
  try {
    final res = await c.get(url).timeout(connect + read);
    if (res.statusCode != 200) {
      throw const TrustError('Sijil akar tidak dapat diambil dari kotak');
    }
    if (res.bodyBytes.length > maxBytes) {
      throw const TrustError('Sijil akar tidak sah');
    }
    return res.bodyBytes;
  } on TrustError {
    rethrow;
  } on Exception catch (e) {
    throw BoxUnreachable(e);
  } finally {
    c.close();
  }
}

/// The browser decides trust; the app has no certificate to compare.
Future<Uint8List?> fetchPinnedLeaf(
  Uri origin,
  Uint8List caDer, {
  required Duration connect,
  required Duration read,
}) async => null;
