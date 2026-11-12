// Trust in the box's TLS certificate.
//
// Android: the app trusts exactly one root, the surau's own CA. Its sha256
// comes from the admin's enrolment QR; the DER is downloaded once from
// `/api/pki/root.cer` over a connection that accepts any certificate, and
// kept only when its sha256 equals the QR's. After that every request uses
// a client whose `SecurityContext` holds that one root and no system roots.
//
// Web: the browser decides. The root CA must already be installed and
// trusted on the device, so the client is a plain browser client.

import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:pointycastle/digests/sha256.dart';

import '../features/enrol/enrol_flow.dart';
import 'box_client.dart';
import 'session_store.dart';
import 'trust_platform_io.dart'
    if (dart.library.js_interop) 'trust_platform_web.dart'
    as platform;

export '../features/enrol/enrol_flow.dart' show TrustError;

/// Lower-case hex sha256 of [bytes].
String sha256Hex(Uint8List bytes) {
  final out = SHA256Digest().process(bytes);
  final b = StringBuffer();
  for (final v in out) {
    b.write(v.toRadixString(16).padLeft(2, '0'));
  }
  return b.toString();
}

/// Largest root certificate the app will accept from `/api/pki/root.cer`.
const int maxRootCaBytes = 16 * 1024;

/// The only domain a cloud may use with public certificates. The cloud
/// address comes from the box's enrolment QR, so without this a tampered
/// address on any public host would pass normal certificate checks.
const String _publicCloudDomain = 'mymaxcom.my';

/// True when [b] is a client to the cloud on its public domain: a cloud is
/// set, [EnrolledBox.box] has the same origin (scheme, host, port) as it
/// (the shape `boxAt(box, cloud)` gives), the scheme is https and the host
/// is [_publicCloudDomain] or a subdomain of it. Such a connection presents
/// a public certificate, so the system roots decide. Any other cloud, and
/// the box's own LAN address, stay pinned to the surau's CA.
bool usesPublicTls(EnrolledBox b) {
  final cloud = b.cloud;
  if (cloud == null) return false;
  final box = b.box;
  if (box.scheme != 'https' || cloud.scheme != 'https') return false;
  if (box.host.isEmpty || box.host != cloud.host) return false;
  if (box.port != cloud.port) return false;
  return box.host == _publicCloudDomain ||
      box.host.endsWith('.$_publicCloudDomain');
}

class TrustStore {
  TrustStore({
    this.connect = const Duration(seconds: 8),
    this.read = const Duration(seconds: 10),
  });

  final Duration connect;
  final Duration read;

  /// True where the app pins the CA itself (Android); false where the
  /// browser's trust store decides (web).
  bool get pinsCa => platform.pinsCa;

  /// A client that trusts only [caDer] (Android) or the browser's own
  /// trust (web). Where the app pins the CA a null [caDer] is a
  /// [TrustError], never a system-roots client. Throws [TrustError] when
  /// [caDer] is not a usable certificate.
  Future<http.Client> pinnedClient(Uint8List? caDer) async =>
      pinnedClientSync(caDer);

  http.Client pinnedClientSync(Uint8List? caDer) {
    // Where the app pins the CA there is no unpinned client: without the
    // CA the system roots would decide who the box is.
    if (pinsCa && caDer == null) {
      throw const TrustError('Sijil akar tiada. Daftar semula');
    }
    try {
      return platform.createClient(caDer, connect);
    } on TrustError {
      rethrow;
    } on Object {
      throw const TrustError('Sijil akar tidak sah');
    }
  }

  /// Downloads `/api/pki/root.cer` without trusting the connection, and
  /// returns the DER only when its sha256 equals [caSha256] (case
  /// insensitive). The bytes are public; the hash from the QR is what makes
  /// them trustworthy.
  Future<Uint8List> fetchAndCheckRootCa(Uri box, String caSha256) async {
    final want = caSha256.toLowerCase();
    final der = await platform.fetchUnverified(
      box.replace(path: '/api/pki/root.cer', query: ''),
      maxBytes: maxRootCaBytes,
      connect: connect,
      read: read,
    );
    if (sha256Hex(der) != want) {
      throw const TrustError('Sijil akar tidak sepadan');
    }
    return der;
  }

  /// Web: the sha256 of the root the box serves, fetched through the
  /// browser's trust, for display next to the bootstrap printout. Null
  /// where the app pins the CA itself or the box serves none.
  Future<String?> servedCaFingerprint(Uri box) async {
    if (pinsCa) return null;
    try {
      final der = await platform.fetchUnverified(
        box.replace(path: '/api/pki/root.cer', query: ''),
        maxBytes: maxRootCaBytes,
        connect: connect,
        read: read,
      );
      return sha256Hex(der);
    } on Exception {
      return null;
    }
  }

  /// The leaf certificate (DER) the enrolled box presents right now,
  /// received over a connection pinned to the CA kept at enrolment. Null
  /// where the browser decides trust (web), when no CA is kept, or when the
  /// pinned handshake fails. Used only by the Android preview WebView.
  Future<Uint8List?> boxLeaf(EnrolledBox b, CaDerSource cas) async {
    final sha = b.caSha256;
    if (!pinsCa || sha == null) return null;
    final der = await cas.loadCaDer(sha);
    if (der == null) return null;
    return platform.fetchPinnedLeaf(b.box, der, connect: connect, read: read);
  }

  /// A [BoxClient] for an enrolled box, pinned to the CA kept at enrolment.
  /// Throws [TrustError] when the pinned CA is missing (the app was
  /// enrolled elsewhere or its storage was cleared): the user must enrol
  /// again.
  Future<BoxClient> boxClient(EnrolledBox b, CaDerSource cas) async {
    // The cloud on its public domain presents a public certificate: system
    // roots, no surau CA needed. Never true for the box's LAN address.
    if (usesPublicTls(b)) {
      return BoxClient(
        b.box,
        platform.createSystemClient(connect),
        connect: connect,
        read: read,
      );
    }
    final sha = b.caSha256;
    Uint8List? der;
    if (pinsCa) {
      if (sha == null) {
        throw const TrustError('Sijil akar tiada. Daftar semula');
      }
      der = await cas.loadCaDer(sha);
      if (der == null) {
        throw const TrustError('Sijil akar tiada. Daftar semula');
      }
    }
    return BoxClient(
      b.box,
      pinnedClientSync(der),
      connect: connect,
      read: read,
    );
  }
}

/// Where the checked root CA (public, not secret) is kept.
abstract class CaDerSource {
  Future<Uint8List?> loadCaDer(String sha256);
}

/// Real [EnrolTrust]: on Android fetches the root CA, accepts it only when
/// its sha256 equals the payload's, keeps it, and hands the enrol flow a
/// client pinned to it; on the web does nothing (the browser's trust).
class PinnedEnrolTrust implements EnrolTrust {
  PinnedEnrolTrust(this._trust, this._sink);

  final TrustStore _trust;
  final SessionStore _sink;
  Uint8List? _pending;

  @override
  bool get pinsCa => _trust.pinsCa;

  @override
  Future<void> establish(Uri box, String? caSha256) async {
    _pending = null;
    if (!_trust.pinsCa) return;
    if (caSha256 == null) {
      throw const TrustError('Kod QR pendaftaran tidak sah');
    }
    final der = await _trust.fetchAndCheckRootCa(box, caSha256);
    // Prove the bytes are a usable certificate before anything is used.
    _trust.pinnedClientSync(der).close();
    // Held in memory for the pinned client only. A QR that is never followed by a successful join (a copied or
    // forged one) must leave nothing on the phone: [commit] stores it once the join succeeded.
    _pending = der;
  }

  @override
  Future<void> commit(String? caSha256) async {
    final der = _pending;
    if (!_trust.pinsCa || der == null) return;
    final sha = sha256Hex(der);
    if (caSha256 != null && caSha256 != sha) return;
    await _sink.saveCaDer(sha, der);
  }

  /// The `clientFor` of [EnrolFlow]: pinned to the CA just checked.
  BoxClient clientFor(Uri box) => BoxClient(
    box,
    _trust.pinnedClientSync(_pending),
    connect: _trust.connect,
    read: _trust.read,
  );
}
