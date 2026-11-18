// Plan 14 Task 14: the header that tells the cloud which surau a Pentadbir MAXCOM works in. Ops build only; the
// gateway reaches this through `if (kOpsBuild)`, so the public binary carries neither the name nor the code.
// The server honours it only for a session of an ops device (a surau user sending it gets 403).

import 'package:http/http.dart' as http;

import '../../box/box_client.dart';

/// The acting-surau header (decision: Plan 14 section 3.1).
const String opsSurauHeader = 'X-Maxcom-Surau';

/// The fleet routes name their surau (or none) in the path; the header is not sent to them.
bool isFleetPath(String path) =>
    path.startsWith('/api/fleet/') || path == '/api/suraus' || path.startsWith('/api/suraus/');

/// [client] with every tenant request carrying the header for [surauId].
BoxClient withActingSurau(BoxClient client, String surauId) => BoxClient(
  client.box,
  _ActingSurauClient(client.client, surauId),
  connect: client.connect,
  read: client.read,
);

class _ActingSurauClient extends http.BaseClient {
  _ActingSurauClient(this._inner, this._surauId);

  final http.Client _inner;
  final String _surauId;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (!isFleetPath(request.url.path)) request.headers[opsSurauHeader] = _surauId;
    return _inner.send(request);
  }

  /// The inner client belongs to the app (shared with the plain gateway); never closed here.
  @override
  void close() {}
}
