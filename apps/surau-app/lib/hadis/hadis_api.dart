// The hadis data layer: the paths of `/api/hadis/*`, typed answers and the
// repository every hadis screen talks to, through the gateway (so a 401
// reaches the unlock screen and an unreachable box is reported as usual).
//
// A hadis saved on MAXCOM is an ordinary `hadis` content item, so the list
// itself is `GET /api/content/hadis`; what HadeethEnc serves reaches the
// phone only through the box (`categories`, `search`, `hadeethenc/<id>`),
// never from the internet directly. Every answer here is read tolerantly: a
// field a newer or older box leaves out becomes its default.

import 'dart:async';

import '../box/box_client.dart';
import '../features/shell/box_gateway.dart';

const String hadisStatusPath = '/api/hadis/status';
const String hadisCategoriesPath = '/api/hadis/categories';
const String hadisAddPath = '/api/hadis/add';
const String hadisOrderPath = '/api/hadis/order';
const String hadisUpdatesPath = '/api/hadis/updates';
const String hadisRefreshPath = '/api/hadis/refresh';
const String hadisContentPath = '/api/content/hadis';

String hadisCategoryItemsPath(String id, {int page = 1, int perPage = 30}) =>
    '/api/hadis/categories/$id/items?page=$page&perPage=$perPage';
String hadisSearchPath(String q) =>
    '/api/hadis/search?q=${Uri.encodeQueryComponent(q)}';
String hadisDetailPath(String id) => '/api/hadis/hadeethenc/$id';
String hadisAcceptUpdatePath(String itemId) =>
    '/api/hadis/$itemId/accept-update';
String hadisJobPath(String id) => '/api/hadis/jobs/$id';

Map<String, dynamic> _map(Object? v) =>
    v is Map ? v.cast<String, dynamic>() : const <String, dynamic>{};
List<Object?> _list(Object? v) => v is List ? v.cast<Object?>() : const [];
String _str(Object? v, [String def = '']) => v is String ? v : def;
String? _strOrNull(Object? v) => v is String ? v : null;
int _int(Object? v, [int def = 0]) => v is num ? v.toInt() : def;

/// A crawl of HadeethEnc into the box's catalog, as `GET /api/hadis/jobs/<id>`.
class HadisJob {
  const HadisJob({
    required this.id,
    required this.state,
    required this.progress,
    this.done = 0,
    this.total = 0,
    this.error,
  });

  factory HadisJob.fromJson(Map<String, dynamic> j) => HadisJob(
    id: _str(j['id']),
    state: _str(j['state'], 'running'),
    progress: j['progress'] is num ? (j['progress'] as num).toDouble() : 0,
    done: _int(j['done']),
    total: _int(j['total']),
    error: _strOrNull(j['error']),
  );

  final String id;

  /// `running`, `done` or `failed`.
  final String state;
  final double progress;
  final int done;
  final int total;
  final String? error;

  bool get running => state == 'running';
  bool get failed => state == 'failed';
}

/// `GET /api/hadis/status`.
class HadisStatus {
  const HadisStatus({
    required this.online,
    required this.entries,
    required this.categories,
    this.fetchedAt,
    this.job,
    required this.saved,
    required this.max,
    required this.updates,
  });

  factory HadisStatus.fromJson(Map<String, dynamic> j) {
    final c = _map(j['catalog']);
    final job = c['job'];
    return HadisStatus(
      online: j['online'] == true,
      entries: _int(c['entries']),
      categories: _int(c['categories']),
      fetchedAt: _strOrNull(c['fetchedAt']),
      job: job is Map ? HadisJob.fromJson(_map(job)) : null,
      saved: _int(j['saved']),
      max: _int(j['max'], 500),
      updates: _int(j['updates']),
    );
  }

  /// Offline stand-in: the box did not answer.
  static const HadisStatus unknown = HadisStatus(
    online: false,
    entries: 0,
    categories: 0,
    saved: 0,
    max: 500,
    updates: 0,
  );

  final bool online;

  /// Hadis in the box's local HadeethEnc catalog.
  final int entries;
  final int categories;
  final String? fetchedAt;
  final HadisJob? job;
  final int saved;
  final int max;

  /// Saved hadis whose text HadeethEnc has since changed.
  final int updates;

  bool get catalogEmpty => entries == 0;
}

class HeCategory {
  const HeCategory({
    required this.id,
    this.parentId,
    required this.titleMs,
    required this.titleEn,
    required this.count,
  });

  factory HeCategory.fromJson(Map<String, dynamic> j) => HeCategory(
    id: _str(j['id']),
    parentId: _strOrNull(j['parentId']),
    titleMs: _str(j['titleMs'], _str(j['titleEn'])),
    titleEn: _str(j['titleEn']),
    count: _int(j['count']),
  );

  final String id;
  final String? parentId;
  final String titleMs;
  final String titleEn;
  final int count;
}

/// One hadis in a category or a search result.
class HeSummary {
  const HeSummary({
    required this.id,
    required this.title,
    this.grade,
    required this.gradeAr,
    this.attributionShort,
    this.attributionLong,
    required this.attributionAr,
    required this.length,
    required this.chars,
    required this.allowed,
    required this.saved,
  });

  factory HeSummary.fromJson(Map<String, dynamic> j) {
    final a = _map(j['attribution']);
    return HeSummary(
      id: _str(j['id']),
      title: _str(j['title']),
      grade: _strOrNull(j['grade']),
      gradeAr: _str(j['gradeAr']),
      attributionShort: _strOrNull(a['short']),
      attributionLong: _strOrNull(a['long']),
      attributionAr: _str(j['attributionAr']),
      length: _str(j['length'], 'short'),
      chars: _int(j['chars']),
      allowed: j['allowed'] == true,
      saved: j['saved'] == true,
    );
  }

  final String id;
  final String title;

  /// Grade key (`sahih`...), null when the Arabic text is not a known grade.
  final String? grade;
  final String gradeAr;
  final String? attributionShort;
  final String? attributionLong;
  final String attributionAr;

  /// `short`, `medium` or `long`.
  final String length;
  final int chars;

  /// False for Dhaif, Palsu and a grade nobody mapped: no add button.
  final bool allowed;
  final bool saved;

  bool get isLong => length == 'long';
}

class HePage {
  const HePage(this.items, this.total);

  final List<HeSummary> items;
  final int total;
}

/// `GET /api/hadis/hadeethenc/<id>`: everything the detail screen shows.
class HeDetail {
  const HeDetail({
    required this.id,
    required this.title,
    required this.textMs,
    this.introMs,
    required this.textAr,
    required this.attributionAr,
    required this.gradeAr,
    required this.categories,
    this.grade,
    this.attributionShort,
    this.attributionLong,
    required this.length,
    required this.allowed,
    required this.saved,
    this.savedItemId,
  });

  factory HeDetail.fromJson(Map<String, dynamic> j) {
    final a = _map(j['attribution']);
    return HeDetail(
      id: _str(j['id']),
      title: _str(j['title']),
      textMs: _str(j['textMs']),
      introMs: _strOrNull(j['introMs']),
      textAr: _str(j['textAr']),
      attributionAr: _str(j['attributionAr']),
      gradeAr: _str(j['gradeAr']),
      categories: [for (final c in _list(j['categories'])) _str(c)],
      grade: _strOrNull(j['grade']),
      attributionShort: _strOrNull(a['short']),
      attributionLong: _strOrNull(a['long']),
      length: _str(j['length'], 'short'),
      allowed: j['allowed'] == true,
      saved: j['saved'] == true,
      savedItemId: _strOrNull(j['savedItemId']),
    );
  }

  final String id;
  final String title;
  final String textMs;
  final String? introMs;
  final String textAr;
  final String attributionAr;
  final String gradeAr;

  /// Provider category ids.
  final List<String> categories;
  final String? grade;
  final String? attributionShort;
  final String? attributionLong;
  final String length;
  final bool allowed;
  final bool saved;
  final String? savedItemId;
}

/// A saved hadis whose text changed at HadeethEnc, from `GET /api/hadis/updates`.
class HadisUpdate {
  const HadisUpdate({
    required this.itemId,
    required this.providerId,
    required this.foundAt,
    required this.changed,
    this.previewMs,
  });

  factory HadisUpdate.fromJson(Map<String, dynamic> j) => HadisUpdate(
    itemId: _str(j['itemId']),
    providerId: _str(j['providerId']),
    foundAt: _str(j['foundAt']),
    changed: [for (final c in _list(j['changed'])) _str(c)],
    previewMs: _strOrNull(_map(j['preview'])['textMs']),
  );

  final String itemId;
  final String providerId;
  final String foundAt;

  /// Which parts changed: `textMs`, `textAr`, `title`, `intro`, `attribution`, `grade`.
  final List<String> changed;
  final String? previewMs;
}

/// A hadis saved on MAXCOM, as the content list serves it. [raw] is the whole
/// answer: a change sends it back with only `shown` or `order` different, so
/// what HadeethEnc served is never touched.
class HadisItem {
  HadisItem(this.raw);

  final Map<String, dynamic> raw;

  String get id => _str(raw['id']);
  String get textMs => _str(raw['textMs']);
  String? get textAr => _strOrNull(raw['textAr']);
  String get source => _str(raw['source']);
  String? get title => _strOrNull(raw['title']);
  String? get intro => _strOrNull(raw['intro']);

  /// Grade key; provider items only.
  String? get grade => _strOrNull(raw['grade']);

  /// Absent means shown on the TV.
  bool get shown => raw['shown'] != false;
  int? get order => raw['order'] is num ? (raw['order'] as num).toInt() : null;
  String get updatedAt => _str(raw['updatedAt']);
  Map<String, dynamic>? get ext =>
      raw['ext'] is Map ? _map(raw['ext']) : null;
  bool get isProvider => ext != null;

  /// The box took it off the TV: HadeethEnc now grades it with a grade the
  /// TV may not show. [shown] stays the person's own choice.
  bool get gradeBlocked => ext?['blocked'] == true;

  /// Provider id (`66512`) of a HadeethEnc hadis.
  String? get providerId => _strOrNull(ext?['id']);

  /// Waits in the outbox until the box can be reached.
  bool get pending => raw['pending'] == true;

  /// Body of `PUT /api/content/hadis/<id>`. An own item goes back whole, with
  /// [shown] and [order] as asked. A HadeethEnc item sends only what changed
  /// among `shown` and `order`: what HadeethEnc served is never in the body, so
  /// a change queued while the box was away still lands, on the box's current
  /// text, after the text was updated.
  Map<String, dynamic> toPut({bool? shown, int? order}) {
    if (isProvider) {
      return {'shown': ?shown, 'order': ?order};
    }
    const skip = {'id', 'updatedAt', 'updatedBy', 'pending'};
    final out = <String, dynamic>{
      for (final e in raw.entries)
        if (!skip.contains(e.key) && !e.key.startsWith('_') && e.key != 'rev')
          e.key: e.value,
    };
    if (shown != null) out['shown'] = shown;
    if (order != null) out['order'] = order;
    return out;
  }
}

/// Why an add did not go through (`POST /api/hadis/add`).
enum AddFailure {
  gradeBlocked,
  tooLong,
  limitReached,
  sourceUnavailable,
  forbidden,
  other,
}

class AddResult {
  const AddResult.ok(this.item) : failure = null, message = null;
  const AddResult.failed(this.failure, this.message) : item = null;

  final HadisItem? item;
  final AddFailure? failure;

  /// The box's own wording of the reason, for `other`.
  final String? message;

  bool get ok => item != null;
}

class HadisRepository {
  HadisRepository(this.gateway);

  final BoxGateway gateway;

  /// Online state and counts; the box not answering is `unknown`.
  Future<HadisStatus> status() async {
    try {
      return HadisStatus.fromJson(await gateway.getFresh(hadisStatusPath));
    } on BoxUnreachable {
      return HadisStatus.unknown;
    }
  }

  Future<List<HeCategory>> categories() async {
    final read = await gateway.get(hadisCategoriesPath);
    return [
      for (final c in _list(read.value['categories']))
        HeCategory.fromJson(_map(c)),
    ];
  }

  Future<HePage> itemsIn(String categoryId, {int page = 1, int perPage = 30}) async {
    final read = await gateway.get(
      hadisCategoryItemsPath(categoryId, page: page, perPage: perPage),
    );
    return HePage([
      for (final i in _list(read.value['items'])) HeSummary.fromJson(_map(i)),
    ], _int(read.value['total']));
  }

  /// Never cached: a search is a question to the box's catalog now.
  Future<List<HeSummary>> search(String q) async {
    final body = await gateway.getFresh(hadisSearchPath(q));
    return [
      for (final i in _list(body['items'])) HeSummary.fromJson(_map(i)),
    ];
  }

  Future<HeDetail> detail(String id) async {
    final read = await gateway.get(hadisDetailPath(id));
    return HeDetail.fromJson(_map(read.value['hadith']));
  }

  /// Saves the hadis on MAXCOM. The box reads it from HadeethEnc itself.
  Future<AddResult> add(String id) async {
    try {
      final body = await gateway.post(hadisAddPath, {
        'provider': 'hadeethenc',
        'id': id,
      });
      return AddResult.ok(HadisItem(_map(body['item'])));
    } on SessionExpired {
      rethrow;
    } on BoxError catch (e) {
      return AddResult.failed(switch ((e.status, e.code)) {
        (400, 'grade_blocked') => AddFailure.gradeBlocked,
        (400, 'too_long') || (400, 'field_too_long') => AddFailure.tooLong,
        (409, 'limit_reached') => AddFailure.limitReached,
        (503, _) || (502, _) => AddFailure.sourceUnavailable,
        (403, _) => AddFailure.forbidden,
        _ => AddFailure.other,
      }, e.message);
    } on BoxUnreachable {
      return const AddResult.failed(AddFailure.sourceUnavailable, null);
    } on LiveOnly {
      return const AddResult.failed(AddFailure.sourceUnavailable, null);
    } on OfflineWriteRefused {
      return const AddResult.failed(AddFailure.sourceUnavailable, null);
    }
  }

  /// The hadis saved on MAXCOM, from the box or the local copy.
  Future<List<HadisItem>> items() async {
    final read = await gateway.get(hadisContentPath);
    return [
      for (final i in _list(read.value['items'])) HadisItem(_map(i)),
    ];
  }

  /// `PUT` of one item (shown or order changed). Offline it is queued.
  Future<void> put(String id, Map<String, dynamic> body) =>
      gateway.put('$hadisContentPath/$id', body);

  Future<void> delete(String id) => gateway.delete('$hadisContentPath/$id');

  /// Renumbers the list by 1000 in the given order; needs the box online.
  Future<void> order(List<String> ids) =>
      gateway.put(hadisOrderPath, {'ids': ids});

  Future<List<HadisUpdate>> updates() async {
    final body = await gateway.getFresh(hadisUpdatesPath);
    return [
      for (final u in _list(body['updates'])) HadisUpdate.fromJson(_map(u)),
    ];
  }

  /// Replaces the saved text with the new one. True when the new grade is
  /// not one the TV may show: the box then hides the hadis.
  Future<bool> acceptUpdate(String itemId) async {
    final body = await gateway.post(hadisAcceptUpdatePath(itemId), const {});
    return body['gradeBlocked'] == true;
  }

  /// Starts the download of the HadeethEnc list; the job id to poll.
  Future<String> refresh() async {
    final body = await gateway.post(hadisRefreshPath, const {});
    return _str(body['jobId']);
  }

  Future<HadisJob> job(String id) async =>
      HadisJob.fromJson(await gateway.getFresh(hadisJobPath(id)));
}
