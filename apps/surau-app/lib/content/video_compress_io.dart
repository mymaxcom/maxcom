// On-phone compression (Android only, v1) with `video_compress` (MediaCodec through the platform transcoder):
// the video is scaled to at most 1280x720 and written as H.264 MP4. iOS keeps files as they are.

import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:video_compress/video_compress.dart';

bool get canCompressVideo => !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

/// Deletes the compressed copies `video_compress` left in the phone's cache (each can be tens of megabytes).
Future<void> clearCompressedVideos() async {
  try {
    await VideoCompress.deleteAllCache();
  } on Object {
    /* nothing to clear, or the plugin is not there */
  }
}

/// The path of the compressed copy, or null when it could not be made.
Future<String?> compressVideoTo720(String path, void Function(double fraction) onProgress) async {
  final sub = VideoCompress.compressProgress$.subscribe((p) => onProgress((p / 100).clamp(0.0, 1.0)));
  try {
    final info = await VideoCompress.compressVideo(
      path,
      quality: VideoQuality.Res1280x720Quality,
      deleteOrigin: false,
      includeAudio: true,
      frameRate: 30,
    );
    return info?.path;
  } finally {
    sub.unsubscribe();
  }
}
