// The cloud's catch-up upload routes (Plan 6 Task 5), always on the cloud
// base: `POST /api/youtube/upload/begin|done` and `GET /api/youtube/quota`.
// The cloud opens the YouTube resumable session and hands back its URI; the
// device never sees a Google token. The URI is a bearer secret, so nothing
// in this file prints it.

import 'dart:typed_data';

import '../box/box_client.dart';

/// Which part of a split recording a video is (`Bahagian 2 daripada 4`).
class UploadPartRef {
  const UploadPartRef(this.index, this.count);

  final int index;
  final int count;

  Map<String, dynamic> toJson() => {'index': index, 'count': count};
}

class UploadBeginRequest {
  const UploadBeginRequest({
    required this.kuliahId,
    required this.bytes,
    this.part,
    this.replaceLiveVideoId,
  });

  final String? kuliahId;
  final int bytes;
  final UploadPartRef? part;
  final String? replaceLiveVideoId;

  Map<String, dynamic> toJson() => {
    'kuliahId': kuliahId,
    'part': part?.toJson(),
    'bytes': bytes,
    'replaceLiveVideoId': replaceLiveVideoId,
  };
}

class UploadBegun {
  const UploadBegun({
    required this.uploadId,
    required this.uploadUri,
    required this.expiresAt,
    required this.title,
  });

  factory UploadBegun.fromJson(Map<String, dynamic> j) => UploadBegun(
    uploadId: j['uploadId'] as String,
    uploadUri: j['uploadUri'] as String,
    expiresAt: DateTime.tryParse('${j['expiresAt']}') ?? DateTime.now(),
    title: '${j['title'] ?? ''}',
  );

  final String uploadId;
  final String uploadUri;
  final DateTime expiresAt;
  final String title;

  @override
  String toString() => 'UploadBegun($uploadId)';
}

class UploadQuotaInfo {
  const UploadQuotaInfo({
    required this.uploadsToday,
    required this.uploadLimit,
    required this.resetsAt,
  });

  factory UploadQuotaInfo.fromJson(Map<String, dynamic> j) => UploadQuotaInfo(
    uploadsToday: (j['uploadsToday'] as num).toInt(),
    uploadLimit: (j['uploadLimit'] as num).toInt(),
    resetsAt: DateTime.parse(j['resetsAt'] as String),
  );

  final int uploadsToday;
  final int uploadLimit;
  final DateTime resetsAt;
}

/// The cloud answered 429 `youtube_quota`: stop until [resetsAt].
class UploadQuotaException implements Exception {
  const UploadQuotaException(this.resetsAt);
  final DateTime? resetsAt;

  @override
  String toString() => 'UploadQuotaException($resetsAt)';
}

/// The cloud answered 503 `youtube_reauthorise`, or another refusal; [code]
/// is a reason code.
class UploadApiException implements Exception {
  const UploadApiException(this.code);
  final String code;

  @override
  String toString() => 'UploadApiException($code)';
}

/// 401 on the cloud: the session expired; the person must unlock again.
class UploadNeedsUnlock implements Exception {
  const UploadNeedsUnlock();
}

abstract class UploadApi {
  Future<UploadBegun> begin(UploadBeginRequest r);

  Future<void> done(String uploadId, String videoId);

  Future<UploadQuotaInfo> quota();
}

/// Over the pinned cloud client.
class HttpUploadApi implements UploadApi {
  HttpUploadApi({required this.client, required this.token});

  final BoxClient client;
  final String token;

  @override
  Future<UploadBegun> begin(UploadBeginRequest r) async {
    try {
      return UploadBegun.fromJson(
        await client.postJson(
          '/api/youtube/upload/begin',
          r.toJson(),
          token: token,
        ),
      );
    } on SessionExpired {
      throw const UploadNeedsUnlock();
    } on BoxError catch (e) {
      if (e.status == 429) {
        // BoxError carries no body fields, so the reset time comes from the
        // quota route (it has the same Pacific-midnight figure).
        throw UploadQuotaException(await _resetsAt());
      }
      throw UploadApiException(e.code ?? 'begin_${e.status}');
    }
  }

  @override
  Future<void> done(String uploadId, String videoId) async {
    try {
      await client.postJson('/api/youtube/upload/done', {
        'uploadId': uploadId,
        'videoId': videoId,
      }, token: token);
    } on SessionExpired {
      throw const UploadNeedsUnlock();
    } on BoxError catch (e) {
      throw UploadApiException(e.code ?? 'done_${e.status}');
    }
  }

  @override
  Future<UploadQuotaInfo> quota() async {
    try {
      return UploadQuotaInfo.fromJson(
        await client.getJson('/api/youtube/quota', token: token),
      );
    } on SessionExpired {
      throw const UploadNeedsUnlock();
    } on BoxError catch (e) {
      throw UploadApiException(e.code ?? 'quota_${e.status}');
    }
  }

  Future<DateTime?> _resetsAt() async {
    try {
      return (await quota()).resetsAt;
    } on Object {
      return null;
    }
  }
}

/// Bytes of the cloud's root CA (DER) for the Android worker; null on web.
typedef CaDer = Uint8List;
