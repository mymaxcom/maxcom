// What the video editor asks of the phone and the network, behind one small interface so a test can stand in
// for the gallery, the compressor, the box and YouTube: pick a video, shrink it (Android), send it to the box,
// read the box's room, and ask YouTube (oEmbed, no key) for a title and a picture.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

import '../features/shell/box_gateway.dart';
import 'video_compress_stub.dart' if (dart.library.io) 'video_compress_io.dart' as compressor;
import 'video_rules.dart';

/// A video file as the editor sees it.
class PickedVideo {
  const PickedVideo({required this.name, required this.length, required this.open, this.path});

  final String name;
  final int length;

  /// The bytes from [start] to [end] (the whole file by default), as a stream.
  final Stream<List<int>> Function([int? start, int? end]) open;

  /// The file's path where the platform has one (the compressor needs it); null on the web.
  final String? path;
}

/// What YouTube's oEmbed answers about a video.
class YoutubeInfo {
  const YoutubeInfo({required this.title, this.author, this.thumbnailUrl});
  final String title;
  final String? author;
  final String? thumbnailUrl;
}

/// The room the box has for videos (`GET /api/assets/video/storage`).
class VideoStorage {
  const VideoStorage({required this.availableBytes, required this.usedBytes, required this.totalBytes});
  factory VideoStorage.fromJson(Map<String, dynamic> j) => VideoStorage(
    availableBytes: (j['availableBytes'] as num?)?.toInt() ?? 0,
    usedBytes: (j['usedBytes'] as num?)?.toInt() ?? 0,
    totalBytes: (j['totalBytes'] as num?)?.toInt() ?? kVideoTotalBytes,
  );
  final int availableBytes;
  final int usedBytes;
  final int totalBytes;
}

/// What the box answers for a stored video.
class UploadedVideo {
  const UploadedVideo({required this.id, required this.bytes, required this.durationSec});
  factory UploadedVideo.fromJson(Map<String, dynamic> j) => UploadedVideo(
    id: j['id'] as String,
    bytes: (j['bytes'] as num).toInt(),
    durationSec: (j['durationSec'] as num?)?.toInt() ?? 0,
  );
  final String id;
  final int bytes;
  final int durationSec;
}

abstract class VideoServices {
  const VideoServices();

  /// The gallery picker; null when the person cancels.
  Future<PickedVideo?> pick();

  /// Whether this phone can make a 720p H.264 copy (Android in v1).
  bool get canCompress;

  /// A 720p H.264 copy, [onProgress] 0..1; null when it could not be made.
  Future<PickedVideo?> compress(PickedVideo v, void Function(double fraction) onProgress);

  Future<UploadedVideo> upload(BoxGateway gateway, PickedVideo v, void Function(double fraction) onProgress);

  /// Deletes the compressed copies this phone made (the compressor's cache); nothing to do where none are made.
  Future<void> clearCompressed() async {}

  Future<VideoStorage?> storage(BoxGateway gateway);

  Future<YoutubeInfo?> oembed(String youtubeId);
}

/// The facts of a picked file (null when it is not an MP4 the app can read).
Future<Mp4Facts?> inspectVideo(PickedVideo v) => readMp4Facts((start, length) async {
  final out = BytesBuilder(copy: false);
  await for (final chunk in v.open(start, start + length)) {
    out.add(chunk);
  }
  return out.takeBytes();
}, v.length);

class RealVideoServices extends VideoServices {
  const RealVideoServices();

  @override
  bool get canCompress => compressor.canCompressVideo;

  @override
  Future<PickedVideo?> pick() async {
    final x = await ImagePicker().pickVideo(source: ImageSource.gallery);
    if (x == null) return null;
    return PickedVideo(
      name: x.name,
      length: await x.length(),
      open: ([start, end]) => x.openRead(start, end),
      path: x.path,
    );
  }

  @override
  Future<PickedVideo?> compress(PickedVideo v, void Function(double fraction) onProgress) async {
    final path = v.path;
    if (path == null || !canCompress) return null;
    final out = await compressor.compressVideoTo720(path, onProgress);
    if (out == null) return null;
    final x = XFile(out);
    return PickedVideo(name: x.name, length: await x.length(), open: ([start, end]) => x.openRead(start, end), path: out);
  }

  @override
  Future<void> clearCompressed() => compressor.clearCompressedVideos();

  @override
  Future<UploadedVideo> upload(BoxGateway gateway, PickedVideo v, void Function(double fraction) onProgress) async {
    final j = await gateway.uploadVideo(
      v.open(),
      v.length,
      onProgress: (sent) => onProgress(v.length == 0 ? 0 : sent / v.length),
    );
    return UploadedVideo.fromJson(j);
  }

  @override
  Future<VideoStorage?> storage(BoxGateway gateway) async {
    try {
      return VideoStorage.fromJson(await gateway.getFresh('/api/assets/video/storage'));
    } on Object {
      return null;
    }
  }

  @override
  Future<YoutubeInfo?> oembed(String youtubeId) async {
    try {
      final res = await http
          .get(Uri.https('www.youtube.com', '/oembed', {'url': 'https://www.youtube.com/watch?v=$youtubeId', 'format': 'json'}))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return null;
      final j = jsonDecode(utf8.decode(res.bodyBytes));
      if (j is! Map || j['title'] is! String) return null;
      return YoutubeInfo(
        title: j['title'] as String,
        author: j['author_name'] is String ? j['author_name'] as String : null,
        thumbnailUrl: j['thumbnail_url'] is String ? j['thumbnail_url'] as String : null,
      );
    } on Object {
      return null;
    }
  }
}

final videoServicesProvider = Provider<VideoServices>((ref) => const RealVideoServices());
