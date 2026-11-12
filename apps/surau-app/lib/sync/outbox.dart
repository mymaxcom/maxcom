// The signed outbox (Plan 6 Task 8): every edit made on this device waits
// here as a signed op until a base (the box or the cloud) accepts it. It
// lives in the local store's `outbox` collection, so it survives a restart
// and is wiped with the rest when the device is revoked or forgotten.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

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

/// One signed op: the Dart twin of `SyncOp` (packages/core/src/sync/types.ts)
/// kept as the exact JSON map that was signed.
class OutboxOp {
  OutboxOp(this.json);

  final Map<String, dynamic> json;

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
/// A queued asset (`asset.put`) keeps its bytes in a blob named
/// `upload-<opId>` (the store never evicts those) and the document holds the
/// op without them; [pending] puts them back before the op is sent.
class Outbox {
  Outbox(this.store);

  final LocalStore store;

  static String blobId(String opId) => '$uploadBlobPrefix$opId';

  Future<void> add(OutboxOp op) async {
    final json = Map<String, dynamic>.of(op.json);
    var blob = false;
    if (op.kind == 'asset.put' || op.kind == 'finance.photo.put') {
      final p = op.payload;
      if (p is Map && p['bytesBase64'] is String) {
        final bytes = base64.decode(p['bytesBase64'] as String);
        await store.putBlob(blobId(op.opId), Uint8List.fromList(bytes));
        json['payload'] = {
          for (final e in p.entries)
            if (e.key != 'bytesBase64') e.key as String: e.value,
        };
        blob = true;
      }
    }
    await store.putDoc(Collections.outbox, op.opId, {'op': json, 'blob': blob});
  }

  /// The `<entity>|<entityId>` of every queued op (bytes not loaded).
  Future<Set<String>> targets() async => {
    for (final d in await store.list(Collections.outbox))
      '${(d['op'] as Map)['entity']}|${(d['op'] as Map)['entityId']}',
  };

  /// Every queued op, oldest first, ready to send.
  Future<List<OutboxOp>> pending() async {
    final docs = await store.list(Collections.outbox);
    final out = <OutboxOp>[];
    for (final d in docs) {
      final op = Map<String, dynamic>.of(d['op'] as Map<String, dynamic>);
      if (d['blob'] == true) {
        final bytes = await store.getBlob(blobId(op['opId'] as String));
        if (bytes == null) continue; // bytes lost: see [missingBlobOps]
        op['payload'] = {
          ...(op['payload'] as Map<String, dynamic>),
          'bytesBase64': base64.encode(bytes),
        };
      }
      out.add(OutboxOp(op));
    }
    out.sort((a, b) => a.opId.compareTo(b.opId));
    return out;
  }

  /// Queued uploads whose bytes are gone (never sendable), without bytes.
  Future<List<OutboxOp>> missingBlobOps() async {
    final out = <OutboxOp>[];
    for (final d in await store.list(Collections.outbox)) {
      if (d['blob'] != true) continue;
      final op = Map<String, dynamic>.of(d['op'] as Map<String, dynamic>);
      if (await store.getBlob(blobId(op['opId'] as String)) == null) {
        out.add(OutboxOp(op));
      }
    }
    return out;
  }

  Future<void> remove(String opId) async {
    await store.deleteDoc(Collections.outbox, opId);
    await store.deleteBlob(blobId(opId));
  }

  Future<int> get count async => (await store.list(Collections.outbox)).length;
}
