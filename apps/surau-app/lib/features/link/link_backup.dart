// What the box keeps from before a link: the backup of its own data ("Sandaran sebelum pautan") and, after an unlink,
// the data it still holds until a date ("Buang data lama"). `GET /api/link/backup` answers all of it; the same three
// fields ride in `self` of `GET /api/boxes`. A field of the wrong type is dropped, never guessed: a line is shown only
// for what was read in full.

/// The backup of the box's own data, taken before it was linked.
class LinkBackup {
  const LinkBackup({required this.linkId, required this.kind, required this.at, required this.bytes, required this.files});

  final String linkId;

  /// `set-aside` (the data was put aside) or `copy`.
  final String kind;
  final DateTime at;
  final int bytes;
  final int files;

  static LinkBackup? fromJson(Object? j) {
    if (j is! Map) return null;
    final id = j['linkId'];
    final kind = j['kind'];
    final at = j['at'] is String ? DateTime.tryParse(j['at'] as String) : null;
    final bytes = j['bytes'];
    final files = j['files'];
    if (id is! String || id.isEmpty || at == null || bytes is! num) return null;
    return LinkBackup(
      linkId: id,
      kind: kind is String ? kind : 'copy',
      at: at,
      bytes: bytes.toInt(),
      files: files is num ? files.toInt() : 0,
    );
  }
}

/// The data a box that was unlinked still holds until [until]: the person may drop it before.
class LinkKept {
  const LinkKept({required this.linkId, required this.at, required this.bytes, required this.until});

  final String linkId;
  final DateTime at;
  final int bytes;
  final DateTime until;

  static LinkKept? fromJson(Object? j) {
    if (j is! Map) return null;
    final id = j['linkId'];
    final at = j['at'] is String ? DateTime.tryParse(j['at'] as String) : null;
    final until = j['until'] is String ? DateTime.tryParse(j['until'] as String) : null;
    final bytes = j['bytes'];
    if (id is! String || id.isEmpty || at == null || until == null || bytes is! num) return null;
    return LinkKept(linkId: id, at: at, bytes: bytes.toInt(), until: until);
  }
}

/// The answer of `GET /api/link/backup`.
class LinkBackupInfo {
  const LinkBackupInfo({this.backup, this.kept, this.freeBytes, this.followers = 0});

  final LinkBackup? backup;
  final LinkKept? kept;

  /// Free storage on the box's volume, or null when it does not know.
  final int? freeBytes;

  /// Follower boxes linked to this one now.
  final int followers;

  bool get isEmpty => backup == null && kept == null;

  static LinkBackupInfo fromJson(Map<String, dynamic> j) => LinkBackupInfo(
    backup: LinkBackup.fromJson(j['backup']),
    kept: LinkKept.fromJson(j['kept']),
    freeBytes: j['freeBytes'] is num ? (j['freeBytes'] as num).toInt() : null,
    followers: j['followers'] is num ? (j['followers'] as num).toInt() : 0,
  );
}
