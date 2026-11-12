// Off the web there is no browser to save from: the store is the in-memory
// one (the Android publisher records to Movies/MAXCOM itself).

import 'recordings_store.dart';

RecordingsStore openStore({
  required String dbName,
  Future<void> Function(String fileName, Object blob)? downloader,
}) => MemoryRecordingsStore();
