import 'dart:typed_data';

/// A minimal well-formed MP4: ftyp, moov (mvhd and one video track) and mdat; [moovLast] puts moov after the media.
Uint8List mp4({String codec = 'avc1', int width = 1280, int height = 720, double seconds = 30, bool moovLast = false}) {
  Uint8List box(String type, List<Uint8List> parts) {
    final body = BytesBuilder()..add([for (final p in parts) ...p]);
    final b = body.toBytes();
    final out = ByteData(8 + b.length)..setUint32(0, 8 + b.length);
    final bytes = out.buffer.asUint8List()..setRange(4, 8, type.codeUnits)..setRange(8, 8 + b.length, b);
    return bytes;
  }

  Uint8List zeros(int n) => Uint8List(n);
  final mvhdBody = ByteData(100)
    ..setUint32(12, 1000)
    ..setUint32(16, (seconds * 1000).round());
  final hdlr = zeros(24)..setRange(8, 12, 'vide'.codeUnits);
  final entry = ByteData(86)..setUint32(0, 86);
  final entryBytes = entry.buffer.asUint8List()..setRange(4, 8, codec.codeUnits);
  entry
    ..setUint16(32, width)
    ..setUint16(34, height);
  final stsdHead = ByteData(8)..setUint32(4, 1);
  final stsd = box('stsd', [stsdHead.buffer.asUint8List(), entryBytes]);
  final trak = box('trak', [
    box('mdia', [box('hdlr', [hdlr]), box('minf', [box('stbl', [stsd])])]),
  ]);
  final moov = box('moov', [box('mvhd', [mvhdBody.buffer.asUint8List()]), trak]);
  final ftyp = box('ftyp', [Uint8List.fromList('isom'.codeUnits), zeros(4), Uint8List.fromList('isomavc1'.codeUnits)]);
  final mdat = box('mdat', [zeros(64)]);
  return Uint8List.fromList([...ftyp, ...(moovLast ? [...mdat, ...moov] : [...moov, ...mdat])]);
}
