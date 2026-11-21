// Off the web there is no browser to save from: the store is the in-memory
// one (the Android publisher records to Movies/MAXCOM itself).

import 'dart:typed_data';

import 'recordings_store.dart';

RecordingsStore openStore({
  required String dbName,
  Future<void> Function(String fileName, Object blob)? downloader,
}) => MemoryRecordingsStore();


/// Off the browser there is no download: the joined recording is not saved this way.
Future<void> saveBytesToDevice(String fileName, Uint8List bytes, String mime) async {
  throw UnsupportedError('no browser download here');
}
