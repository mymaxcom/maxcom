// The signed outbox (Plan 6 Task 8): every edit made on this device waits
// here as a signed op until a base (the box or the cloud) accepts it. It
// lives in the local store's `outbox` collection, so it survives a restart
// and is wiped with the rest when the device is revoked or forgotten.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show compute;

import '../store/local_store.dart';

const String _crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/// ULID source: 48-bit millisecond time then 80 random bits, 26 Crockford
/// base32 characters. Monotonic: two ids made in the same millisecond still
/// sort in the order they were made, so ops of one device keep their order.
class UlidGenerator {
  UlidGenerator({Random? random, DateTime Function()? now})
    : _random = random ?? Random.secure(),
      _now = now ?? DateTime.now;

  final Random _random;
  final DateTime Function() _now;
  int _lastMs = -1;
  List<int> _lastRand = List.filled(16, 0);

  String next() {
    var ms = _now().millisecondsSinceEpoch;
    if (ms <= _lastMs) {
      ms = _lastMs;
      // Same (or earlier) millisecond: add one to the random part.
      final r = List<int>.of(_lastRand);
      var i = 15;
      while (i >= 0) {
        if (r[i] < 31) {
          r[i]++;
          break;
        }
        r[i] = 0;
        i--;
      }
      if (i < 0) {
        ms++; // the random part overflowed: move on a millisecond
        for (var k = 0; k < 16; k++) {
          r[k] = _random.nextInt(32);
        }
      }
      _lastRand = r;
    } else {
      _lastRand = [for (var k = 0; k < 16; k++) _random.nextInt(32)];
    }
    _lastMs = ms;
    final b = StringBuffer();
    var t = ms;
    final time = List<int>.filled(10, 0);
    for (var i = 9; i >= 0; i--) {
      time[i] = t % 32;
      t ~/= 32;
    }
    for (final c in time) {
      b.write(_crockford[c]);
    }
    for (final c in _lastRand) {
      b.write(_crockford[c]);
    }
    return b.toString();
  }
}

final RegExp ulidPattern = RegExp(r'^[0-9A-HJKMNP-TV-Z]{26}$');

/// The blob a picture is kept in for readers (`BoxGateway.getBytes`).
String assetBlobId(String assetId) => 'asset-$assetId';
String financePhotoBlobId(String photoId) => 'finance-photo-$photoId';

/// Bytes at or above this size are hashed and base64-encoded in a background
/// isolate; smaller ones are cheaper to do in place than to copy across.
const int backgroundBytesThreshold = 128 * 1024;

String _b64(Uint8List bytes) => base64.encode(bytes);

/// base64 of [bytes], off the UI isolate when they are large.
Future<String> base64Of(Uint8List bytes) => bytes.length >= backgroundBytesThreshold
    ? compute(_b64, bytes)
    : Future<String>.value(_b64(bytes));

/// One signed op: the Dart twin of `SyncOp` (packages/core/src/sync/types.ts)
/// kept as the exact JSON map that was signed.
///
/// For a queued picture [json] is the op WITHOUT `payload.bytesBase64`: the
/// bytes wait in the blob named [blobId] and are put back (see
/// [Outbox.withBytes]) only right before the op is sent.
class OutboxOp {
  OutboxOp(this.json, {this.blobId});

  final Map<String, dynamic> json;

  /// Where this op's picture bytes are kept, or null when it has none.
  final String? blobId;

  String get opId => json['opId'] as String;
  String get kind => json['kind'] as String;
  String get entity => json['entity'] as String;
  String get entityId => json['entityId'] as String;
  String get editedAt => json['editedAt'] as String;
  Object? get payload => json['payload'];

  /// `<entity>|<entityId>`: what two ops on the same document share.
  String get target => '$entity|$entityId';
}

/// The queue on [LocalStore] collection `outbox`, in `opId` (ULID) order.
///
/// A queued picture (`asset.put`, `finance.photo.put`) keeps its bytes ONCE,
/// in the blob readers use (`asset-<id>`, `finance-photo-<id>`); the outbox
/// doc names it in `blob` and the store never evicts a blob a queued doc
/// names. Queues written by 2026.11.6 hold `blob: true` and the bytes in
/// `upload-<opId>`; those still load. [queued] lists ops without bytes;
/// [withBytes] loads the bytes of the one op about to be sent.
class Outbox {
  Outbox(this.store);

  final LocalStore store;

  /// The 2026.11.6 blob of a queued op (read for old queues; deleted on
  /// [remove]).
  static String blobId(String opId) => '$uploadBlobPrefix$opId';

  /// The blob a picture op keeps its bytes in; null for other kinds.
  static String? bytesBlobOf(OutboxOp op) => switch (op.kind) {
    'asset.put' => assetBlobId(op.entityId),
    'finance.photo.put' => financePhotoBlobId(op.entityId),
    _ => null,
  };

  /// Queues [op]. A picture's bytes come as [bytes] (raw) or, for callers
  /// that still build the payload with `bytesBase64`, are decoded from it;
  /// either way they are stored once and the doc keeps the op without them.
  Future<void> add(OutboxOp op, {Uint8List? bytes}) async {
    final json = Map<String, dynamic>.of(op.json);
    final blobId = bytesBlobOf(op);
    final p = op.payload;
    var raw = bytes;
    if (p is Map && p['bytesBase64'] is String) {
      raw ??= Uint8List.fromList(base64.decode(p['bytesBase64'] as String));
      json['payload'] = {
        for (final e in p.entries)
          if (e.key != 'bytesBase64') e.key as String: e.value,
      };
    }
    if (blobId == null || raw == null) {
      await store.putDoc(Collections.outbox, op.opId, {
        'op': json,
        'blob': false,
      });
      return;
    }
    await store.putBlobWithDoc(blobId, raw, Collections.outbox, op.opId, {
      'op': json,
      'blob': blobId,
    });
  }

  /// The `<entity>|<entityId>` of every queued op (bytes not loaded).
  Future<Set<String>> targets() async => {
    for (final d in await store.list(Collections.outbox))
      '${(d['op'] as Map)['entity']}|${(d['op'] as Map)['entityId']}',
  };

  /// Every queued op, oldest first, WITHOUT bytes: no blob is read.
  Future<List<OutboxOp>> queued() async {
    final out = <OutboxOp>[];
    for (final d in await store.list(Collections.outbox)) {
      final op = Map<String, dynamic>.of(d['op'] as Map<String, dynamic>);
      final b = d['blob'];
      out.add(
        OutboxOp(
          op,
          blobId: b is String
              ? b
              : (b == true ? blobId(op['opId'] as String) : null),
        ),
      );
    }
    out.sort((a, b) => a.opId.compareTo(b.opId));
    return out;
  }

  /// [op] with its bytes put back into `payload.bytesBase64`, ready to send;
  /// [op] itself when it has none; null when its bytes are gone. Opens the
  /// one blob of this op, nothing else.
  Future<OutboxOp?> withBytes(OutboxOp op) async {
    final id = op.blobId;
    if (id == null) return op;
    final bytes = await store.getBlob(id);
    if (bytes == null) return null;
    final json = Map<String, dynamic>.of(op.json);
    json['payload'] = {
      ...(op.payload as Map<String, dynamic>),
      'bytesBase64': await base64Of(bytes),
    };
    return OutboxOp(json, blobId: id);
  }

  /// Every queued op, oldest first, with its bytes (every blob is opened:
  /// for tests and small queues; the sync pass uses [queued] + [withBytes]).
  Future<List<OutboxOp>> pending() async {
    final out = <OutboxOp>[];
    for (final op in await queued()) {
      final full = await withBytes(op);
      if (full != null) out.add(full); // bytes lost: see [missingBlobOps]
    }
    return out;
  }

  /// Queued uploads whose bytes are gone (never sendable), without bytes.
  /// A file/index check per upload; nothing is decrypted.
  Future<List<OutboxOp>> missingBlobOps() async {
    final out = <OutboxOp>[];
    for (final op in await queued()) {
      final id = op.blobId;
      if (id != null && !await store.hasBlob(id)) out.add(op);
    }
    return out;
  }

  Future<void> remove(String opId) async {
    await store.deleteDoc(Collections.outbox, opId);
    // Only a 2026.11.6 queue has an `upload-` copy; the shared picture blob
    // stays as the offline copy until the store needs the room.
    await store.deleteBlob(blobId(opId));
  }

  Future<int> get count async => (await store.list(Collections.outbox)).length;
}
