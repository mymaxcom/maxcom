// The rules of a Video item on the phone: the limits (twins of core's
// `VIDEO_LIMITS`, `content/video.ts`), the YouTube link reader, the MP4 reader that
// tells whether a picked file is already within the limits, and the
// cross-field checks of the editor. The box checks the same things again.

import 'dart:math';
import 'dart:typed_data';

import '../features/validate.dart' show SettingError;
import '../l10n/generated/s.dart';

/// Twin of core `VIDEO_LIMITS`; `video_rules_test` reads core's file and fails when they differ.
const int kVideoMaxHeight = 720;
const int kVideoMaxSeconds = 600;
const int kVideoMaxFileBytes = 300 * 1024 * 1024;
const int kVideoTotalBytes = 1024 * 1024 * 1024;
const int kVideoMinFreeBytes = 500 * 1024 * 1024;

const List<String> videoSources = ['upload', 'youtube', 'rakaman'];

final RegExp _ytId = RegExp(r'^[A-Za-z0-9_-]{11}$');
final RegExp _assetId = RegExp(r'^[0-9a-f]{64}$');

bool isYoutubeId(Object? v) => v is String && _ytId.hasMatch(v);

/// The 11-character id of what the person pasted (the id itself, watch,
/// youtu.be, shorts, embed, live or v links); null for anything else.
String? parseYoutubeId(String input) {
  final text = input.trim();
  if (isYoutubeId(text)) return text;
  Uri? url;
  try {
    url = Uri.parse(RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*://').hasMatch(text) ? text : 'https://$text');
  } on FormatException {
    return null;
  }
  if (url.scheme != 'https' && url.scheme != 'http') return null;
  final host = url.host.toLowerCase().replaceFirst(RegExp(r'^(www|m|music)\.'), '');
  if (host == 'youtu.be') {
    final id = url.pathSegments.isEmpty ? '' : url.pathSegments.first;
    return isYoutubeId(id) ? id : null;
  }
  if (host != 'youtube.com' && host != 'youtube-nocookie.com') return null;
  final v = url.queryParameters['v'];
  if (v != null && isYoutubeId(v)) return v;
  final segs = url.pathSegments;
  if (segs.length >= 2 && const {'shorts', 'embed', 'live', 'v'}.contains(segs.first) && isYoutubeId(segs[1])) {
    return segs[1];
  }
  return null;
}

/// A `/live/<id>` link: a broadcast, which belongs to Siaran langsung, not to a Video item.
bool isYoutubeLiveLink(String input) {
  final m = RegExp(r'youtube\.com/live/').hasMatch(input.trim());
  return m;
}

/// `12:30` or `1:05:00` or `90` as seconds; null when it is none of these.
int? parseClock(String text) {
  final t = text.trim();
  if (t.isEmpty) return null;
  final parts = t.split(':');
  if (parts.length > 3 || parts.any((p) => !RegExp(r'^\d{1,3}$').hasMatch(p))) return null;
  final n = parts.map(int.parse).toList();
  if (n.length > 1 && n.skip(1).any((x) => x > 59)) return null;
  return n.fold<int>(0, (a, x) => a * 60 + x);
}

/// Seconds as `m:ss` (or `h:mm:ss`).
String clockOf(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  final ss = (s % 60).toString().padLeft(2, '0');
  return h > 0 ? '$h:${m.toString().padLeft(2, '0')}:$ss' : '$m:$ss';
}

/// `250 MB`, `1.5 GB`, `12 KB`.
String sizeText(num bytes) {
  if (bytes >= 1024 * 1024 * 1024) return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
  if (bytes >= 1024 * 1024) return '${(bytes / (1024 * 1024)).round()} MB';
  return '${max(1, (bytes / 1024).round())} KB';
}

/// What the box would read from an MP4 without decoding it.
class Mp4Facts {
  const Mp4Facts({required this.codec, required this.width, required this.height, required this.durationSec});
  final String? codec;
  final int width;
  final int height;
  final double durationSec;

  bool get isH264 => codec == 'avc1' || codec == 'avc3';
}

/// Reads bytes [start, start+length) of a file; shorter at the end.
typedef RangeReader = Future<Uint8List> Function(int start, int length);

class _Box {
  const _Box(this.type, this.start, this.size, this.header);
  final String type;
  final int start;
  final int size;
  final int header;
}

_Box? _boxIn(Uint8List b, int pos, int end) {
  if (pos + 8 > end) return null;
  final d = ByteData.sublistView(b);
  var size = d.getUint32(pos);
  final type = String.fromCharCodes(b.sublist(pos + 4, pos + 8));
  var header = 8;
  if (size == 1) {
    if (pos + 16 > end) return null;
    size = d.getUint32(pos + 8) * 4294967296 + d.getUint32(pos + 12);
    header = 16;
  } else if (size == 0) {
    size = end - pos;
  }
  if (size < header || pos + size > end) return null;
  return _Box(type, pos, size, header);
}

List<_Box> _kids(Uint8List b, _Box box) {
  final out = <_Box>[];
  var pos = box.start + box.header;
  final end = box.start + box.size;
  while (pos < end) {
    final k = _boxIn(b, pos, end);
    if (k == null) break;
    out.add(k);
    pos += k.size;
  }
  return out;
}

/// The facts of an MP4: `ftyp` first, `moov` anywhere at the top level (read whole, at most 32 MB), then the movie
/// length and the first video track's sample entry. Null when it is not an MP4 or `moov` cannot be read.
Future<Mp4Facts?> readMp4Facts(RangeReader read, int total) async {
  try {
    final first = await read(0, min(16, total));
    if (first.length < 8 || String.fromCharCodes(first.sublist(4, 8)) != 'ftyp') return null;
    var pos = 0;
    int? moovAt;
    int? moovSize;
    while (pos + 8 <= total) {
      final h = await read(pos, min(16, total - pos));
      if (h.length < 8) return null;
      final d = ByteData.sublistView(h);
      var size = d.getUint32(0);
      final type = String.fromCharCodes(h.sublist(4, 8));
      if (size == 1 && h.length >= 16) size = d.getUint32(8) * 4294967296 + d.getUint32(12);
      if (size == 0) size = total - pos;
      if (size < 8 || pos + size > total) return null;
      if (type == 'moov') {
        moovAt = pos;
        moovSize = size;
        break;
      }
      pos += size;
    }
    if (moovAt == null || moovSize == null || moovSize > 32 * 1024 * 1024) return null;
    final body = await read(moovAt, moovSize);
    if (body.length != moovSize) return null;
    final moov = _boxIn(body, 0, body.length);
    if (moov == null) return null;
    final d = ByteData.sublistView(body);
    var duration = 0.0;
    String? codec;
    var width = 0;
    var height = 0;
    for (final c in _kids(body, moov)) {
      if (c.type == 'mvhd') {
        final p = c.start + c.header;
        final version = body[p];
        if (version == 1 && p + 32 <= body.length) {
          final scale = d.getUint32(p + 20);
          final dur = d.getUint32(p + 24) * 4294967296 + d.getUint32(p + 28);
          if (scale > 0) duration = dur / scale;
        } else if (p + 20 <= body.length) {
          final scale = d.getUint32(p + 12);
          final dur = d.getUint32(p + 16);
          if (scale > 0) duration = dur / scale;
        }
      } else if (c.type == 'trak' && codec == null) {
        final mdia = _kids(body, c).where((x) => x.type == 'mdia').firstOrNull;
        if (mdia == null) continue;
        final parts = _kids(body, mdia);
        final hdlr = parts.where((x) => x.type == 'hdlr').firstOrNull;
        final minf = parts.where((x) => x.type == 'minf').firstOrNull;
        if (hdlr == null || minf == null) continue;
        if (String.fromCharCodes(body.sublist(hdlr.start + 16, hdlr.start + 20)) != 'vide') continue;
        final stbl = _kids(body, minf).where((x) => x.type == 'stbl').firstOrNull;
        final stsd = stbl == null ? null : _kids(body, stbl).where((x) => x.type == 'stsd').firstOrNull;
        if (stsd == null) continue;
        final entry = stsd.start + stsd.header + 8;
        if (entry + 36 > body.length) continue;
        codec = String.fromCharCodes(body.sublist(entry + 4, entry + 8));
        width = d.getUint16(entry + 32);
        height = d.getUint16(entry + 34);
      }
    }
    return Mp4Facts(codec: codec, width: width, height: height, durationSec: duration);
  } on Object {
    return null;
  }
}

/// Why a picked file cannot be uploaded as it is; null when it can.
enum VideoProblem { notH264, tooBig, tooLong }

VideoProblem? videoProblemOf(Mp4Facts? f, int bytes) {
  if (f == null || !f.isH264) return VideoProblem.notH264;
  if (f.durationSec > kVideoMaxSeconds + 1) return VideoProblem.tooLong;
  final longSide = max(f.width, f.height);
  final shortSide = min(f.width, f.height);
  if (bytes > kVideoMaxFileBytes || longSide > (kVideoMaxHeight * 16 / 9).round() || shortSide > kVideoMaxHeight) {
    return VideoProblem.tooBig;
  }
  return null;
}

/// The refusal text of a [VideoProblem], the same words the box's coded errors have.
String videoProblemText(S s, VideoProblem p) => switch (p) {
  VideoProblem.notH264 => s.errVideoNotH264,
  VideoProblem.tooBig => s.errVideoTooBig,
  VideoProblem.tooLong => s.errVideoTooLong,
};

/// The rules between the fields of a video item (the generic validator checks each field alone); the same as core.
List<SettingError> videoCrossErrors(Map<dynamic, dynamic> item, S s) {
  final out = <SettingError>[];
  final source = item['source'];
  final asset = item['assetId'];
  final yt = item['youtubeId'];
  final start = item['startSec'];
  final end = item['endSec'];
  final dur = item['durationSec'];
  if (asset != null && !(asset is String && _assetId.hasMatch(asset))) out.add(SettingError('assetId', s.valRequired));
  if (yt != null && !isYoutubeId(yt)) out.add(SettingError('youtubeId', s.videoYoutubeBad));
  if (source == 'upload') {
    if (asset == null) out.add(SettingError('assetId', s.videoNeedsFile));
    if (yt != null) out.add(SettingError('youtubeId', s.valUnknownField));
    if (dur is num && dur > kVideoMaxSeconds) out.add(SettingError('durationSec', s.errVideoTooLong));
    if (start != null || end != null) out.add(SettingError('startSec', s.valUnknownField));
  } else if (source == 'youtube' || source == 'rakaman') {
    if (yt == null) out.add(SettingError('youtubeId', s.videoYoutubeBad));
    if (asset != null) out.add(SettingError('assetId', s.valUnknownField));
    if (source == 'youtube' && (start != null || end != null)) out.add(SettingError('startSec', s.valUnknownField));
    if (source == 'rakaman' && start is num && end is num && end <= start) out.add(SettingError('endSec', s.videoClipOrder));
    if (source == 'rakaman') {
      final from = start is num ? start : 0;
      if (end is num && end - from > kVideoMaxSeconds) out.add(SettingError('endSec', s.videoClipLong));
    }
  }
  return out;
}
