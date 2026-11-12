// Shared set-up of the Task 8b screen tests: a finance repository on a
// MemoryLocalStore with the in-memory sync server, fakes for the box calls
// (PDF, share note, audit, settings) and for the file helpers, and a small
// router so a screen can navigate. The screens are pumped directly, not
// through the whole shell.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:go_router/go_router.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/finance/finance_box_api.dart';
import 'package:surau_app/features/finance/share.dart';
import 'package:surau_app/features/finance/share_sheet.dart';
import 'package:surau_app/features/shell/box_gateway.dart' show LiveOnly;
import 'package:surau_app/finance/finance_repository.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/store/local_store.dart';
import 'package:surau_app/sync/sync_engine.dart';
import 'package:surau_app/sync/sync_providers.dart';

import '../features/fakes.dart';
import '../sync/sync_fakes.dart';

class FakeSurau extends SurauInfoNotifier {
  FakeSurau(this.value);

  final SurauInfo? value;

  @override
  SurauInfo? build() => value;
}

class FakeFinanceBox implements FinanceBoxApi {
  FakeFinanceBox();

  Uint8List pdf = Uint8List.fromList([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
  bool offline = false;
  final List<String> pdfRequests = [];
  final List<(String, String)> shared = [];
  final List<(String, Map<String, dynamic>)> saved = [];
  bool sharedFails = false;
  List<FinanceAuditRow> auditRows = [];
  bool auditStale = false;
  Map<String, dynamic> settingsMap = {
    'finance': {'enabled': true, 'startedOn': '2026-09-01'},
    'tabungCard': {
      'figure': 'balance',
      'highlightSeconds': 20,
      'showTarget': true,
      'qrAssetId': '',
    },
  };

  @override
  Future<Uint8List> reportPdf(String ym) async {
    pdfRequests.add(ym);
    if (offline) throw LiveOnly('/api/finance/report/$ym.pdf');
    return pdf;
  }

  @override
  Future<void> reportShared(String ym, String via) async {
    if (sharedFails) throw StateError('no');
    shared.add((ym, via));
  }

  @override
  Future<FinanceAuditResult> audit({int limit = 200}) async =>
      FinanceAuditResult(auditRows, stale: auditStale);

  @override
  Future<Map<String, dynamic>> settings() async => settingsMap;

  @override
  Future<void> saveSettings(String feature, Map<String, dynamic> patch) async {
    saved.add((feature, patch));
    final cur = settingsMap[feature];
    settingsMap = {
      ...settingsMap,
      feature: {...?(cur is Map ? cur.cast<String, dynamic>() : null), ...patch},
    };
  }
}

class FakeFileOps extends ReportFileOps {
  FakeFileOps();

  final List<String> savedNames = [];
  final List<String> sharedNames = [];
  ShareResult shareResult = const ShareResult('whatsapp');

  @override
  Future<SaveResult> save(Uint8List bytes, String filename) async {
    savedNames.add(filename);
    return const SaveResult(saved: true);
  }

  @override
  Future<ShareResult> share(Uint8List bytes, String filename) async {
    sharedNames.add(filename);
    return shareResult;
  }
}

class FinHarness {
  FinHarness._();

  late MemoryLocalStore store;
  late FakeSyncServer server;
  late SyncEngine engine;
  late FinanceRepository repo;
  final FakeFinanceBox box = FakeFinanceBox();
  final FakeFileOps ops = FakeFileOps();
  DateTime clock = DateTime.utc(2026, 11, 2, 1, 0, 0);
  final List<String> visited = [];

  static Future<FinHarness> create({DateTime? now}) async {
    final h = FinHarness._();
    if (now != null) h.clock = now;
    h.store = MemoryLocalStore();
    await h.store.open('0123456789abcdef');
    h.server = FakeSyncServer();
    h.engine = SyncEngine(
      store: h.store,
      key: FakeDeviceKey(present: true),
      box: syncBox(),
      transport: FakeTransport(h.server),
      now: () => h.clock = h.clock.add(const Duration(seconds: 1)),
      autoSync: false,
      schedule: (d, f) => Timer(const Duration(days: 1), () {}),
    );
    h.repo = FinanceRepository(
      store: h.store,
      engine: h.engine,
      now: () => h.clock,
    );
    await h.store.setMeta('seq', '0');
    await h.store.setMeta('seq@box', '0');
    return h;
  }

  void dispose() {
    repo.dispose();
    engine.dispose();
  }

  Future<void> putFund(
    String id,
    String name, {
    int order = 0,
    bool public = false,
    String? archivedAt,
    int? targetSen,
  }) => store.putDoc(Collections.financeFunds, id, {
    'id': id,
    'name': name,
    'sortOrder': order,
    'public': public,
    'archivedAt': archivedAt,
    'targetSen': targetSen,
  });

  Future<void> putPerihal(String id, String direction, String label, {String? system}) =>
      store.putDoc(Collections.financePerihal, id, {
        'id': id,
        'direction': direction,
        'label': label,
        'system': system,
      });

  /// A scenario of the shared finance vectors loaded as the local copy.
  Future<Map<String, dynamic>> loadVector(int index) async {
    final v = jsonDecode(
      File('test/fixtures/finance-vectors.json').readAsStringSync(),
    ) as Map<String, dynamic>;
    for (final f in (v['funds'] as List).cast<Map<String, dynamic>>()) {
      await putFund(f['id'] as String, f['name'] as String, order: f['sortOrder'] as int);
    }
    for (final p in (v['perihal'] as List).cast<Map<String, dynamic>>()) {
      await putPerihal(p['id'] as String, p['direction'] as String, p['label'] as String);
    }
    final sc = (v['scenarios'] as List)[index] as Map<String, dynamic>;
    for (final e in (sc['entries'] as List).cast<Map<String, dynamic>>()) {
      final doc = <String, dynamic>{
        'createdBy': 'u1',
        'editedAt': '2026-10-01T00:00:00.000Z',
        'receivedAt': e['editedAt'] ?? '2026-10-01T00:00:00.000Z',
        'entryDate': '2026-10-01',
        'fundId': 'f1',
        'amountSen': 0,
        'kind': 'in',
        ...e,
      };
      await store.putDoc(Collections.financeEntries, doc['id'] as String, doc);
    }
    return sc;
  }

  List<Override> overrides({
    Set<String> roles = const {'admin'},
    SurauInfo? info = const SurauInfo(
      name: 'Surau D\'Waqaf',
      shortAddress: 'Jalan Mahabbah 3, Taman Mahabbah',
    ),
  }) => [
    financeRepositoryProvider.overrideWithValue(repo),
    financeBoxApiProvider.overrideWithValue(box),
    reportFileOpsProvider.overrideWithValue(ops),
    rolesProvider.overrideWithValue(roles),
    surauInfoProvider.overrideWith(() => FakeSurau(info)),
    syncEngineProvider.overrideWithValue(null),
  ];

  /// [screen] at `/screen`, with `/finance`, `/finance/setup` as stubs that
  /// record the visit.
  Widget app(
    Widget screen, {
    Set<String> roles = const {'admin'},
    SurauInfo? info = const SurauInfo(
      name: 'Surau D\'Waqaf',
      shortAddress: 'Jalan Mahabbah 3, Taman Mahabbah',
    ),
  }) {
    final router = GoRouter(
      initialLocation: '/screen',
      routes: [
        GoRoute(path: '/screen', builder: (_, _) => screen),
        GoRoute(
          path: '/finance',
          builder: (_, _) {
            visited.add('/finance');
            return const Scaffold(body: Text('HOME-STUB'));
          },
        ),
        GoRoute(
          path: '/finance/setup',
          builder: (_, _) {
            visited.add('/finance/setup');
            return const Scaffold(body: Text('SETUP-STUB'));
          },
        ),
      ],
    );
    return ProviderScope(
      overrides: overrides(roles: roles, info: info),
      child: MaterialApp.router(
        debugShowCheckedModeBanner: false,
        theme: SurauTheme.light(),
        locale: const Locale('ms'),
        localizationsDelegates: S.localizationsDelegates,
        supportedLocales: S.supportedLocales,
        routerConfig: router,
      ),
    );
  }
}
