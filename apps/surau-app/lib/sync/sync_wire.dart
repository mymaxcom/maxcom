// The sync routes' answers (packages/core/src/sync/types.ts), as the app
// reads them. Kept apart from box/wire.dart so Task 8 owns only its own files.

/// One op's verdict from `POST /api/sync/ops`.
class OpResultDto {
  const OpResultDto({
    required this.opId,
    required this.status,
    this.rev,
    this.reason,
    this.winner,
  });

  factory OpResultDto.fromJson(Map<String, dynamic> j) => OpResultDto(
    opId: j['opId'] as String,
    status: j['status'] as String,
    rev: j['rev'] as String?,
    reason: j['reason'] as String?,
    winner: j['winner'] is Map<String, dynamic>
        ? WinnerDto.fromJson(j['winner'] as Map<String, dynamic>)
        : null,
  );

  final String opId;

  /// `applied`, `duplicate`, `superseded` or `refused`.
  final String status;
  final String? rev;

  /// Set when [status] is `refused`: `device_revoked`, `forbidden`, ...
  final String? reason;
  final WinnerDto? winner;

  bool get done => status == 'applied' || status == 'duplicate';
}

/// Who won a `superseded` op.
class WinnerDto {
  const WinnerDto({required this.actor, this.userName, required this.editedAt});

  factory WinnerDto.fromJson(Map<String, dynamic> j) => WinnerDto(
    actor: (j['actor'] ?? '') as String,
    userName: j['userName'] as String?,
    editedAt: (j['editedAt'] ?? '') as String,
  );

  final String actor;
  final String? userName;
  final String editedAt;

  Map<String, dynamic> toJson() => {
    'actor': actor,
    'userName': userName,
    'editedAt': editedAt,
  };
}

/// One change from `GET /api/sync/changes`. [after] is null for a tombstone.
class FeedEntryDto {
  const FeedEntryDto({
    required this.seq,
    required this.entity,
    required this.entityId,
    required this.rev,
    required this.editedAt,
    required this.opId,
    required this.after,
  });

  factory FeedEntryDto.fromJson(Map<String, dynamic> j) => FeedEntryDto(
    seq: (j['seq'] as num).toInt(),
    entity: j['entity'] as String,
    entityId: j['entityId'] as String,
    rev: (j['rev'] ?? '') as String,
    editedAt: (j['editedAt'] ?? '') as String,
    opId: j['opId'] as String?,
    after: j['after'],
  );

  final int seq;
  final String entity;
  final String entityId;
  final String rev;
  final String editedAt;
  final String? opId;
  final Object? after;
}
