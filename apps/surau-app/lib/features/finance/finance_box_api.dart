// What the report, audit and tabung-settings screens ask of the box that is
// not in the local ledger: the PDF (live-only), the share note, the audit
// list, and the settings of the module and of the TV card. One small
// interface so the screens are tested without a gateway; the real one sits
// on [BoxGateway] and [SettingsRepository].

import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../box/box_client.dart' show BoxUnreachable;
import '../../app/providers.dart';
import '../settings_repository.dart';
import '../shell/box_gateway.dart';

/// One line of `GET /api/finance/audit`: a ledger write, a lookup change, a
/// month change, a report download or share, or a refused op.
class FinanceAuditRow {
  const FinanceAuditRow({
    required this.id,
    required this.at,
    required this.actor,
    required this.entity,
    required this.editedAt,
    this.userName,
    this.deviceId,
    this.entityId,
    this.syncedAt,
    this.cloudReceivedAt,
    this.origin = 'local',
    this.after,
    this.refusedDetail,
  });

  factory FinanceAuditRow.fromJson(Map<String, dynamic> j) {
    String? s(Object? v) => v is String && v.isNotEmpty ? v : null;
    final refused = j['refused'];
    final after = j['after'];
    return FinanceAuditRow(
      id: s(j['id']) ?? '',
      at: s(j['at']) ?? '',
      actor: s(j['actor']) ?? '',
      userName: s(j['userName']),
      deviceId: s(j['deviceId']),
      entity: s(j['entity']) ?? '',
      entityId: s(j['entityId']),
      editedAt: s(j['editedAt']) ?? s(j['at']) ?? '',
      syncedAt: s(j['syncedAt']),
      cloudReceivedAt: s(j['cloudReceivedAt']),
      origin: s(j['origin']) ?? 'local',
      after: after is Map ? after.cast<String, dynamic>() : null,
      refusedDetail: refused is Map ? s(refused['detail']) : null,
    );
  }

  final String id;

  /// When this server logged it.
  final String at;
  final String actor;
  final String? userName;
  final String? deviceId;

  /// `finance:entry`, `finance:fund`, `finance:perihal`, `finance:month`,
  /// `finance:report` or `finance:refused`.
  final String entity;
  final String? entityId;

  /// When the device made it.
  final String editedAt;
  final String? syncedAt;
  final String? cloudReceivedAt;
  final String origin;
  final Map<String, dynamic>? after;

  /// The refusal's code (`device_revoked`, `apply_finance_...`) for a
  /// refused row.
  final String? refusedDetail;

  bool get refused => entity == 'finance:refused';
}

class FinanceAuditResult {
  const FinanceAuditResult(this.rows, {this.stale = false});

  final List<FinanceAuditRow> rows;

  /// Read from the cache because the box did not answer.
  final bool stale;
}

abstract class FinanceBoxApi {
  /// The month's PDF. Live-only: throws [LiveOnly] when no connection.
  Future<Uint8List> reportPdf(String ym);

  /// Notes that the report was shared (`whatsapp`, `email` or `other`).
  Future<void> reportShared(String ym, String via);

  Future<FinanceAuditResult> audit({int limit = 200});

  /// All features' settings, as `GET /api/settings` answers.
  Future<Map<String, dynamic>> settings();

  /// `PUT /api/settings/<feature>` with the changed keys.
  Future<void> saveSettings(String feature, Map<String, dynamic> patch);
}

class GatewayFinanceBoxApi implements FinanceBoxApi {
  GatewayFinanceBoxApi(this.gateway, this.settingsRepo);

  final BoxGateway gateway;
  final SettingsRepository settingsRepo;

  @override
  Future<Uint8List> reportPdf(String ym) async {
    final path = '/api/finance/report/$ym.pdf';
    try {
      return await gateway.getBytes(path);
    } on BoxUnreachable {
      throw LiveOnly(path);
    }
  }

  @override
  Future<void> reportShared(String ym, String via) async {
    await gateway.post('/api/finance/report/$ym/shared', {'via': via});
  }

  @override
  Future<FinanceAuditResult> audit({int limit = 200}) async {
    final r = await gateway.get('/api/finance/audit?limit=$limit');
    final list = r.value['entries'];
    return FinanceAuditResult([
      if (list is List)
        for (final e in list)
          if (e is Map<String, dynamic>) FinanceAuditRow.fromJson(e),
    ], stale: r.stale);
  }

  @override
  Future<Map<String, dynamic>> settings() async =>
      (await settingsRepo.load()).value;

  @override
  Future<void> saveSettings(String feature, Map<String, dynamic> patch) async {
    await settingsRepo.save(feature, patch);
  }
}

/// Null until the app is unlocked.
final financeBoxApiProvider = Provider<FinanceBoxApi?>((ref) {
  final gateway = ref.watch(gatewayProvider);
  final repo = ref.watch(settingsRepositoryProvider);
  if (gateway == null || repo == null) return null;
  return GatewayFinanceBoxApi(gateway, repo);
});
