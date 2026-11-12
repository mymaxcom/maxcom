// The resumable upload protocol (Plan 6 Task 10, spec 12b B), speaking to the
// YouTube upload URI the cloud minted: the device PUTs the bytes straight to
// YouTube and never holds a Google token. The Kotlin worker mirrors this file.
//
//   PUT <uri>  Content-Range: bytes <from>-<to>/<total>   (8 MB chunks)
//   308 + Range: bytes=0-<n>   -> continue at n + 1 (no Range: nothing kept)
//   200 | 201 + video JSON     -> done, videoId = id
//   PUT <uri>  Content-Range: bytes */<total>, empty body -> where are we?
//   404 | 410                  -> the session is gone: begin a new one
//   403 quotaExceeded | uploadLimitExceeded -> quota
//   5xx, 429 and network errors -> wait 5 s, 15 s, 60 s, 5 min (then 5 min
//   again, without end while the caller does not stop), probe, continue.
//
// The URI is a bearer secret: it is never put in an exception, a log line or
// a string this file returns.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// True only for an address the bytes may be sent to: https, no user info and
/// a host of `googleapis.com` itself or a subdomain of it (YouTube's upload
/// address is `www.googleapis.com`). The cloud already checks the address it
/// mints; the device checks again before the first PUT and when it resumes
/// (a stored address is a bearer secret and must never lead elsewhere).
bool isYoutubeUploadUri(String raw) {
  final Uri u;
  try {
    u = Uri.parse(raw);
  } on FormatException {
    return false;
  }
  if (u.scheme != 'https' || u.userInfo.isNotEmpty) return false;
  final host = u.host.toLowerCase();
  return host == 'www.googleapis.com' || host.endsWith('.googleapis.com');
}

/// Size of one PUT.
const int resumableChunkBytes = 8 * 1024 * 1024;

/// Waits after a failed request, in order; the last one repeats.
const List<Duration> resumableBackoff = [
  Duration(seconds: 5),
  Duration(seconds: 15),
  Duration(seconds: 60),
  Duration(minutes: 5),
];

/// Where the bytes come from: a file read in slices, never whole.
abstract class ByteSource {
  int get length;

  /// Bytes `[start, end)`.
  Future<Uint8List> read(int start, int end);
}

class MemoryByteSource implements ByteSource {
  MemoryByteSource(this.bytes);

  final Uint8List bytes;

  @override
  int get length => bytes.length;

  @override
  Future<Uint8List> read(int start, int end) async =>
      Uint8List.sublistView(bytes, start, end);
}

sealed class UploadOutcome {
  const UploadOutcome();
}

/// YouTube has the whole file; [videoId] is the new video.
class UploadComplete extends UploadOutcome {
  const UploadComplete(this.videoId);
  final String videoId;
}

/// A probe answer: the next byte YouTube wants.
class UploadOffset extends UploadOutcome {
  const UploadOffset(this.offset);
  final int offset;
}

/// 404 or 410 on the session URI: ask the cloud for a new session.
class UploadSessionLost extends UploadOutcome {
  const UploadSessionLost();
}

/// `quotaExceeded` or `uploadLimitExceeded` from YouTube in mid-upload.
class UploadQuotaHit extends UploadOutcome {
  const UploadQuotaHit(this.reason);
  final String reason;
}

/// The caller asked to stop (pause, policy change); [offset] is reached.
class UploadStopped extends UploadOutcome {
  const UploadStopped(this.offset);
  final int offset;
}

/// A refusal that retrying cannot fix. [reason] is Google's reason code.
class UploadRejected extends UploadOutcome {
  const UploadRejected(this.status, this.reason);
  final int status;
  final String reason;
}

class ResumableClient {
  ResumableClient({
    required this.client,
    this.chunkSize = resumableChunkBytes,
    this.backoff = resumableBackoff,
    Future<void> Function(Duration)? sleep,
  }) : _sleep = sleep ?? Future<void>.delayed;

  final http.Client client;
  final int chunkSize;
  final List<Duration> backoff;
  final Future<void> Function(Duration) _sleep;

  /// Sends [source] from [offset]. Returns when YouTube has everything
  /// ([UploadComplete]), the session is gone, the quota is hit, the request
  /// is refused for good, or [shouldStop] says so (checked between requests).
  Future<UploadOutcome> upload(
    Uri uri,
    ByteSource source, {
    int offset = 0,
    void Function(int offset)? onProgress,
    bool Function()? shouldStop,
  }) async {
    final total = source.length;
    if (total <= 0) return const UploadRejected(0, 'empty_file');
    var at = offset;
    var attempt = 0;
    var needProbe = false;
    while (true) {
      if (shouldStop?.call() ?? false) return UploadStopped(at);
      final http.Response r;
      try {
        if (needProbe) {
          r = await _probeRequest(uri, total);
        } else {
          final end = (at + chunkSize < total ? at + chunkSize : total);
          final body = await source.read(at, end);
          r = await _put(uri, body, 'bytes $at-${end - 1}/$total');
        }
      } on Object {
        await _sleep(backoff[_min(attempt++, backoff.length - 1)]);
        needProbe = true;
        continue;
      }
      final out = _classify(r, probe: needProbe);
      if (out == null) {
        // 5xx / 429: wait, then ask where the server is.
        await _sleep(backoff[_min(attempt++, backoff.length - 1)]);
        needProbe = true;
        continue;
      }
      attempt = 0;
      switch (out) {
        case UploadOffset(:final offset):
          // The server may be behind what we sent; trust it. When it already
          // has every byte but has not said "done", ask once more: the
          // probe answers 200 with the video.
          at = offset;
          needProbe = at >= total;
          if (needProbe) await _sleep(backoff.first);
          onProgress?.call(at);
        case UploadComplete():
          onProgress?.call(total);
          return out;
        default:
          return out;
      }
    }
  }

  /// Where does YouTube want the next byte?
  Future<UploadOutcome> probe(Uri uri, int total) async {
    final r = await _probeRequest(uri, total);
    return _classify(r, probe: true) ?? UploadRejected(r.statusCode, 'server');
  }

  Future<http.Response> _probeRequest(Uri uri, int total) =>
      _put(uri, Uint8List(0), 'bytes */$total');

  Future<http.Response> _put(Uri uri, Uint8List body, String range) async {
    final req = http.Request('PUT', uri)
      ..headers['Content-Type'] = 'video/mp4'
      ..headers['Content-Range'] = range
      ..bodyBytes = body;
    return http.Response.fromStream(await client.send(req));
  }

  /// Null means "retry later" (5xx, 429).
  UploadOutcome? _classify(http.Response r, {required bool probe}) {
    final s = r.statusCode;
    if (s == 200 || s == 201) {
      final id = _videoId(r.body);
      return id == null
          ? const UploadRejected(200, 'no_video_id')
          : UploadComplete(id);
    }
    if (s == 308) return UploadOffset(_offsetOf(r.headers['range']));
    if (s == 404 || s == 410) return const UploadSessionLost();
    if (s >= 500 || s == 429) return null;
    final reason = _reason(r.body);
    if (s == 403 &&
        (reason == 'quotaExceeded' || reason == 'uploadLimitExceeded')) {
      return UploadQuotaHit(reason);
    }
    return UploadRejected(s, reason);
  }

  static int _offsetOf(String? range) {
    final m = RegExp(r'bytes=0-(\d+)').firstMatch(range ?? '');
    return m == null ? 0 : int.parse(m.group(1)!) + 1;
  }

  static String? _videoId(String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map && j['id'] is String && (j['id'] as String).isNotEmpty) {
        return j['id'] as String;
      }
    } on FormatException {
      // fall through
    }
    return null;
  }

  static String _reason(String body) {
    try {
      final j = jsonDecode(body);
      if (j is Map && j['error'] is Map) {
        final e = j['error'] as Map;
        final errors = e['errors'];
        if (errors is List && errors.isNotEmpty && errors.first is Map) {
          final r = (errors.first as Map)['reason'];
          if (r is String) return r;
        }
        if (e['status'] is String) return e['status'] as String;
      }
    } on FormatException {
      // fall through
    }
    return 'unknown';
  }

  static int _min(int a, int b) => a < b ? a : b;
}
