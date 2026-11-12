import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

import '../features/enrol/enrol_flow.dart' show TrustError;
import 'box_client.dart' show BoxUnreachable;

const bool pinsCa = true;

String _pem(Uint8List der) {
  final b64 = base64.encode(der);
  final lines = <String>[];
  for (var i = 0; i < b64.length; i += 64) {
    lines.add(b64.substring(i, i + 64 > b64.length ? b64.length : i + 64));
  }
  return '-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n';
}

/// Trusts only [caDer], no system roots. Without a CA there is no client:
/// a plain one would trust the system roots instead of the surau's own CA.
http.Client createClient(Uint8List? caDer, Duration connect) {
  if (caDer == null) throw const TrustError('Sijil akar tiada. Daftar semula');
  final ctx = SecurityContext(withTrustedRoots: false);
  try {
    ctx.setTrustedCertificatesBytes(utf8.encode(_pem(caDer)));
  } on TlsException {
    throw const TrustError('Sijil akar tidak sah');
  }
  final hc = HttpClient(context: ctx);
  hc.connectionTimeout = connect;
  return IOClient(hc);
}

/// Trusts the platform's system roots, with full certificate checks. Only
/// for the cloud on its public domain.
http.Client createSystemClient(Duration connect) {
  final hc = HttpClient(context: SecurityContext(withTrustedRoots: true));
  hc.connectionTimeout = connect;
  return IOClient(hc);
}

/// GET [url] accepting any certificate. Only for public data that is then
/// checked against a hash from the QR. Bounded in size and time.
Future<Uint8List> fetchUnverified(
  Uri url, {
  required int maxBytes,
  required Duration connect,
  required Duration read,
}) async {
  final hc = HttpClient(context: SecurityContext(withTrustedRoots: false))
    ..connectionTimeout = connect
    ..badCertificateCallback = (_, _, _) => true;
  try {
    final req = await hc.getUrl(url).timeout(connect + read);
    final res = await req.close().timeout(read);
    if (res.statusCode != 200) {
      await res.drain<void>();
      throw const TrustError('Sijil akar tidak dapat diambil dari kotak');
    }
    final out = BytesBuilder(copy: false);
    await for (final chunk in res.timeout(read)) {
      out.add(chunk);
      if (out.length > maxBytes) {
        throw const TrustError('Sijil akar tidak sah');
      }
    }
    return out.takeBytes();
  } on TrustError {
    rethrow;
  } on Exception catch (e) {
    throw BoxUnreachable(e);
  } finally {
    hc.close(force: true);
  }
}

/// The leaf certificate (DER) the box presents, taken from a HEAD request
/// over a connection that trusts ONLY [caDer] (no system roots). The
/// handshake therefore succeeded under the enrolled root CA check; a failed
/// handshake, a non-https [origin] or a missing certificate gives null.
Future<Uint8List?> fetchPinnedLeaf(
  Uri origin,
  Uint8List caDer, {
  required Duration connect,
  required Duration read,
}) async {
  if (origin.scheme != 'https') return null;
  final HttpClient hc;
  try {
    final ctx = SecurityContext(withTrustedRoots: false)..setTrustedCertificatesBytes(utf8.encode(_pem(caDer)));
    hc = HttpClient(context: ctx);
  } on Object {
    return null;
  }
  hc.connectionTimeout = connect;
  try {
    final req = await hc
        .headUrl(origin.replace(path: '/api/pki/root.cer', query: '', fragment: ''))
        .timeout(connect + read);
    final res = await req.close().timeout(read);
    await res.drain<void>();
    final der = res.certificate?.der;
    return der == null || der.isEmpty ? null : Uint8List.fromList(der);
  } on Object {
    return null;
  } finally {
    hc.close(force: true);
  }
}
