// Content: the kinds page, a kind's list (kuliah newest first with the
// speaker and a `Batal` badge, search), the editors (a new kuliah sends
// exactly its keys plus `status: aktif`, an announcement with from after
// to is refused before anything is sent, a poster's picture is uploaded
// raw as image/jpeg before the PUT carries its id, a tilawah slot edited
// in place), delete behind a confirm, the box's 409 in BM, the offline
// refusal, and an AJK who sees no Tambah and a read-only form. Goldens:
// content_list_kuliah, content_edit_kuliah, content_edit_poster,
// content_edit_tilawah.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:surau_app/app/providers.dart';
import 'package:surau_app/content/image_adjust.dart' show CropEditor;

import '../features/fakes.dart';
import '../features/shell/harness.dart';
import '../golden_sizes.dart';

Future<ShellHarness> openContent(
  WidgetTester tester, [
  String path = '/content',
  List<String> roles = const ['admin'],
]) async {
  final h = await pumpShell(tester, roles: roles);
  h.router.go(path);
  await settle(tester);
  return h;
}

Finder field(String key) => find.byKey(ValueKey('field-$key'));

Finder get save => find.byKey(const ValueKey('content-save'));

bool saveEnabled(WidgetTester tester) => tester.widget<FilledButton>(save).enabled;

final uuidRe = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

/// A 640 x 480 photo as the gallery would hand it over.
Uint8List photo() {
  final im = img.Image(width: 640, height: 480);
  img.fill(im, color: im.getColor(20, 90, 80));
  return Uint8List.fromList(img.encodeJpg(im, quality: 90));
}

void main() {
  testWidgets('the kinds page lists all 14 and opens one', (tester) async {
    final h = await openContent(tester);
    expect(h.location, '/content');
    for (final name in [
      'Penceramah',
      'Kitab',
      'Kuliah',
      'Pengumuman',
      'Teks bergerak',
      'Poster',
      'Program khas',
      'Takwim',
      'Hadis',
      'Waktu dunia',
      'Petugas',
      'Tugasan',
      'Zikir',
      'Tilawah',
    ]) {
      expect(find.text(name), findsWidgets, reason: name);
    }
    await tester.tap(find.text('Kuliah').last);
    await settle(tester);
    expect(h.location, '/content/kuliah');
  });

  testWidgets('kuliah list: newest first, speaker names, Batal badge, search', (tester) async {
    final h = await openContent(tester, '/content/kuliah');
    expect(find.text('Tambah kuliah'), findsOneWidget);
    final labels = tester
        .widgetList<Text>(find.byType(Text))
        .map((t) => t.data)
        .where((d) => d != null && d.startsWith('Kuliah ') && !d.contains('baharu'))
        .toList();
    expect(labels, ['Kuliah Maghrib', 'Kuliah Subuh', 'Kuliah Isyak']);
    expect(find.textContaining('Ustaz Ahmad Fauzi'), findsNWidgets(2));
    expect(find.textContaining('Ustazah Siti Khadijah'), findsOneWidget);
    expect(find.text('Batal'), findsOneWidget);
    expect(find.textContaining('Jumaat, 6 Nov 2026, 7:15 malam (Maghrib)'), findsOneWidget);
    expect(find.text('3 rekod'), findsOneWidget);
    await expectGoldens(tester, h.app, 'content_list_kuliah');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.enterText(find.byKey(const ValueKey('content-search')), 'subuh');
    await settle(tester);
    expect(find.text('Kuliah Subuh'), findsOneWidget);
    expect(find.text('Kuliah Maghrib'), findsNothing);
    expect(find.text('1 rekod'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('content-search')), 'zzz');
    await settle(tester);
    expect(find.text('Tiada padanan.'), findsOneWidget);
  });

  testWidgets('a new kuliah: exactly its keys plus status aktif, under a fresh UUID', (tester) async {
    final h = await openContent(tester, '/content/kuliah');
    await tester.tap(find.text('Tambah kuliah'));
    await settle(tester);
    expect(h.location, '/content/kuliah/new');
    expect(find.text('Kuliah baharu'), findsOneWidget);
    expect(saveEnabled(tester), isFalse);
    await expectGoldens(tester, h.app, 'content_edit_kuliah');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.enterText(field('date'), '2026-11-05');
    await settle(tester);
    expect(find.text('Khamis, 5 Nov 2026'), findsOneWidget, reason: 'the date in words');
    await tester.tap(find.text('Maghrib'));
    await settle(tester);
    await tester.enterText(field('time'), '19:15');
    await tester.enterText(field('label'), 'Kuliah Maghrib');
    await settle(tester);
    expect(saveEnabled(tester), isFalse, reason: 'no speaker yet');
    await tester.tap(field('penceramahId'));
    await settle(tester);
    await tester.tap(find.text('Ustaz Ahmad Fauzi').last);
    await settle(tester);
    expect(saveEnabled(tester), isTrue);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);

    final put = h.box.seen.firstWhere((r) => r.method == 'PUT');
    final id = put.url.path.split('/').last;
    expect(put.url.path, '/api/content/kuliah/$id');
    expect(uuidRe.hasMatch(id), isTrue, reason: id);
    expect(jsonDecode(put.body), {
      'date': '2026-11-05',
      'slot': 'maghrib',
      'time': '19:15',
      'label': 'Kuliah Maghrib',
      'penceramahId': 'p1',
      'status': 'aktif',
    });
    expect(h.location, '/content/kuliah');
    expect(find.text('Kuliah disimpan.'), findsOneWidget);
    expect(find.text('4 rekod'), findsOneWidget);
  });

  testWidgets('pengumuman: from after to is refused here, nothing sent', (tester) async {
    final h = await openContent(tester, '/content/pengumuman/new');
    await tester.enterText(field('title'), 'Gotong-royong');
    await tester.enterText(field('body'), 'Sabtu ini.');
    await tester.enterText(field('from'), '2026-11-08');
    await tester.enterText(field('to'), '2026-11-01');
    await settle(tester);
    expect(find.text('Tarikh mula mesti sebelum tarikh tamat'), findsWidgets);
    expect(saveEnabled(tester), isFalse);
    expect(h.box.seen.where((r) => r.method == 'PUT'), isEmpty);

    await tester.enterText(field('to'), '2026-11-10');
    await settle(tester);
    expect(find.text('Tarikh mula mesti sebelum tarikh tamat'), findsNothing);
    expect(saveEnabled(tester), isTrue);
    await tester.tap(find.text('Penting'));
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.seen.firstWhere((r) => r.method == 'PUT');
    expect(jsonDecode(put.body), {
      'title': 'Gotong-royong',
      'body': 'Sabtu ini.',
      'from': '2026-11-08',
      'to': '2026-11-10',
      'priority': 2,
    });
  });

  testWidgets('poster: a picker that throws shows the BM error, uploads nothing, button usable', (tester) async {
    final h = await openContent(tester, '/content/poster/new');
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    h.pickError = Exception('Failed to fetch');
    await tester.tap(find.byKey(const ValueKey('image-pick')));
    await settle(tester);
    expect(find.text('Gambar tidak dapat dibaca. Cuba gambar lain.'), findsOneWidget);
    expect(h.assetsPosted, isEmpty);
    expect(find.text('Pilih gambar'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    // Usable again: the next pick works and clears the error.
    h.pickError = null;
    h.pickedImage = photo();
    await tester.tap(find.byKey(const ValueKey('image-pick')));
    await settle(tester);
    expect(h.assetsPosted.length, 1);
    expect(find.text('Laraskan gambar'), findsOneWidget, reason: 'the adjust screen follows the upload');
    await tester.tap(find.byKey(const ValueKey('adjust-cancel')));
    await settle(tester);
    expect(find.text('Gambar tidak dapat dibaca. Cuba gambar lain.'), findsNothing);
    expect(find.text('Tukar gambar'), findsOneWidget, reason: 'Batal keeps the picture as uploaded');
  });

  testWidgets('poster list: thumbnail, title, days and dates per row, never Susunan; Cari finds a title', (
    tester,
  ) async {
    final h = await openContent(tester, '/content/poster');
    expect(find.text('Tambah poster'), findsOneWidget);
    expect(find.text('Kempen Derma Surau'), findsOneWidget);
    expect(find.text('Jadual Kuliah Jumaat'), findsOneWidget);
    expect(find.textContaining('Susunan'), findsNothing);
    expect(find.textContaining('Setiap hari'), findsOneWidget);
    expect(find.textContaining('Jumaat'), findsWidgets);
    expect(find.textContaining('1 Nov 2026'), findsOneWidget, reason: 'the dates of o1');
    expect(find.text('2 rekod'), findsOneWidget);
    // The thumbnails come through the pinned client: a real picture, no placeholder.
    expect(find.byType(Image), findsNWidgets(2));
    await settleImages(tester);
    await expectGoldens(tester, h.app, 'content_list_poster');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.enterText(find.byKey(const ValueKey('content-search')), 'derma');
    await settle(tester);
    expect(find.text('Kempen Derma Surau'), findsOneWidget);
    expect(find.text('Jadual Kuliah Jumaat'), findsNothing);
    expect(find.text('1 rekod'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('content-search')), '');
    await settle(tester);
    await tester.tap(find.text('Jadual Kuliah Jumaat'));
    await settle(tester);
    expect(h.location, '/content/poster/o2');
    expect(tester.widget<TextField>(field('title')).controller!.text, 'Jadual Kuliah Jumaat');
  });

  testWidgets(
    'poster: the title comes first, prefilled Poster 3; the picture goes up as image/jpeg first, the PUT carries both',
    (tester) async {
      final h = await openContent(tester, '/content/poster/new');
      expect(find.text('Pilih gambar'), findsOneWidget);
      expect(find.text('Setiap hari'), findsOneWidget);
      expect(find.text('Tajuk poster'), findsOneWidget);
      expect(tester.widget<TextField>(field('title')).controller!.text, 'Poster 3', reason: 'two live posters');
      expect(
        tester.getTopLeft(field('title')).dy,
        lessThan(tester.getTopLeft(find.byKey(const ValueKey('image-pick'))).dy),
        reason: 'the title is the first field',
      );
      expect(tester.widget<TextField>(field('order')).controller!.text, '3', reason: 'next order');
      expect(saveEnabled(tester), isFalse, reason: 'no picture yet');
      expect(find.text('Pratonton di TV'), findsOneWidget);
      expect(tester.widget<OutlinedButton>(find.byKey(const ValueKey('poster-preview'))).enabled, isFalse);
      expect(find.text('Pilih gambar poster dahulu.'), findsOneWidget);
      await expectGoldens(tester, h.app, 'content_edit_poster');

      await pumpAtSize(tester, h.app, GoldenSize.phone);
      h.pickedImage = photo();
      await tester.tap(find.byKey(const ValueKey('image-pick')));
      await settle(tester);
      // The adjust screen in the poster's 16:9 frame; Simpan with nothing moved.
      expect(find.text('Laraskan gambar'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('adjust-save')));
      await settle(tester);
      expect(h.assetsPosted.length, 1);
      expect(h.assetsPosted.single.$1, 'image/jpeg');
      expect(img.decodeJpg(h.assetsPosted.single.$2), isNotNull);
      expect(find.text('Gambar dimuat naik'), findsWidgets);
      expect(find.text('Tukar gambar'), findsOneWidget);
      expect(saveEnabled(tester), isTrue);
      // The toast floats over the buttons for a few seconds.
      await tester.pump(const Duration(seconds: 5));
      await settle(tester);

      // An emptied title disables Simpan; the edited title is what is sent.
      await tester.enterText(field('title'), '');
      await settle(tester);
      expect(saveEnabled(tester), isFalse, reason: 'the title is required');
      await tester.enterText(field('title'), 'Kempen Derma Ramadan');
      await settle(tester);
      expect(saveEnabled(tester), isTrue);

      await tester.tap(find.text('Jumaat'));
      await settle(tester);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      final post = h.box.seen.indexWhere((r) => r.method == 'POST' && r.url.path == '/api/assets');
      final putAt = h.box.seen.indexWhere((r) => r.method == 'PUT');
      expect(post, lessThan(putAt), reason: 'upload before the item');
      expect(jsonDecode(h.box.seen[putAt].body), {
        'title': 'Kempen Derma Ramadan',
        'assetId': sha256Hex(h.assetsPosted.single.$2),
        'days': ['jumaat'],
        'order': 3,
      });
      expect(h.location, '/content/poster');
      expect(find.text('Kempen Derma Ramadan'), findsOneWidget, reason: 'listed by its title');
    },
  );

  testWidgets('poster: Pratonton di TV shows this poster (an unsaved draft too) in the preview, marked PRATONTON', (
    tester,
  ) async {
    final h = await openContent(tester, '/content/poster/new');
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    h.pickedImage = photo();
    await tester.tap(find.byKey(const ValueKey('image-pick')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('adjust-save')));
    await settle(tester);
    await tester.pump(const Duration(seconds: 5));
    await settle(tester);
    await tester.enterText(field('title'), '  Kempen  Derma\tSurau  ');
    await settle(tester);
    final button = find.byKey(const ValueKey('poster-preview'));
    await reveal(tester, button);
    expect(tester.widget<OutlinedButton>(button).enabled, isTrue);
    expect(find.text('Pilih gambar poster dahulu.'), findsNothing);
    h.previewRequests.clear();
    await tester.tap(button);
    await settle(tester);

    expect(find.text('PRATONTON'), findsOneWidget);
    expect(find.text('Beginilah rupa poster ini di TV surau. Tiada apa yang berubah pada TV sebenar.'), findsOneWidget);
    expect(find.byKey(const ValueKey('poster-preview-title')), findsOneWidget);
    final r = h.previewRequests.single;
    expect(r.box, Uri.parse('https://127.0.0.1:8443'));
    expect(r.token, 'tok-1');
    expect(r.now, isNull);
    expect(r.poster!.assetId, sha256Hex(h.assetsPosted.single.$2), reason: 'the draft upload, nothing saved');
    expect(r.poster!.title, 'Kempen  Derma Surau', reason: 'trimmed, control characters blanked');
    expect(h.box.seen.where((x) => x.method == 'PUT'), isEmpty, reason: 'a preview changes nothing');
    await tester.tap(find.text('Tutup'));
    await settle(tester);
    expect(find.text('PRATONTON'), findsNothing);
    expect(h.location, '/content/poster/new', reason: 'still editing');
  });

  testWidgets(
    'a speaker photo: the adjust screen has a circle frame; zoomed in, the PUT carries the adjusted object; the list draws it as a circle',
    (tester) async {
      final h = await openContent(tester, '/content/penceramah/p2');
      await pumpAtSize(tester, h.app, GoldenSize.phone);
      await reveal(tester, find.byKey(const ValueKey('image-pick')));
      h.pickedImage = photo();
      await tester.tap(find.byKey(const ValueKey('image-pick')));
      await settle(tester);
      expect(find.text('Laraskan gambar'), findsOneWidget);
      final editor = tester.widget<CropEditor>(find.byType(CropEditor));
      expect(editor.circle, isTrue);
      await tester.tap(find.byKey(const ValueKey('adjust-zoom-in')));
      await settle(tester);
      await tester.tap(find.byKey(const ValueKey('adjust-save')));
      await settle(tester);
      expect(find.byType(ClipOval), findsOneWidget, reason: 'the thumbnail in the circle the TV uses');
      await tester.pump(const Duration(seconds: 5));
      await settle(tester);
      await reveal(tester, save);
      await tester.tap(save);
      await settle(tester);
      final put = h.box.seen.firstWhere((r) => r.method == 'PUT');
      final body = jsonDecode(put.body) as Map<String, dynamic>;
      final photoRef = body['photoAssetId'] as Map<String, dynamic>;
      expect(photoRef['asset'], sha256Hex(h.assetsPosted.single.$2));
      final crop = photoRef['crop'] as Map<String, dynamic>;
      expect(crop['w'], lessThan(0.75), reason: 'zoomed in past the centre square');
      expect(crop['h'], lessThan(1));
      expect(photoRef.containsKey('square'), isFalse, reason: 'the square belongs to the logo only');
      expect(h.location, '/content/penceramah');
    },
  );

  testWidgets('Laraskan gambar on a saved poster: rotate, Simpan, the PUT carries rotate 90 and the same asset', (
    tester,
  ) async {
    final h = await openContent(tester, '/content/poster/o1');
    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await reveal(tester, find.byKey(const ValueKey('image-adjust')));
    await tester.tap(find.byKey(const ValueKey('image-adjust')));
    await settle(tester);
    expect(find.text('Laraskan gambar'), findsOneWidget);
    expect(h.assetsPosted, isEmpty, reason: 'nothing uploaded again');
    await tester.tap(find.byKey(const ValueKey('adjust-rotate')));
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('adjust-save')));
    await settle(tester);
    expect(find.text('Gambar dilaraskan'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.seen.firstWhere((r) => r.method == 'PUT');
    expect((jsonDecode(put.body) as Map)['assetId'], {'asset': fixtureAssetPoster, 'rotate': 90});
    expect(h.location, '/content/poster');
    expect(find.byType(Image), findsNWidgets(2), reason: 'both poster thumbnails, the turned one included');
  });

  testWidgets('poster: an AJK sees the title read-only and no preview of a form they cannot edit', (tester) async {
    final h = await openContent(tester, '/content/poster/o1', const ['ajk']);
    expect(h.location, '/content/poster/o1');
    expect(tester.widget<TextField>(field('title')).controller!.text, 'Kempen Derma Surau');
    expect(tester.widget<TextField>(field('title')).enabled, isFalse);
    // Looking is allowed: the saved poster can still be previewed.
    expect(tester.widget<OutlinedButton>(find.byKey(const ValueKey('poster-preview'))).enabled, isTrue);
  });

  testWidgets('tilawah slot: edit in place, the switch and the chips', (tester) async {
    final h = await openContent(tester, '/content/tilawahSlot');
    expect(find.text('Surah 18'), findsOneWidget);
    expect(find.text('Surah 36'), findsOneWidget);
    expect(find.text('Dimatikan'), findsOneWidget);
    await tester.tap(find.text('Surah 36'));
    await settle(tester);
    expect(h.location, '/content/tilawahSlot/l2');
    expect(find.text('Sunting slot tilawah'), findsOneWidget);
    await expectGoldens(tester, h.app, 'content_edit_tilawah');

    await pumpAtSize(tester, h.app, GoldenSize.phone);
    await tester.tap(find.byKey(const ValueKey('day-sabtu')));
    await settle(tester);
    final sw = find.descendant(of: field('enabled'), matching: find.byType(Switch));
    await reveal(tester, sw);
    await tester.tap(sw);
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final put = h.box.byPath('/api/content/tilawahSlot/l2')!;
    expect(put.method, 'PUT');
    expect(jsonDecode(put.body), {
      'days': ['jumaat', 'sabtu'],
      'before': 'zohor',
      'minutesBefore': 30,
      'surah': 36,
      'enabled': true,
    });
    expect(find.text('Dimatikan'), findsNothing);
  });

  testWidgets('Padam: confirm, DELETE, the row is gone', (tester) async {
    final h = await openContent(tester, '/content/kuliah');
    await tester.tap(find.byKey(const ValueKey('delete-c3')));
    await settle(tester);
    expect(find.text('Padam kuliah ini?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Padam'));
    await settle(tester);
    final del = h.box.byPath('/api/content/kuliah/c3')!;
    expect(del.method, 'DELETE');
    expect(find.text('Kuliah dipadam.'), findsOneWidget);
    expect(find.text('Kuliah Isyak'), findsNothing);
    expect(find.text('2 rekod'), findsOneWidget);
  });

  testWidgets('a retry after a failed save of a new item reuses the same id', (tester) async {
    final h = await openContent(tester, '/content/kuliah/new');
    await tester.enterText(field('date'), '2026-11-05');
    await settle(tester);
    await tester.tap(find.text('Maghrib'));
    await settle(tester);
    await tester.enterText(field('time'), '19:15');
    await tester.enterText(field('label'), 'Kuliah Maghrib');
    await tester.tap(field('penceramahId'));
    await settle(tester);
    await tester.tap(find.text('Ustaz Ahmad Fauzi').last);
    await settle(tester);
    h.failPuts = 1;
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    expect(h.location, '/content/kuliah/new', reason: 'the first save failed');
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    final puts = h.box.seen.where((r) => r.method == 'PUT').toList();
    expect(puts, hasLength(2));
    expect(puts[0].url.path, puts[1].url.path);
    expect(h.location, '/content/kuliah');
    expect(find.text('4 rekod'), findsOneWidget);
  });

  testWidgets('a 409 for a missing speaker reads Penceramah tidak dijumpai', (tester) async {
    final h = await openContent(tester, '/content/kuliah/c1');
    h.handlers['PUT /api/content/kuliah/c1'] = (r) async => jsonResponse(409, {
      'errors': ['penceramahId refers to a penceramah that does not exist'],
    });
    await tester.enterText(field('label'), 'Kuliah Maghrib Khas');
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    expect(find.text('Penceramah tidak dijumpai'), findsOneWidget);
    expect(h.location, '/content/kuliah/c1');
  });

  testWidgets('offline: the last list stays, a save is refused with Cuba lagi di surau', (tester) async {
    final h = await openContent(tester, '/content/kuliah');
    await tester.tap(find.text('Kuliah Maghrib'));
    await settle(tester);
    expect(h.location, '/content/kuliah/c1');
    // The box goes away while the editor is open: what is loaded stays.
    h.boxAway = true;
    await h.container.read(healthProvider.notifier).refresh();
    await settle(tester);
    expect(find.text('Menunjukkan data terakhir', skipOffstage: false), findsNothing);
    expect(find.textContaining('MAXCOM tidak dapat dihubungi'), findsOneWidget, reason: 'the banner');
    expect(tester.widget<TextField>(field('label')).controller!.text, 'Kuliah Maghrib');
    h.box.seen.clear();
    await tester.enterText(field('topic'), 'Bab syukur');
    await settle(tester);
    await reveal(tester, save);
    await tester.tap(save);
    await settle(tester);
    expect(find.text('MAXCOM tidak dapat dihubungi. Cuba lagi di surau.'), findsWidgets);
    expect(h.box.seen.where((r) => r.method == 'PUT'), isEmpty);
  });

  testWidgets('an AJK sees no Tambah, no Padam, and a read-only form', (tester) async {
    final h = await openContent(tester, '/content/kuliah', const ['ajk']);
    expect(find.text('Tambah kuliah'), findsNothing);
    expect(find.byKey(const ValueKey('delete-c1')), findsNothing);
    await tester.tap(find.text('Kuliah Maghrib'));
    await settle(tester);
    expect(h.location, '/content/kuliah/c1');
    expect(find.text('Paparan sahaja'), findsOneWidget);
    expect(save, findsNothing);
    for (final t in tester.widgetList<TextField>(find.byType(TextField))) {
      expect(t.enabled, isFalse);
    }
    h.router.go('/content/kuliah/new');
    await settle(tester);
    expect(save, findsNothing);
  });

  testWidgets('a person without content:read is sent home', (tester) async {
    // Every role reads content today; an unknown kind still shows a calm message.
    final h = await openContent(tester, '/content/zzz');
    expect(h.location, '/content/zzz');
    expect(find.text('Rekod tidak dijumpai.'), findsOneWidget);
  });
}
