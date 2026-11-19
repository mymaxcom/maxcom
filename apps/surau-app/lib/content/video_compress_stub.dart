// Web and any platform without dart:io: no on-phone compression (a file must already be within the limits).

bool get canCompressVideo => false;

Future<String?> compressVideoTo720(String path, void Function(double fraction) onProgress) async => null;

Future<void> clearCompressedVideos() async {}
