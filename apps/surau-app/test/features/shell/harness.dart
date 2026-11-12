// The whole app (router, shell, providers) over a fake box, for the shell,
// dashboard, guard and offline tests. The person is already enrolled and,
// unless asked otherwise, unlocked with the given roles.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:image/image.dart' as img;
import 'package:pointycastle/digests/sha256.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:surau_app/app/deps.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/content/adjusted_picture.dart';
import 'package:surau_app/content/asset_picker.dart';
import 'package:surau_app/content/image_bg.dart';
import 'package:surau_app/content/image_prep.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/features/enrol/enrol_flow.dart';
import 'package:surau_app/features/live/fake_publisher.dart';
import 'package:surau_app/features/live/live_screen.dart' show livePublisherProvider;
import 'package:surau_app/features/registry.g.dart';
import 'package:surau_app/features/settings_widgets/audio_asset_picker.dart' show pickAudioProvider;
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/main.dart';
import 'package:surau_app/screens/preview_screen.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';

/// `GET /api/health` for an admin: 212 days of prayer data, a certificate
/// good for a year, nobody locked out, data version 17.
const Map<String, Object?> healthyJson = {
  'ok': true,
  'version': 17,
  'tls': {
    'mode': 'self',
    'notAfter': '2027-11-03T14:30:00.000Z',
    'daysLeft': 364,
    'ipSan': ['10.168.0.154'],
  },
  'users': 5,
  'devices': 7,
  'lockedUsers': 0,
  'daysAhead': 212,
  'assetsBytes': 1048576,
};

Map<String, Object?> settingsJson([Map<String, bool> features = const {}]) => {
  for (final e in featureDefaultEnabled.entries) e.key: {'enabled': features[e.key] ?? e.value},
  // Features outside the menu map (appLock) only when a test asks for them.
  for (final e in features.entries)
    if (!featureDefaultEnabled.containsKey(e.key)) e.key: {'enabled': e.value},
  'clock': {'enabled': true, 'showSeconds': false},
};

/// `GET /api/users` for the people screens: an admin, a treasurer who is
/// also on the committee, a locked media person, an inactive member and
/// one whose PIN was reset.
List<Map<String, Object?>> usersFixture() => [
  {
    'id': 'u1',
    'name': 'Ustaz Ali',
    'roles': ['admin'],
    'active': true,
    'pinRequired': false,
    'pinLockedUntil': null,
  },
  {
    'id': 'u2',
    'name': 'Aminah binti Yusof',
    'roles': ['treasurer', 'ajk'],
    'active': true,
    'pinRequired': false,
    'pinLockedUntil': null,
  },
  {
    'id': 'u3',
    'name': 'Encik Hafiz',
    'roles': ['media'],
    'active': true,
    'pinRequired': false,
    'pinLockedUntil': '2026-11-04T15:00:00.000Z',
  },
  {
    'id': 'u4',
    'name': 'Pak Mat',
    'roles': ['ajk'],
    'active': false,
    'pinRequired': false,
    'pinLockedUntil': null,
  },
  {
    'id': 'u5',
    'name': 'Kak Ros',
    'roles': ['ajk'],
    'active': true,
    'pinRequired': true,
    'pinLockedUntil': null,
  },
];

/// `GET /api/devices` (revoked included): phones, an iPad, a browser, a
/// revoked phone and the paired TV screen.
List<Map<String, Object?>> devicesFixture() => [
  {'id': 'dev-1', 'userId': 'u1', 'name': 'Telefon Ali', 'platform': 'android', 'revoked': false},
  {'id': 'dev-2', 'userId': 'u2', 'name': 'iPad Aminah', 'platform': 'ios-web', 'revoked': false},
  {'id': 'dev-3', 'userId': 'u2', 'name': 'Telefon lama', 'platform': 'android', 'revoked': true},
  {'id': 'dev-4', 'userId': 'u3', 'name': 'Komputer Hafiz', 'platform': 'web', 'revoked': false},
  {'id': 'dev-5', 'userId': 'u1', 'name': 'Skrin utama', 'platform': 'kiosk', 'revoked': false},
];

/// `GET /api/audit`, newest first: a settings change, a role change, a
/// device enrolment and the first admin made by the box itself.
List<Map<String, Object?>> auditFixture() => [
  {
    'id': 12,
    'at': '2026-11-04T14:20:00.000Z',
    'actor': 'user:u1',
    'userName': 'Ustaz Ali',
    'deviceId': 'dev-1',
    'entity': 'settings',
    'entityId': 'iqamah',
    'before': {'adjustDays': 0, 'enabled': true},
    'after': {'adjustDays': 1, 'enabled': true},
  },
  {
    'id': 11,
    'at': '2026-11-04T13:05:00.000Z',
    'actor': 'user:u1',
    'userName': 'Ustaz Ali',
    'deviceId': 'dev-1',
    'entity': 'users',
    'entityId': 'u2',
    'before': {
      'name': 'Aminah binti Yusof',
      'roles': ['treasurer'],
      'active': true,
    },
    'after': {
      'name': 'Aminah binti Yusof',
      'roles': ['treasurer', 'ajk'],
      'active': true,
    },
  },
  {
    'id': 10,
    'at': '2026-11-03T02:10:00.000Z',
    'actor': 'user:u3',
    'userName': 'Encik Hafiz',
    'deviceId': null,
    'entity': 'devices',
    'entityId': 'dev-4',
    'before': null,
    'after': {'id': 'dev-4', 'name': 'Komputer Hafiz', 'platform': 'web', 'revoked': false},
  },
  {
    'id': 9,
    'at': '2026-11-01T01:00:00.000Z',
    'actor': 'system',
    'userName': null,
    'deviceId': null,
    'entity': 'users',
    'entityId': 'u1',
    'before': null,
    'after': {
      'id': 'u1',
      'name': 'Ustaz Ali',
      'roles': ['admin'],
      'active': true,
    },
  },
];

/// `GET /api/auth/me` for the enrolled admin on their Android phone.
Map<String, Object?> meFixture() => {
  'user': {'id': 'u1', 'name': 'Ustaz Ali'},
  'device': {'id': 'dev-1', 'name': 'Telefon Ali', 'platform': 'android'},
  'roles': ['admin'],
  'expiresAt': '2026-11-05T00:00:00.000Z',
};

/// `GET /api/kiosk/pair/pending`: one TV asked 25 seconds ago.
Map<String, Object?> pendingFixture() => {
  'pairings': [
    {
      'requesterIp': '10.168.0.23',
      'createdAt': '2026-11-04T14:29:35.000Z',
      'expiresAt': '2026-11-04T14:39:35.000Z',
      'codeAgeSeconds': 25,
    },
  ],
};

/// `POST /api/enrol/begin`: a code good for 9 minutes 55 seconds from the
/// fixed clock, with the payload the admin's QR would carry.
Map<String, Object?> enrolBeginFixture() => {
  'code': 'ABCD-EFGH-2345',
  'expiresAt': '2026-11-04T14:39:55.000Z',
  'payload': fixturePayload(
    user: 'Aminah binti Yusof',
    roles: const ['treasurer', 'ajk'],
    exp: 1793803500000 - 5 * 60000 - 5000,
  ),
};

/// Asset ids the content fixtures refer to (sha256 hex, as the box's).
const String fixtureAssetPoster = 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const String fixtureAssetPhoto = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';

/// The surau logo as an uploaded asset (Tetapan > Maklumat surau) and the
/// public path the box answers for it (`/api/surau/info` and the bundle).
const String fixtureAssetLogo = 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3';
const String fixtureLogoPath = '/surau-logo?v=d3d3d3d3d3d3d3d3';

/// `GET /api/surau/info` with the logo set (and whether the name is
/// written beside it).
Map<String, Object?> fixtureInfoWithLogoJson({bool showName = true}) => {
  ...fixtureInfoJson,
  'logo': fixtureLogoPath,
  'showName': showName,
};

/// The operator's wide wordmark (500 x 126 on white) as uploaded, and as
/// the box serves it after `Buang latar putih` (rendered by the box's own
/// code: trimmed, the white made transparent).
Uint8List fixtureMaxcomPng() => File('test/fixtures/maxcom-logo.png').readAsBytesSync();
Uint8List fixtureMaxcomRemovedPng() => File('test/fixtures/maxcom-logo-removed.png').readAsBytesSync();

/// The `surauInfo.logo` setting for the wordmark: the box's analysis of
/// it as the initial adjustment (trim box, white removed).
Map<String, Object?> fixtureWideLogoRef() => {
  'asset': fixtureAssetLogo,
  'crop': {'x': 0.038, 'y': 0.0556, 'w': 0.93, 'h': 0.9444},
  'bg': 'remove',
};

/// A drawn surau logo (a gold crescent-ish disc on deep teal, 96 x 96 PNG):
/// what `/surau-logo` and `/assets/<fixtureAssetLogo>` answer.
Uint8List fixtureLogoPng() {
  final im = img.Image(width: 96, height: 96);
  img.fill(im, color: im.getColor(6, 48, 43));
  img.fillCircle(im, x: 48, y: 48, radius: 36, color: im.getColor(240, 201, 122));
  img.fillCircle(im, x: 60, y: 42, radius: 28, color: im.getColor(6, 48, 43));
  img.fillCircle(im, x: 66, y: 36, radius: 5, color: im.getColor(240, 201, 122));
  return Uint8List.fromList(img.encodePng(im));
}

/// A poster picture (a warm gradient with a dark band, 160 x 90 PNG): what
/// `/assets/<fixtureAssetPoster>` answers, so poster rows show a thumbnail.
Uint8List fixturePosterPng() {
  final im = img.Image(width: 160, height: 90);
  for (var y = 0; y < 90; y++) {
    for (var x = 0; x < 160; x++) {
      im.setPixel(x, y, im.getColor(184 - y, 103 + (x ~/ 4), 58));
    }
  }
  img.fillRect(im, x1: 0, y1: 60, x2: 159, y2: 89, color: im.getColor(42, 31, 61));
  return Uint8List.fromList(img.encodePng(im));
}

/// `GET /api/content/<kind>` for every kind: a small, realistic surau.
Map<String, List<Map<String, Object?>>> contentFixture() {
  Map<String, Object?> meta(String id) => {'id': id, 'updatedAt': '2026-11-03T09:00:00.000Z', 'updatedBy': 'user:u1'};
  return {
    'penceramah': [
      {
        ...meta('p1'),
        'name': 'Ustaz Ahmad Fauzi',
        'title': 'Ustaz',
        'phone': '012-345 6789',
        'photoAssetId': fixtureAssetPhoto,
      },
      {...meta('p2'), 'name': 'Ustazah Siti Khadijah', 'title': 'Ustazah'},
    ],
    'kitab': [
      {...meta('k1'), 'title': 'Riyadhus Salihin', 'author': 'Imam an-Nawawi'},
      {...meta('k2'), 'title': 'Fiqh Sunnah', 'author': 'Sayyid Sabiq'},
    ],
    'kuliah': [
      {
        ...meta('c1'),
        'date': '2026-11-06',
        'slot': 'maghrib',
        'time': '19:15',
        'label': 'Kuliah Maghrib',
        'penceramahId': 'p1',
        'kitabId': 'k1',
        'topic': 'Bab sabar',
        'status': 'aktif',
      },
      {
        ...meta('c2'),
        'date': '2026-11-05',
        'slot': 'subuh',
        'time': '06:30',
        'label': 'Kuliah Subuh',
        'penceramahId': 'p2',
        'status': 'aktif',
      },
      {
        ...meta('c3'),
        'date': '2026-11-04',
        'slot': 'isyak',
        'time': '21:00',
        'label': 'Kuliah Isyak',
        'penceramahId': 'p1',
        'status': 'batal',
      },
    ],
    'pengumuman': [
      {
        ...meta('a1'),
        'title': 'Gotong-royong surau',
        'body': 'Sabtu ini selepas Subuh. Sarapan disediakan.',
        'from': '2026-11-01',
        'to': '2026-11-07',
        'priority': 2,
      },
      {
        ...meta('a2'),
        'title': 'Kutipan tabung anak yatim',
        'body': 'Sumbangan boleh diserahkan kepada bendahari.',
        'from': '2026-11-01',
        'to': '2026-11-30',
        'priority': 1,
      },
    ],
    'ticker': [
      {...meta('t1'), 'text': 'Selamat datang ke Surau D\'Waqaf', 'from': '2026-01-01', 'to': '2026-12-31'},
    ],
    'poster': [
      {
        ...meta('o1'),
        'title': 'Kempen Derma Surau',
        'assetId': fixtureAssetPoster,
        'days': ['umum'],
        'from': '2026-11-01',
        'to': '2026-11-30',
        'order': 1,
      },
      {
        ...meta('o2'),
        'title': 'Jadual Kuliah Jumaat',
        'assetId': fixtureAssetPoster,
        'days': ['jumaat'],
        'order': 2,
      },
    ],
    'programKhas': [
      {
        ...meta('g1'),
        'title': 'Majlis Maulidur Rasul',
        'at': '2026-11-20T20:30',
        'showFrom': '2026-11-10',
        'showTo': '2026-11-20',
        'note': 'Jamuan disediakan',
        'status': 'aktif',
      },
    ],
    'takwim': [
      {...meta('w1'), 'date': '2026-12-25', 'hijriLabel': '14 Rejab 1448', 'title': 'Hari Keputeraan Sultan Selangor'},
    ],
    'hadis': [
      {
        ...meta('h1'),
        'textMs': 'Sesungguhnya setiap amalan itu bergantung kepada niat.',
        'textAr': 'إنما الأعمال بالنيات',
        'source': 'Riwayat al-Bukhari dan Muslim',
      },
    ],
    'worldTime': [
      {...meta('z1'), 'city': 'Makkah', 'tz': 'Asia/Riyadh', 'order': 1},
      {...meta('z2'), 'city': 'London', 'tz': 'Europe/London', 'order': 2},
    ],
    'petugas': [
      {...meta('s1'), 'name': 'Encik Hafiz'},
      {...meta('s2'), 'name': 'Pak Mat'},
    ],
    'tugasan': [
      {...meta('d1'), 'date': '2026-11-06', 'role': 'imam', 'petugasId': 's1', 'note': 'Solat Jumaat'},
      {...meta('d2'), 'date': '2026-11-06', 'role': 'bilal', 'petugasId': 's2'},
    ],
    'zikir': [
      {...meta('r1'), 'order': 1, 'textAr': 'سبحان الله', 'textMs': 'Maha Suci Allah', 'repeat': 33},
      {...meta('r2'), 'order': 2, 'textAr': 'الحمد لله', 'textMs': 'Segala puji bagi Allah', 'repeat': 33},
    ],
    'tilawahSlot': [
      {
        ...meta('l1'),
        'days': ['daily'],
        'before': 'subuh',
        'minutesBefore': 20,
        'surah': 18,
        'enabled': true,
      },
      {
        ...meta('l2'),
        'days': ['jumaat'],
        'before': 'zohor',
        'minutesBefore': 30,
        'surah': 36,
        'enabled': false,
      },
    ],
  };
}

typedef RouteHandler = Future<http.Response> Function(http.Request r);

class ShellHarness {
  ShellHarness({
    required this.roles,
    Map<String, bool> features = const {},
    Map<String, Object?>? health,
    this.logo = false,
    this.wideLogo = false,
    this.showName = true,
    List<Override> overrides = const [],
  }) : settings = settingsJson(features),
       health = health ?? Map.of(healthyJson) {
    box = FakeBox(_handle);
    final enrolled = fixtureBox(roles: roles);
    final info = SurauInfo.fromJson(hasLogo ? fixtureInfoWithLogoJson(showName: showName) : fixtureInfoJson);
    if (hasLogo) {
      settings['surauInfo'] = {
        ...(settings['surauInfo'] as Map? ?? const {}),
        'name': fixtureInfoJson['name'],
        'logo': wideLogo ? fixtureWideLogoRef() : fixtureAssetLogo,
        'showName': showName,
      };
    }
    deps = AppDeps(
      boxStore: MemoryEnrolledBoxStore()..save(enrolled),
      surauInfoStore: MemorySurauInfoStore(info),
      key: FakeDeviceKey(present: true),
      trust: FakeTrust(),
      biometric: FakeBiometricPin(),
      clientFor: (uri) => box.client(uri),
      enrolledClient: (b) async => box.client(b.box),
      platform: 'android',
      cameraAvailable: false,
      scannerBuilder: (_, _, _) => const SizedBox.shrink(),
      healthPollInterval: null,
      openUrl: opener.call,
      now: fixedNow,
      toLocal: fixedToLocal,
      initialBox: enrolled,
      initialSurau: info,
    );
    container = ProviderContainer(
      overrides: [
        appDepsProvider.overrideWithValue(deps),
        // The editors' image picker answers with [pickedImage]; the
        // resize runs on this thread (no isolate under the test clock).
        pickImageProvider.overrideWithValue(() async {
          final err = pickError;
          if (err != null) throw err;
          return pickedImage;
        }),
        pickAudioProvider.overrideWithValue(() async => pickedAudio),
        prepareImageProvider.overrideWithValue((bytes) async => prepareImageSync(bytes)),
        bakeImageProvider.overrideWithValue(
          (bytes, {int rotate = 0, ImageBox? crop}) async => bakeAdjustmentSync(bytes, rotate: rotate, crop: crop),
        ),
        // The background removal for previews runs on this thread too.
        processImageProvider.overrideWithValue((bytes) async => removeBackgroundPng(bytes)),
        // No platform WebView under the test binding: the preview page
        // gets an empty box where the kiosk would be; what it was asked to
        // show is kept in [previewRequests].
        previewBuilderProvider.overrideWithValue((_, r) {
          previewRequests.add(r);
          return const SizedBox.shrink();
        }),
        // No camera under the test binding: the Live tab gets the fake
        // publisher unless a test passes its own.
        if (overrides.isEmpty) livePublisherProvider.overrideWithValue(FakePublisher()),
        // A screen test's own stand-ins (the Live tab's publisher).
        ...overrides,
      ],
    );
    addTearDown(container.dispose);
  }

  /// When true the surau has a logo: `/api/surau/info` names it, the
  /// `surauInfo` setting holds its asset id, and both `/surau-logo` and
  /// `/assets/<id>` answer the PNG of [fixtureLogoPng].
  final bool logo;

  /// The wide wordmark instead: the setting holds [fixtureWideLogoRef],
  /// `/assets/<id>` answers the upload (on white) and `/surau-logo` the
  /// box's derived picture (white removed), as the real box does.
  final bool wideLogo;

  /// `surauInfo.showName`: false when the logo carries the name.
  final bool showName;

  bool get hasLogo => logo || wideLogo;

  /// Every request a preview host (the Pratonton page or a poster's
  /// `Pratonton di TV`) was built with, in order.
  final List<PreviewRequest> previewRequests = [];

  /// What `Pilih gambar` returns; null plays a cancelled picker.
  Uint8List? pickedAudio;
  Uint8List? pickedImage;

  /// When set, the picker throws it (a blocked blob: read on the web).
  Object? pickError;

  /// Every `POST /api/assets` body with its Content-Type, in order.
  final List<(String mime, Uint8List bytes)> assetsPosted = [];

  final List<String> roles;
  final Map<String, Object?> settings;
  Map<String, Object?> health;
  final opener = FakeOpener();
  late final FakeBox box;
  late final AppDeps deps;
  late final ProviderContainer container;

  /// When true, `/api/health` and `/api/settings` cannot be reached (the
  /// public routes still answer, as a box on another network would not,
  /// but the unlock tests need them).
  bool boxAway = false;

  /// What `/api/health` answers next; 401 plays an expired session.
  int healthStatus = 200;

  /// The next this-many PUTs are answered 500 (a reply that was lost).
  int failPuts = 0;

  /// The people screens' data, mutable so a test can play a box state.
  List<Map<String, Object?>> users = usersFixture();
  List<Map<String, Object?>> devices = devicesFixture();
  List<Map<String, Object?>> audit = auditFixture();
  Map<String, Object?> me = meFixture();
  Map<String, Object?> pending = pendingFixture();

  /// The content screens' data by kind, mutable: a PUT replaces or adds,
  /// a DELETE removes, as the box would.
  Map<String, List<Map<String, Object?>>> content = contentFixture();

  /// Answers for `'METHOD /path'` that win over the defaults below; a test
  /// sets one to play a refusal (409, 429) or a write's answer.
  final Map<String, RouteHandler> handlers = {};

  Future<http.Response> _handle(http.Request r) async {
    final path = r.url.path;
    final custom = handlers['${r.method} $path'];
    if (custom != null) return custom(r);
    if (r.method == 'PUT' && failPuts > 0) {
      failPuts--;
      return jsonResponse(500, {
        'errors': ['internal error'],
      });
    }
    // `GET /api/health` without a token is public on the box (the unlock
    // locates the box with it), like the auth routes.
    final publicHealth =
        path == '/api/health' && r.headers['authorization'] == null;
    if (boxAway && path.startsWith('/api/') && !_public(path) && !publicHealth) {
      throw http.ClientException('box away');
    }
    // The public logo and the pictures the fixtures refer to (the rest of
    // the assets stay unknown so a thumbnail's placeholder is exercised).
    if (path == '/surau-logo') {
      return hasLogo
          ? http.Response.bytes(
              wideLogo ? fixtureMaxcomRemovedPng() : fixtureLogoPng(),
              200,
              headers: {'content-type': 'image/png'},
            )
          : jsonResponse(404, {
              'errors': ['not found'],
            });
    }
    final asset = RegExp(r'^/assets/([0-9a-f]{64})$').firstMatch(path);
    if (asset != null) {
      final bytes = _assetBytes(asset.group(1)!);
      if (bytes != null) return http.Response.bytes(bytes, 200, headers: {'content-type': 'image/png'});
    }
    final analyze = RegExp(r'^/api/assets/([0-9a-f]{64})/analyze$').firstMatch(path);
    if (analyze != null) {
      // As the box: the analysis of the picture it holds, by the same rules.
      final bytes = _assetBytes(analyze.group(1)!);
      final a = bytes == null ? null : analyzeBytes(bytes);
      return a == null
          ? jsonResponse(404, {
              'errors': ['not found'],
            })
          : jsonResponse(200, a);
    }
    if (path == '/api/surau/info') {
      return jsonResponse(200, hasLogo ? fixtureInfoWithLogoJson(showName: showName) : fixtureInfoJson);
    }
    if (path == '/api/health' || path == '/api/settings') {
      if (healthStatus != 200 && path == '/api/health') {
        return jsonResponse(healthStatus, {
          'errors': ['Sesi tamat. Sila buka kunci semula'],
        });
      }
      return jsonResponse(200, path == '/api/health' ? health : settings);
    }
    switch ('${r.method} $path') {
      case 'GET /api/users':
        return jsonResponse(200, {'users': users});
      case 'POST /api/users':
        return jsonResponse(201, {
          'id': 'u9',
          ...jsonDecode(r.body) as Map<String, dynamic>,
          'active': true,
          'pinRequired': true,
          'pinLockedUntil': null,
        });
      case 'GET /api/devices':
        return jsonResponse(200, {'devices': devices});
      case 'GET /api/audit':
        return jsonResponse(200, {'entries': audit});
      case 'GET /api/auth/me':
        return jsonResponse(200, me);
      case 'GET /api/kiosk/pair/pending':
        return jsonResponse(200, pending);
      case 'POST /api/enrol/begin':
        return jsonResponse(200, enrolBeginFixture());
      case 'POST /api/kiosk/pair/approve':
        final b = jsonDecode(r.body) as Map<String, dynamic>;
        return jsonResponse(200, {
          'ok': true,
          'deviceId': 'dev-9',
          'name': (b['deviceName'] as String?) ?? 'Paparan surau',
          'requesterIp': '10.168.0.23',
          'codeAgeSeconds': 25,
        });
      case 'POST /api/auth/logout':
      case 'PUT /api/auth/pin':
        return jsonResponse(200, {'ok': true});
    }
    final roles = RegExp(r'^/api/users/([^/]+)/roles$').firstMatch(path);
    if (roles != null && r.method == 'PUT') {
      // As the box would: the next GET lists the new roles.
      final i = users.indexWhere((u) => u['id'] == roles.group(1));
      final user = {...users[i], 'roles': (jsonDecode(r.body) as Map<String, dynamic>)['roles']};
      users[i] = user;
      return jsonResponse(200, user);
    }
    final pin = RegExp(r'^/api/users/([^/]+)/pin$').firstMatch(path);
    if (pin != null && r.method == 'PUT') {
      final ids = ((jsonDecode(r.body) as Map<String, dynamic>)['revokeDeviceIds'] as List?) ?? const [];
      return jsonResponse(200, {
        'ok': true,
        'pinRequired': true,
        'revoked': ids,
        'devices': devices.where((d) => d['userId'] == pin.group(1) && !ids.contains(d['id'])).toList(),
      });
    }
    if (RegExp(r'^/api/users/[^/]+/deactivate$').hasMatch(path) ||
        RegExp(r'^/api/devices/[^/]+/revoke$').hasMatch(path)) {
      return jsonResponse(200, {'ok': true});
    }
    final feature = RegExp(r'^/api/settings/([^/]+)$').firstMatch(path);
    if (feature != null && r.method == 'PUT') {
      // As the box: the patch merged deeply, the whole settings answered.
      final key = feature.group(1)!;
      if (!features.any((f) => f.key == key)) {
        return jsonResponse(404, {
          'errors': ['unknown feature $key'],
        });
      }
      final patch = jsonDecode(r.body) as Map<String, dynamic>;
      final current = (settings[key] as Map?)?.cast<String, Object?>() ?? {};
      settings[key] = _deepMerge(current, patch);
      return jsonResponse(200, settings);
    }
    final kindList = RegExp(r'^/api/content/([^/]+)$').firstMatch(path);
    if (kindList != null && r.method == 'GET') {
      final items = content[kindList.group(1)!];
      if (items == null) {
        return jsonResponse(404, {
          'errors': ['unknown content kind ${kindList.group(1)}'],
        });
      }
      return jsonResponse(200, {'items': items});
    }
    final kindItem = RegExp(r'^/api/content/([^/]+)/([^/]+)$').firstMatch(path);
    if (kindItem != null) {
      final items = content[kindItem.group(1)!];
      if (items == null) {
        return jsonResponse(404, {
          'errors': ['unknown content kind ${kindItem.group(1)}'],
        });
      }
      final id = kindItem.group(2)!;
      final i = items.indexWhere((x) => x['id'] == id);
      if (r.method == 'PUT') {
        final item = <String, Object?>{
          ...jsonDecode(r.body) as Map<String, dynamic>,
          'id': id,
          'updatedAt': '2026-11-04T14:30:00.000Z',
          'updatedBy': 'user:u1',
        };
        if (i < 0) {
          items.add(item);
        } else {
          items[i] = item;
        }
        return jsonResponse(i < 0 ? 201 : 200, {'item': item});
      }
      if (r.method == 'DELETE') {
        if (i < 0) {
          return jsonResponse(404, {
            'errors': ['${kindItem.group(1)} $id not found'],
          });
        }
        items.removeAt(i);
        return http.Response('', 204);
      }
    }
    if (path == '/api/assets' && r.method == 'POST') {
      final mime = r.headers['content-type'] ?? '';
      final bytes = Uint8List.fromList(r.bodyBytes);
      assetsPosted.add((mime, bytes));
      final id = sha256Hex(bytes);
      return jsonResponse(201, {'id': id, 'mime': mime, 'bytes': bytes.length, 'width': 1, 'height': 1});
    }
    return happyBox(r);
  }

  /// The pictures the box holds: the fixtures' and every upload of this
  /// run; the rest of the ids stay unknown so a thumbnail's placeholder is
  /// exercised.
  Uint8List? _assetBytes(String id) {
    if (id == fixtureAssetLogo && hasLogo) return wideLogo ? fixtureMaxcomPng() : fixtureLogoPng();
    if (id == fixtureAssetPoster) return fixturePosterPng();
    for (final (_, bytes) in assetsPosted) {
      if (sha256Hex(bytes) == id) return bytes;
    }
    return null;
  }

  static Map<String, Object?> _deepMerge(Map<String, Object?> base, Map<String, dynamic> patch) {
    final out = Map<String, Object?>.of(base);
    for (final e in patch.entries) {
      final b = out[e.key];
      final v = e.value;
      out[e.key] = b is Map && v is Map ? _deepMerge(b.cast<String, Object?>(), v.cast<String, dynamic>()) : v;
    }
    return out;
  }

  static bool _public(String path) =>
      path == '/api/surau/info' ||
      path == '/api/auth/challenge' ||
      path == '/api/auth/unlock' ||
      path == '/api/enrol/complete';

  GoRouter get router => container.read(routerProvider);

  String get location => router.routerDelegate.currentConfiguration.uri.path;

  SessionDto session() => SessionDto(
    token: 'tok-1',
    expiresAt: '2026-11-05T00:00:00.000Z',
    user: SessionUser(id: 'u1', name: 'Ustaz Ali', roles: roles),
  );

  void unlock() => container.read(sessionProvider.notifier).set(session());

  /// One instance, so goldens can find it by identity across sizes.
  late final Widget app = UncontrolledProviderScope(container: container, child: const SurauApp());
}

/// Builds the app, unlocked with [roles], and pumps it at [size].
Future<ShellHarness> pumpShell(
  WidgetTester tester, {
  List<String> roles = const ['ajk'],
  Map<String, bool> features = const {},
  Map<String, Object?>? health,
  bool unlocked = true,
  bool logo = false,
  bool wideLogo = false,
  bool showName = true,
  GoldenSize size = GoldenSize.phone,
  List<Override> overrides = const [],
}) async {
  SharedPreferences.setMockInitialValues({});
  final h = ShellHarness(
    roles: roles,
    features: features,
    health: health,
    logo: logo,
    wideLogo: wideLogo,
    showName: showName,
    overrides: overrides,
  );
  if (unlocked) h.unlock();
  await pumpAtSize(tester, h.app, size);
  return h;
}

/// Scrolls the page's list until [finder] exists and is on screen (a lazy
/// list builds a row only near the viewport; `ensureVisible` alone has
/// been seen to leave a widget under the fold).
Future<void> reveal(WidgetTester tester, Finder finder) async {
  for (var i = 0; i < 60 && finder.evaluate().isEmpty; i++) {
    await tester.drag(find.byType(ListView).first, const Offset(0, -200));
    await tester.pump();
  }
  for (var i = 0; i < 60 && finder.evaluate().isEmpty; i++) {
    await tester.drag(find.byType(ListView).first, const Offset(0, 200));
    await tester.pump();
  }
  await tester.ensureVisible(finder.first);
  await settle(tester);
  // Still under the fold (a bottom bar, a floating toast): drag a little more.
  for (var i = 0; i < 10; i++) {
    final box = tester.getRect(finder.first);
    final view = tester.view.physicalSize / tester.view.devicePixelRatio;
    if (box.bottom <= view.height - 90) break;
    await tester.drag(find.byType(ListView).first, const Offset(0, -120));
    await settle(tester);
  }
}

/// Lower-case sha256 hex, the box's asset id of [bytes].
String sha256Hex(Uint8List bytes) {
  final d = SHA256Digest()..update(bytes, 0, bytes.length);
  final out = Uint8List(32);
  d.doFinal(out, 0);
  return out.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

/// Pumps and lets the fake box answer (microtasks plus one frame).
Future<void> settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pumpAndSettle();
}

/// Lets `Image.memory` pictures (logo, thumbnails) decode before a golden:
/// decoding runs outside the test clock, so a golden taken straight after
/// the first pump would show their placeholders.
Future<void> settleImages(WidgetTester tester) async {
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 80)));
  await tester.pump();
  await tester.pumpAndSettle();
}
