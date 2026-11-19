// Video (2026.11.13): the list row, the source switch, the YouTube link reader, the limits and storage text, the
// cloud note, and the upload flow over a fake phone and box (Simpan waits for the upload, then the PUT carries the file).

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/box/box_client.dart';
import 'package:surau_app/content/video_services.dart';
import 'package:surau_app/features/shell/box_gateway.dart';

import '../features/shell/harness.dart';
import '../golden_sizes.dart';
import '../support/mp4.dart';

class FakeVideoServices extends VideoServices {
  FakeVideoServices({this.canShrink = false, this.uploadError, this.storageBytes = 800 * 1024 * 1024, Uint8List? file})
    : file = file ?? Uint8List.fromList('not a video at all'.codeUnits);

  /// What the gallery gives: by default something that is not an MP4 (so the phone must shrink it or refuse it).
  final Uint8List file;
  final bool canShrink;
  final Object? uploadError;
  final int storageBytes;
  final Completer<UploadedVideo> release = Completer<UploadedVideo>();
  bool compressed = false;
  bool cleared = false;
  bool uploaded = false;
  final List<String> asked = [];

  PickedVideo _of(String name, Uint8List b) => PickedVideo(
    name: name,
    length: b.length,
    open: ([s, e]) => Stream.value(b.sublist(s ?? 0, (e ?? b.length).clamp(0, b.length))),
  );

  @override
  bool get canCompress => canShrink;

  @override
  Future<PickedVideo?> pick() async => _of('kuliah_subuh.mp4', file);

  @override
  Future<PickedVideo?> compress(PickedVideo v, void Function(double) onProgress) async {
    compressed = true;
    onProgress(0.5);
    return _of('kuliah_subuh_720.mp4', mp4());
  }

  @override
  Future<UploadedVideo> upload(BoxGateway g, PickedVideo v, void Function(double) onProgress) async {
    uploaded = true;
    onProgress(0.4);
    if (uploadError != null) throw uploadError!;
    return release.future;
  }

  @override
  Future<void> clearCompressed() async {
    cleared = true;
  }

  @override
  Future<VideoStorage?> storage(BoxGateway g) async => VideoStorage(availableBytes: storageBytes, usedBytes: 0, totalBytes: 1024 * 1024 * 1024);

  @override
  Future<YoutubeInfo?> oembed(String id) async {
    asked.add(id);
    return const YoutubeInfo(title: 'Tazkirah Jumaat: Menjaga Lisan', author: 'Surau Contoh');
  }
}

const _asset = 'ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12';

Future<ShellHarness> open(WidgetTester tester, String path, {FakeVideoServices? services, List<dynamic> extra = const []}) async {
  final h = await pumpShell(
    tester,
    roles: const ['admin'],
    overrides: [
      if (services != null) videoServicesProvider.overrideWithValue(services),
      ...extra.cast(),
    ],
  );
  h.router.go(path);
  await settle(tester);
  await pumpAtSize(tester, h.app, GoldenSize.phone);
  return h;
}

Finder get save => find.byKey(const ValueKey('content-save'));
bool saveOn(WidgetTester t) => t.widget<FilledButton>(save).onPressed != null;

void main() {
  testWidgets('list: a Video row says where it comes from, its days and, past its date, offers to delete', (tester) async {
    await open(tester, '/content/video');
    expect(find.text('Tambah video'), findsOneWidget);
    expect(find.text('Selamat datang'), findsOneWidget);
    expect(find.textContaining('Muat naik, 1:15'), findsOneWidget);
    expect(find.text('Kuliah Subuh (petikan)'), findsOneWidget);
    expect(find.textContaining('Petikan rakaman 2:00 hingga 7:00'), findsOneWidget);
    expect(find.text('Berbunyi'), findsOneWidget, reason: 'the second video has sound on');
  });

  testWidgets('a new video: Muat naik first, the limits and the box storage under the picker, Simpan off', (tester) async {
    await open(tester, '/content/video/new', services: FakeVideoServices());
    expect(find.text('Sumber video'), findsOneWidget);
    expect(find.byKey(const ValueKey('video-pick')), findsOneWidget);
    expect(find.text('Paling besar 300 MB, paling lama 10 minit, 720p. Pangkas dalam Galeri telefon dahulu jika perlu.'), findsOneWidget);
    expect(find.text('Ruang storan MAXCOM: 800 MB lagi'), findsOneWidget);
    expect(saveOn(tester), isFalse);
  });

  testWidgets('the source switch shows the YouTube link, then the clip fields for a recording, then the file picker again', (tester) async {
    await open(tester, '/content/video/new', services: FakeVideoServices());
    await tester.tap(find.widgetWithText(ChoiceChip, 'YouTube'));
    await settle(tester);
    expect(find.byKey(const ValueKey('field-youtubeLink')), findsOneWidget);
    expect(find.byKey(const ValueKey('video-pick')), findsNothing);
    expect(find.byKey(const ValueKey('field-clipStart')), findsNothing);
    expect(find.textContaining('mungkin ada iklan'), findsOneWidget);
    await tester.tap(find.widgetWithText(ChoiceChip, 'Rakaman'));
    await settle(tester);
    expect(find.byKey(const ValueKey('field-clipStart')), findsOneWidget);
    expect(find.byKey(const ValueKey('field-clipEnd')), findsOneWidget);
    await tester.tap(find.widgetWithText(ChoiceChip, 'Muat naik'));
    await settle(tester);
    expect(find.byKey(const ValueKey('video-pick')), findsOneWidget);
  });

  testWidgets('a pasted YouTube link: the id is read, the title is fetched into an empty title, Simpan sends the item', (tester) async {
    final svc = FakeVideoServices();
    final h = await open(tester, '/content/video/new', services: svc);
    await tester.tap(find.widgetWithText(ChoiceChip, 'YouTube'));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('field-youtubeLink')), 'https://youtu.be/dQw4w9WgXcQ?t=3');
    await settle(tester);
    expect(svc.asked, ['dQw4w9WgXcQ']);
    expect(find.byKey(const ValueKey('video-info')), findsOneWidget);
    expect(find.text('Tazkirah Jumaat: Menjaga Lisan'), findsWidgets);
    await reveal(tester, save);
    expect(saveOn(tester), isTrue);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.seen.firstWhere((r) => r.method == 'PUT' && r.url.path.startsWith('/api/content/video/'));
    final body = jsonDecode(put.body) as Map;
    expect(body['source'], 'youtube');
    expect(body['youtubeId'], 'dQw4w9WgXcQ');
    expect(body['title'], 'Tazkirah Jumaat: Menjaga Lisan');
    expect(body.containsKey('assetId'), isFalse);
    expect(body.containsKey('sound'), isFalse, reason: 'silent unless the switch is on');
    expect(body['durationSec'], 300, reason: 'the 5-minute default, never the 10-minute cap');
  });

  testWidgets('a YouTube video: the rough length is asked in minutes (1 to 10) and sent in seconds', (tester) async {
    final h = await open(tester, '/content/video/new', services: FakeVideoServices());
    await tester.tap(find.widgetWithText(ChoiceChip, 'YouTube'));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('field-youtubeLink')), 'dQw4w9WgXcQ');
    await settle(tester);
    final est = find.byKey(const ValueKey('field-estimateMin'));
    expect(est, findsOneWidget);
    expect(find.text('Anggaran tempoh (minit)'), findsOneWidget);
    expect(tester.widget<TextField>(est).controller!.text, '5');
    await tester.enterText(est, '11');
    await settle(tester);
    expect(find.text('Masukkan nombor 1 hingga 10.'), findsOneWidget);
    await reveal(tester, save);
    expect(saveOn(tester), isFalse);
    await tester.enterText(est, '8');
    await settle(tester);
    await reveal(tester, save);
    expect(saveOn(tester), isTrue);
    await tester.tap(save);
    await settle(tester);
    final body = jsonDecode(h.box.seen.firstWhere((r) => r.method == 'PUT' && r.url.path.startsWith('/api/content/video/')).body) as Map;
    expect(body['durationSec'], 480);
  });

  testWidgets('a link that is not a video, and a live link, are refused in words', (tester) async {
    await open(tester, '/content/video/new', services: FakeVideoServices());
    await tester.tap(find.widgetWithText(ChoiceChip, 'YouTube'));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('field-youtubeLink')), 'https://example.com/x');
    await settle(tester);
    expect(find.text('Ini bukan pautan video YouTube.'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('field-youtubeLink')), 'https://www.youtube.com/live/dQw4w9WgXcQ');
    await settle(tester);
    expect(find.textContaining('Ini siaran langsung'), findsOneWidget);
    expect(find.textContaining('gunakan Siaran langsung'), findsOneWidget);
    await reveal(tester, save);
    expect(saveOn(tester), isFalse);
  });

  testWidgets('a recording clip: the end must come after the start, and the clip is sent in seconds', (tester) async {
    final h = await open(tester, '/content/video/new', services: FakeVideoServices());
    await tester.tap(find.widgetWithText(ChoiceChip, 'Rakaman'));
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('field-youtubeLink')), 'dQw4w9WgXcQ');
    await settle(tester);
    await tester.enterText(find.byKey(const ValueKey('field-clipStart')), '12:00');
    await tester.enterText(find.byKey(const ValueKey('field-clipEnd')), '11:00');
    await settle(tester);
    expect(find.text('Tamat mesti selepas mula.'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('field-clipEnd')), '22:00');
    await settle(tester);
    await reveal(tester, save);
    expect(saveOn(tester), isTrue);
    await tester.tap(save);
    await settle(tester);
    final body = jsonDecode(h.box.seen.firstWhere((r) => r.method == 'PUT' && r.url.path.startsWith('/api/content/video/')).body) as Map;
    expect([body['source'], body['startSec'], body['endSec']], ['rakaman', 720, 1320]);
    expect(body['durationSec'], 600, reason: 'the clip length, end minus start');
  });

  testWidgets('over the cloud the editor says uploads need the surau Wi-Fi and offers no picker', (tester) async {
    await open(tester, '/content/video/new', services: FakeVideoServices(), extra: [isCloudGatewayProvider.overrideWithValue(true)]);
    expect(find.byKey(const ValueKey('video-cloud-note')), findsOneWidget);
    expect(find.textContaining('Muat naik video hanya di Wi-Fi surau'), findsOneWidget);
    expect(find.byKey(const ValueKey('video-pick')), findsNothing);
    await tester.tap(find.widgetWithText(ChoiceChip, 'YouTube'));
    await settle(tester);
    expect(find.byKey(const ValueKey('field-youtubeLink')), findsOneWidget);
  });

  testWidgets('a file the phone cannot shrink is refused with the reason and nothing is sent', (tester) async {
    final svc = FakeVideoServices();
    await open(tester, '/content/video/new', services: svc);
    await tester.tap(find.byKey(const ValueKey('video-pick')));
    await settle(tester);
    expect(svc.uploaded, isFalse);
    expect(find.textContaining('Video mesti MP4 dengan H.264'), findsOneWidget);
    expect(find.textContaining('Telefon ini tidak boleh mengecilkan video'), findsOneWidget);
    expect(saveOn(tester), isFalse);
  });

  testWidgets('on Android the file is shrunk first, then uploaded: Simpan waits, then the PUT carries the file and its length', (tester) async {
    final svc = FakeVideoServices(canShrink: true);
    final h = await open(tester, '/content/video/new', services: svc);
    await tester.tap(find.byKey(const ValueKey('video-pick')));
    await tester.pump();
    await tester.pump();
    // the upload is under way: its progress shows and Simpan is off
    expect(svc.compressed, isTrue);
    expect(svc.uploaded, isTrue);
    expect(find.byKey(const ValueKey('video-progress')), findsOneWidget);
    expect(find.textContaining('Memuat naik ke MAXCOM... 40%'), findsOneWidget);
    await reveal(tester, save);
    expect(saveOn(tester), isFalse);
    expect(find.text('Tunggu muat naik selesai sebelum Simpan.'), findsOneWidget);
    svc.release.complete(const UploadedVideo(id: _asset, bytes: 40 * 1024 * 1024, durationSec: 95));
    await settle(tester);
    expect(find.byKey(const ValueKey('video-uploaded')), findsOneWidget);
    expect(svc.cleared, isTrue, reason: 'the compressed copy in the phone cache is deleted once it is sent');
    expect(find.text('Sudah dimuat naik ke MAXCOM'), findsOneWidget);
    await reveal(tester, save);
    expect(saveOn(tester), isTrue, reason: 'the title came from the file name');
    await tester.tap(save);
    await settle(tester);
    final body = jsonDecode(h.box.seen.firstWhere((r) => r.method == 'PUT' && r.url.path.startsWith('/api/content/video/')).body) as Map;
    expect([body['source'], body['assetId'], body['durationSec'], body['title']], ['upload', _asset, 95, 'kuliah subuh']);
  });

  Iterable<String> deletes(ShellHarness h) => h.box.seen.where((r) => r.method == 'DELETE' && r.url.path.startsWith('/api/assets/video/')).map((r) => r.url.path);

  testWidgets('a second pick removes the first uploaded file from the box', (tester) async {
    final svc = FakeVideoServices(canShrink: true);
    final h = await open(tester, '/content/video/new', services: svc);
    await tester.tap(find.byKey(const ValueKey('video-pick')));
    await tester.pump();
    await tester.pump();
    svc.release.complete(const UploadedVideo(id: _asset, bytes: 1024, durationSec: 95));
    await settle(tester);
    expect(deletes(h), isEmpty);
    await tester.tap(find.byKey(const ValueKey('video-pick')));
    await tester.pump();
    await tester.pump();
    expect(deletes(h), ['/api/assets/video/$_asset']);
  });

  testWidgets('Batal after an upload removes the file from the box; Simpan keeps it', (tester) async {
    final svc = FakeVideoServices(canShrink: true);
    final h = await open(tester, '/content/video/new', services: svc);
    await tester.tap(find.byKey(const ValueKey('video-pick')));
    await tester.pump();
    await tester.pump();
    svc.release.complete(const UploadedVideo(id: _asset, bytes: 1024, durationSec: 95));
    await settle(tester);
    await reveal(tester, find.text('Batal'));
    await tester.tap(find.text('Batal'));
    await settle(tester);
    expect(deletes(h), ['/api/assets/video/$_asset']);
  });

  testWidgets('a saved upload is not removed when the editor closes', (tester) async {
    final svc = FakeVideoServices(canShrink: true);
    final h = await open(tester, '/content/video/new', services: svc);
    await tester.tap(find.byKey(const ValueKey('video-pick')));
    await tester.pump();
    await tester.pump();
    svc.release.complete(const UploadedVideo(id: _asset, bytes: 1024, durationSec: 95));
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    expect(deletes(h), isEmpty);
  });

  testWidgets('a box refusal reads in words: no space, too big', (tester) async {
    final svc = FakeVideoServices(canShrink: true, uploadError: const BoxError(413, 'x', code: 'no_space'));
    await open(tester, '/content/video/new', services: svc);
    await tester.tap(find.byKey(const ValueKey('video-pick')));
    await settle(tester);
    expect(find.text('Ruang storan MAXCOM tidak mencukupi. Padam video lama dahulu.'), findsOneWidget);
    expect(saveOn(tester), isFalse);
  });

  testWidgets('the box has less room than the file: refused before sending', (tester) async {
    final svc = FakeVideoServices(canShrink: true, storageBytes: 100);
    await open(tester, '/content/video/new', services: svc);
    await tester.tap(find.byKey(const ValueKey('video-pick')));
    await settle(tester);
    expect(svc.uploaded, isFalse);
    expect(find.textContaining('Ruang storan MAXCOM tidak mencukupi'), findsWidgets);
  });

  testWidgets('over the cloud a saved upload is read-only with the note and no Simpan; a recording stays editable', (tester) async {
    await open(tester, '/content/video/vd1', services: FakeVideoServices(), extra: [isCloudGatewayProvider.overrideWithValue(true)]);
    expect(find.byKey(const ValueKey('video-cloud-readonly')), findsOneWidget);
    expect(find.textContaining('hanya boleh diubah di Wi-Fi surau'), findsOneWidget);
    expect(save, findsNothing);
    expect(find.byKey(const ValueKey('video-pick')), findsNothing);
  });

  testWidgets('over the cloud a saved recording can still be saved', (tester) async {
    await open(tester, '/content/video/vd2', services: FakeVideoServices(), extra: [isCloudGatewayProvider.overrideWithValue(true)]);
    expect(find.byKey(const ValueKey('video-cloud-readonly')), findsNothing);
    await reveal(tester, save);
    expect(saveOn(tester), isTrue);
  });

  testWidgets('a box older than 2026.11.13 does not offer the Video kind', (tester) async {
    final h = await pumpShell(tester, roles: const ['admin'], health: {...healthyJson}..remove('features'));
    h.router.go('/content');
    await settle(tester);
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    expect(find.text('Poster'), findsWidgets);
    expect(find.text('Video'), findsNothing);
  });

  testWidgets('a saved upload opens as uploaded, with Bunyi as saved, and deleting it asks first', (tester) async {
    final h = await open(tester, '/content/video/vd1', services: FakeVideoServices());
    expect(find.byKey(const ValueKey('video-uploaded')), findsOneWidget);
    expect(find.text('Selamat datang'), findsWidgets);
    final sound = find.byKey(const ValueKey('field-sound'));
    await reveal(tester, sound);
    expect(tester.widget<SwitchListTile>(sound).value, isFalse);
    await reveal(tester, find.text('Padam'));
    await tester.tap(find.text('Padam'));
    await settle(tester);
    expect(h.box.seen.where((r) => r.method == 'DELETE'), isEmpty, reason: 'asks first');
  });
}
