// One joined recording per live (2026.11.14, contract C): the Android joiner (what it asks the phone and how it reads
// the answer), the web flow (pieces up, join, save, then both sides delete) and the one question after a verified
// upload (asked once; nothing deleted without the answer).

import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:surau_app/box/box_client.dart' show BoxError;
import 'package:surau_app/features/live/live_screen.dart' show recordingNotesFor;
import 'package:surau_app/features/live/recordings_store.dart';
import 'package:surau_app/features/shell/box_gateway.dart';
import 'package:surau_app/features/shell/read_cache.dart';
import 'package:surau_app/upload/recording_join.dart';

import '../features/fakes.dart' show FakeBox, fixedNow, jsonResponse;

class _Reach implements ReachSink {
  @override
  BoxReach reach = BoxReach.unknown;
  @override
  void markUp(DateTime at) {}
  @override
  void markDown(DateTime at) {}
}

const _p1 = 'MAXCOM-2026-11-21-1930-subuh-01.mp4';
const _p2 = 'MAXCOM-2026-11-21-1930-subuh-02.mp4';
const _p3 = 'MAXCOM-2026-11-21-1930-subuh-03.mp4';

void main() {
  group('Android joiner', () {
    late List<MethodCall> calls;
    late Map<String, dynamic>? answer;
    late AndroidRecordingJoiner joiner;

    setUp(() {
      calls = [];
      answer = null;
      const ch = MethodChannel('test/upload');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, (c) async {
        calls.add(c);
        return answer;
      });
      joiner = AndroidRecordingJoiner(channel: ch);
    });

    test('three pieces are sent by name, and the joined file comes back', () async {
      answer = {'merged': true, 'name': 'MAXCOM-2026-11-21-1930-subuh-all.mp4', 'bytes': 3000, 'durationMs': 180000, 'pieces': 3, 'leftover': 0};
      final o = await joiner.join([_p1, _p2, _p3]);
      expect(o.joined, isTrue);
      expect(o.name, 'MAXCOM-2026-11-21-1930-subuh-all.mp4');
      expect(o.pieces, 3);
      expect(calls.single.method, 'mergeRecordings');
      expect((calls.single.arguments as Map)['names'], [_p1, _p2, _p3]);
    });

    test('one piece or none is left as it is, nothing asked of the phone', () async {
      expect((await joiner.join([_p1])).joined, isFalse);
      expect((await joiner.join([_p1])).name, _p1);
      expect((await joiner.join(const [])).failed, isFalse);
      expect(calls, isEmpty);
    });

    test('names that are not the app\'s own recordings never reach the phone', () async {
      final o = await joiner.join(['../x.mp4', 'photo.jpg', _p1]);
      expect(o.joined, isFalse);
      expect(calls, isEmpty);
    });

    test('a refusal keeps every piece and carries its reason code', () async {
      answer = {'merged': false, 'error': 'length_mismatch'};
      final o = await joiner.join([_p1, _p2]);
      expect(o.failed, isTrue);
      expect(o.error, 'length_mismatch');
      expect(o.joined, isFalse);
    });

    test('an answer with a name that is not a recording name is not trusted', () async {
      answer = {'merged': true, 'name': '../../evil.mp4'};
      final o = await joiner.join([_p1, _p2]);
      expect(o.joined, isFalse);
    });

    test('a missing plugin or a platform error is a failed join, never a crash', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('test/upload'), null);
      expect((await joiner.join([_p1, _p2])).error, 'join_failed');
    });
  });

  group('Web join', () {
    late MemoryRecordingsStore store;
    late List<http.Request> seen;
    late Map<String, http.Response Function(http.Request)> routes;
    late List<(String, int)> saved;
    late WebRecordingJoin join;
    late BoxGateway gateway;
    bool saveThrows = false;

    Future<void> piece(int i, List<int> bytes, {String mime = 'video/mp4'}) async {
      await store.appendPart(sessionId: 's1', index: i, mime: mime, label: 'Kuliah Subuh', chunk: Uint8List.fromList(bytes), size: bytes.length);
      await store.finishSegment('s1', i);
    }

    setUp(() async {
      store = MemoryRecordingsStore();
      seen = [];
      saved = [];
      saveThrows = false;
      routes = {
        'POST /api/live/recordings/L1/pieces/1': (r) => http.Response('{}', 200),
        'POST /api/live/recordings/L1/pieces/2': (r) => http.Response('{}', 200),
        'POST /api/live/recordings/L1/join': (r) => http.Response(jsonEncode({'bytes': 9, 'file': 'x.mp4'}), 200, headers: {'content-type': 'application/json'}),
        'GET /api/live/recordings/L1/file': (r) => http.Response.bytes([1, 2, 3, 4, 5, 6, 7, 8, 9], 200, headers: {'content-type': 'video/mp4'}),
        'DELETE /api/live/recordings/L1': (r) => http.Response('', 204),
      };
      final box = FakeBox((r) async {
        final h = routes['${r.method} ${r.url.path}'];
        return h == null ? jsonResponse(404, {'errors': ['x']}) : h(r);
      });
      seen = box.seen;
      gateway = BoxGateway(
        client: box.client(Uri.parse('https://box.test:8443')),
        token: 't',
        cache: ReadCache(store: null, boxId: 'b'),
        reach: _Reach(),
        now: fixedNow,
        onSessionExpired: () {},
      );
      join = WebRecordingJoin(
        store: store,
        gateway: gateway,
        saveBytes: (name, bytes, mime) async {
          if (saveThrows) throw StateError('blocked');
          saved.add((name, bytes.length));
        },
      );
      await piece(1, [1, 2, 3, 4]);
      await piece(2, [5, 6, 7, 8, 9]);
    });

    test('the pieces go up in order and the box is asked to join; every piece stays in the browser', () async {
      final o = await join.upload(liveId: 'L1', sessionId: 's1');
      expect(o.joined, isTrue);
      expect(o.pieces, 2);
      expect(o.name, matches(RegExp(r'^MAXCOM-\d{4}-\d{2}-\d{2}-Kuliah-Subuh\.mp4$')));
      expect([for (final r in seen) '${r.method} ${r.url.path}'], [
        'POST /api/live/recordings/L1/pieces/1',
        'POST /api/live/recordings/L1/pieces/2',
        'POST /api/live/recordings/L1/join',
      ]);
      expect(seen[0].bodyBytes, [1, 2, 3, 4]);
      expect(seen[1].bodyBytes, [5, 6, 7, 8, 9]);
      expect(seen[0].headers['content-type'], 'video/mp4');
      expect(jsonDecode(seen[2].body), {'count': 2});
      expect((await store.forSession('s1')), hasLength(2));
    });

    test('WebM pieces are sent as WebM and the joined file is a .webm', () async {
      final s2 = MemoryRecordingsStore();
      await s2.appendPart(sessionId: 'w', index: 1, mime: 'video/webm;codecs=vp9', label: 'x', chunk: Uint8List.fromList([1]), size: 1);
      await s2.finishSegment('w', 1);
      await s2.appendPart(sessionId: 'w', index: 2, mime: 'video/webm;codecs=vp9', label: 'x', chunk: Uint8List.fromList([2]), size: 1);
      await s2.finishSegment('w', 2);
      final j = WebRecordingJoin(store: s2, gateway: gateway, saveBytes: (a, b, c) async {});
      final o = await j.upload(liveId: 'L1', sessionId: 'w');
      expect(o.name, endsWith('.webm'));
      expect(seen.first.headers['content-type'], 'video/webm');
    });

    test('one piece is left as it is: nothing is uploaded', () async {
      final s2 = MemoryRecordingsStore();
      await s2.appendPart(sessionId: 'one', index: 1, mime: 'video/mp4', label: 'x', chunk: Uint8List.fromList([1]), size: 1);
      await s2.finishSegment('one', 1);
      final j = WebRecordingJoin(store: s2, gateway: gateway, saveBytes: (a, b, c) async {});
      final o = await j.upload(liveId: 'L1', sessionId: 'one');
      expect(o.joined, isFalse);
      expect(o.failed, isFalse);
      expect(seen, isEmpty);
    });

    test('a refusal from the box (no room) keeps every piece and gives its code', () async {
      routes['POST /api/live/recordings/L1/pieces/2'] = (r) => jsonResponse(413, {'errors': ['x'], 'code': 'no_space'});
      final o = await join.upload(liveId: 'L1', sessionId: 's1');
      expect(o.failed, isTrue);
      expect(o.error, 'no_space');
      expect(await store.forSession('s1'), hasLength(2));
    });

    test('a refused join (mixed types) keeps every piece', () async {
      routes['POST /api/live/recordings/L1/join'] = (r) => jsonResponse(409, {'errors': ['x'], 'code': 'mixed_types'});
      final o = await join.upload(liveId: 'L1', sessionId: 's1');
      expect(o.error, 'mixed_types');
      expect(await store.forSession('s1'), hasLength(2));
    });

    test('a bad live id is refused before any request', () async {
      final o = await join.upload(liveId: '../x', sessionId: 's1');
      expect(o.error, 'unknown_live');
      expect(seen, isEmpty);
    });

    test('[AS3] one tap hands the file to the browser and deletes NOTHING: a click is not proof it was saved', () async {
      final r = await join.saveJoined(liveId: 'L1', sessionId: 's1');
      expect(r, JoinSave.handedOver);
      expect(saved.single.$2, 9);
      expect(saved.single.$1, matches(RegExp(r'^MAXCOM-.*Kuliah-Subuh\.mp4$')));
      expect([for (final r in seen) '${r.method} ${r.url.path}'], ['GET /api/live/recordings/L1/file']);
      expect(await store.forSession('s1'), hasLength(2), reason: 'both local pieces kept');
    });

    test('[AS3] only a Yes (confirmSaved) removes the local pieces and asks the box to drop its copy', () async {
      await join.saveJoined(liveId: 'L1', sessionId: 's1');
      await join.confirmSaved(liveId: 'L1', sessionId: 's1');
      expect([for (final r in seen) '${r.method} ${r.url.path}'], ['GET /api/live/recordings/L1/file', 'DELETE /api/live/recordings/L1']);
      expect(await store.forSession('s1'), isEmpty);
    });

    test('[AS3] a Yes still clears the local pieces when the box copy cannot be deleted (it expires in 7 days)', () async {
      routes['DELETE /api/live/recordings/L1'] = (r) => jsonResponse(500, {'errors': ['x']});
      await join.confirmSaved(liveId: 'L1', sessionId: 's1');
      expect(await store.forSession('s1'), isEmpty);
    });

    test('when the browser cannot save, nothing is deleted anywhere', () async {
      saveThrows = true;
      final r = await join.saveJoined(liveId: 'L1', sessionId: 's1');
      expect(r, JoinSave.failed);
      expect(seen.where((r) => r.method == 'DELETE'), isEmpty);
      expect(await store.forSession('s1'), hasLength(2));
    });

    test('when the joined file cannot be had, nothing is deleted', () async {
      routes['GET /api/live/recordings/L1/file'] = (r) => jsonResponse(404, {'errors': ['x'], 'code': 'not_ready'});
      final r = await join.saveJoined(liveId: 'L1', sessionId: 's1');
      expect(r, JoinSave.failed);
      expect(await store.forSession('s1'), hasLength(2));
      expect(saved, isEmpty);
    });

    test('[box_away] a box that does not answer is box_away: be on the surau Wi-Fi; every piece is kept', () async {
      routes['POST /api/live/recordings/L1/pieces/1'] = (r) => throw http.ClientException('no route');
      final o = await join.upload(liveId: 'L1', sessionId: 's1');
      expect(o.error, 'box_away');
      expect(await store.forSession('s1'), hasLength(2));
      expect(WebRecordingJoin.failureCode(const LiveOnly('/api/live/recordings/L1/join')), 'box_away');
      expect(WebRecordingJoin.failureCode(const OfflineWriteRefused()), 'box_away');
    });

    test('[already_joined] a 409 already_joined on a piece is success: straight to the download, no join call', () async {
      routes['POST /api/live/recordings/L1/pieces/1'] = (r) => jsonResponse(409, {'errors': ['x'], 'code': 'already_joined'});
      final o = await join.upload(liveId: 'L1', sessionId: 's1');
      expect(o.joined, isTrue);
      expect(o.failed, isFalse);
      expect(seen.where((r) => r.url.path.endsWith('/join')), isEmpty);
      expect(await join.saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.handedOver);
    });

    test('[bad_piece] a piece that is not a real mp4/webm gives bad_piece and keeps every piece', () async {
      routes['POST /api/live/recordings/L1/pieces/2'] = (r) => jsonResponse(400, {'errors': ['x'], 'code': 'bad_piece'});
      final o = await join.upload(liveId: 'L1', sessionId: 's1');
      expect(o.error, 'bad_piece');
      expect(await store.forSession('s1'), hasLength(2));
      expect(recordingNotesFor(o, null, web: true), ['badPiece']);
    });

    test('[no_space] the box refusing for space gets its own note, not the generic join failure', () {
      expect(recordingNotesFor(const JoinOutcome.failed('no_space'), true, web: true), ['noSpace']);
      expect(recordingNotesFor(const JoinOutcome.failed('no_space'), null, web: false), ['noSpace']);
      // success path stays as it was
      expect(recordingNotesFor(const JoinOutcome.joined(name: 'x.mp4'), null, web: true), ['joined']);
    });

    test('[busy] a 409 busy is tried again after a short wait, then goes through', () async {
      var n = 0;
      routes['POST /api/live/recordings/L1/pieces/1'] = (r) => ++n < 3 ? jsonResponse(409, {'errors': ['x'], 'code': 'busy'}) : http.Response('{}', 200);
      final j = WebRecordingJoin(store: store, gateway: gateway, saveBytes: (a, b, c) async {}, busyWait: Duration.zero);
      final o = await j.upload(liveId: 'L1', sessionId: 's1');
      expect(o.joined, isTrue);
      expect(n, 3);
    });

    test('[busy] a box that stays busy gives up after the tries and keeps every piece', () async {
      routes['POST /api/live/recordings/L1/pieces/1'] = (r) => jsonResponse(409, {'errors': ['x'], 'code': 'busy'});
      final j = WebRecordingJoin(store: store, gateway: gateway, saveBytes: (a, b, c) async {}, busyWait: Duration.zero, busyTries: 3);
      final o = await j.upload(liveId: 'L1', sessionId: 's1');
      expect(o.error, 'busy');
      expect(seen.where((r) => r.url.path.endsWith('/pieces/1')), hasLength(3));
    });

    test('[AQ3] pieces go up as the store blob and the joined file comes down as one object, not bytes through the join', () async {
      final up = <(String, Object)>[];
      final fake = _FakeTransfer(up);
      final j = WebRecordingJoin(store: store, gateway: gateway, saveBytes: (a, b, c) async => fail('bytes path used'), transfer: fake);
      final o = await j.upload(liveId: 'L1', sessionId: 's1');
      expect(o.joined, isTrue);
      expect(up.map((e) => e.$1), ['/api/live/recordings/L1/pieces/1', '/api/live/recordings/L1/pieces/2']);
      expect(await j.saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.handedOver);
      expect(fake.saved, ['blob-file']);
      // a browser that cannot hold it: a clear result, nothing deleted
      fake.tooBig = true;
      expect(await j.saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.tooBig);
      expect(await store.forSession('s1'), hasLength(2));
      expect(seen.where((r) => r.method == 'DELETE'), isEmpty);
    });
  });

  group('[O16] saving through a download link', () {
    late MemoryRecordingsStore store;
    late List<http.Request> seen;
    late Map<String, http.Response Function(http.Request)> routes;
    late BoxGateway gateway;
    final token = 'ab' * 32;

    setUp(() async {
      store = MemoryRecordingsStore();
      for (var i = 1; i <= 2; i++) {
        await store.appendPart(sessionId: 's1', index: i, mime: 'video/mp4', label: 'Kuliah Subuh', chunk: Uint8List.fromList([i, i]), size: 2);
        await store.finishSegment('s1', i);
      }
      routes = {
        'GET /api/live/recordings/L1/file': (r) => http.Response.bytes([1, 2, 3], 200, headers: {'content-type': 'video/mp4'}),
        'DELETE /api/live/recordings/L1': (r) => http.Response('', 204),
      };
      final box = FakeBox((r) async {
        final h = routes['${r.method} ${r.url.path}'];
        return h == null ? jsonResponse(404, {'errors': ['x']}) : h(r);
      });
      seen = box.seen;
      gateway = BoxGateway(
        client: box.client(Uri.parse('https://box.test:8443')),
        token: 't',
        cache: ReadCache(store: null, boxId: 'b'),
        reach: _Reach(),
        now: fixedNow,
        onSessionExpired: () {},
      );
    });

    WebRecordingJoin joinWith(RecordingTransfer t) =>
        WebRecordingJoin(store: store, gateway: gateway, saveBytes: (a, b, c) async => fail('bytes path used'), transfer: t);

    test('the one tap opens the box link as a download and reads nothing into memory; nothing is deleted', () async {
      final fake = _FakeTransfer([])..link = Uri.parse('https://box.test:8443/api/live/recordings/dl/$token');
      final r = await joinWith(fake).saveJoined(liveId: 'L1', sessionId: 's1');
      expect(r, JoinSave.handedOver);
      expect(fake.linkAsked, ['/api/live/recordings/L1/link']);
      expect(fake.opened.single.$1.path, '/api/live/recordings/dl/$token');
      expect(fake.opened.single.$2, matches(RegExp(r'^MAXCOM-\d{4}-\d{2}-\d{2}-Kuliah-Subuh\.mp4$')));
      expect(fake.saved, isEmpty, reason: 'the Blob path was not used');
      expect(seen.where((r) => r.method == 'DELETE'), isEmpty);
      expect(await store.forSession('s1'), hasLength(2));
    });

    test('a Yes after the link download still removes the local pieces and the box copy (the confirm flow is unchanged)', () async {
      final fake = _FakeTransfer([])..link = Uri.parse('https://box.test:8443/api/live/recordings/dl/$token');
      final j = joinWith(fake);
      await j.saveJoined(liveId: 'L1', sessionId: 's1');
      await j.confirmSaved(liveId: 'L1', sessionId: 's1');
      expect([for (final r in seen) '${r.method} ${r.url.path}'], ['DELETE /api/live/recordings/L1']);
      expect(await store.forSession('s1'), isEmpty);
    });

    test('F18: a link that answers is opened; a link that does not answer falls back to the Blob path', () async {
      final good = _ProbeTransfer([])..link = Uri.parse('https://box.test:8443/api/live/recordings/dl/$token');
      expect(await joinWith(good).saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.handedOver);
      expect(good.probed, [good.link]);
      expect(good.opened, hasLength(1));
      expect(good.saved, isEmpty);

      final bad = _ProbeTransfer([])
        ..link = Uri.parse('https://box.test:8443/api/live/recordings/dl/$token')
        ..probeOk = false;
      expect(await joinWith(bad).saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.handedOver);
      expect(bad.opened, isEmpty, reason: 'the browser is not sent to a link that fails');
      expect(bad.saved, ['blob-file']);
      expect(await store.forSession('s1'), hasLength(2));
    });

    test('an older box (no link route) is served by the Blob path as before', () async {
      final fake = _FakeTransfer([]); // link stays null
      final r = await joinWith(fake).saveJoined(liveId: 'L1', sessionId: 's1');
      expect(r, JoinSave.handedOver);
      expect(fake.opened, isEmpty);
      expect(fake.saved, ['blob-file']);
    });

    test('a refusal with a code is a failure and keeps everything; so is a link that will not open', () async {
      final fake = _FakeTransfer([])..linkError = const BoxError(404, 'x', code: 'not_ready');
      final j = joinWith(fake);
      expect(await j.saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.failed);
      expect(fake.saved, isEmpty, reason: 'no silent fall back to the Blob path on a real refusal');
      fake.linkError = null;
      fake.link = Uri.parse('https://box.test:8443/api/live/recordings/dl/$token');
      fake.openError = StateError('blocked');
      expect(await j.saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.failed);
      expect(await store.forSession('s1'), hasLength(2));
      expect(seen.where((r) => r.method == 'DELETE'), isEmpty);
    });

    test('over the gateway: the link answer is opened, a bare 404 means an older box and the bytes path runs', () async {
      final opened = <Uri>[];
      routes['POST /api/live/recordings/L1/link'] = (r) => http.Response(
        jsonEncode({'url': '/api/live/recordings/dl/$token', 'expiresAt': '2026-11-24T10:15:00.000Z'}),
        200,
        headers: {'content-type': 'application/json'},
      );
      final saved = <String>[];
      final t = BytesRecordingTransfer(
        gateway: gateway,
        saveBytes: (n, b, m) async => saved.add(n),
        box: Uri.parse('https://box.test:8443'),
        open: (u, n) async => opened.add(u),
      );
      final j = WebRecordingJoin(store: store, gateway: gateway, saveBytes: (a, b, c) async {}, transfer: t);
      expect(await j.saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.handedOver);
      expect(opened.single.toString(), 'https://box.test:8443/api/live/recordings/dl/$token');
      expect(saved, isEmpty);
      routes.remove('POST /api/live/recordings/L1/link');
      expect(await j.saveJoined(liveId: 'L1', sessionId: 's1'), JoinSave.handedOver);
      expect(opened, hasLength(1));
      expect(saved, hasLength(1), reason: 'the 404 without a code sent it down the bytes path');
    });

    test('linkFromAnswer takes only the box own download route: another host, a wrong path or a short token is refused', () {
      final box = Uri.parse('https://box.test:8443/app/');
      expect(linkFromAnswer(box, '/api/live/recordings/dl/$token').toString(), 'https://box.test:8443/api/live/recordings/dl/$token');
      expect(linkFromAnswer(box, 'https://evil.test/api/live/recordings/dl/$token'), isNull);
      expect(linkFromAnswer(box, 'http://box.test:8443/api/live/recordings/dl/$token'), isNull);
      expect(linkFromAnswer(box, '/api/live/recordings/L1/file'), isNull);
      expect(linkFromAnswer(box, '/api/live/recordings/dl/abc'), isNull);
      expect(linkFromAnswer(box, null), isNull);
      expect(linkFromAnswer(box, 42), isNull);
    });

    test('isMissingLinkRoute is true only for a bare 404, 403 or 405', () {
      expect(isMissingLinkRoute(const BoxError(404, 'x')), isTrue);
      expect(isMissingLinkRoute(const BoxError(403, 'x')), isTrue);
      expect(isMissingLinkRoute(const BoxError(404, 'x', code: 'not_ready')), isFalse);
      expect(isMissingLinkRoute(const BoxError(403, 'x', code: 'not_owner')), isFalse);
      expect(isMissingLinkRoute(const BoxError(500, 'x')), isFalse);
      // Q2: a 403 lan_only means "no link here, use the Blob path"
      expect(isMissingLinkRoute(const BoxError(403, 'x', code: 'lan_only')), isTrue);
      expect(isMissingLinkRoute(const BoxError(404, 'x', code: 'lan_only')), isFalse);
    });
  });

  group('summary notes', () {
    const joinedOut = JoinOutcome.joined(name: 'a-all.mp4');

    test('[AQ2] a failed join says nothing about being asked later or YouTube not confirmed', () {
      const failed = JoinOutcome.failed('join_failed');
      expect(recordingNotesFor(failed, true, web: false), ['joinFailed']);
      expect(recordingNotesFor(failed, false, web: false), ['joinFailed']);
      expect(recordingNotesFor(const JoinOutcome.failed('box_away'), true, web: true), ['joinNeedsWifi']);
    });

    test('[AQ2] a good join still says it, and the question or the unconfirmed note follows', () {
      expect(recordingNotesFor(joinedOut, true, web: false), ['joined', 'askLater']);
      expect(recordingNotesFor(joinedOut, false, web: false), ['joined', 'keptUnconfirmed']);
      expect(recordingNotesFor(joinedOut, true, web: true), ['joined']);
    });

    test('[AQ1] a joined recording whose name could not be noted still says it was joined', () {
      expect(recordingNotesFor(joinedOut.untracked(), null, web: false), ['joined', 'joinedUntracked']);
    });
  });

  group('Android joiner, more', () {
    test('[AQ7] the pieces the phone could not remove come back by name', () async {
      const ch = MethodChannel('test/upload2');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, (c) async => {
        'merged': true, 'name': 'MAXCOM-2026-11-21-1930-subuh-all.mp4', 'pieces': 2, 'leftover': 1,
        'leftoverNames': [_p2, '../evil.mp4', 'MAXCOM-2099-01-01-0000-x-01.mp4'],
      });
      final o = await AndroidRecordingJoiner(channel: ch).join([_p1, _p2]);
      expect(o.joined, isTrue);
      expect(o.leftoverNames, [_p2], reason: 'only names that were asked for and are recording names');
    });

    test('[AQ8] the same join asked twice while it runs is one call to the phone; another set is not shared', () async {
      const ch = MethodChannel('test/upload3');
      var calls = 0;
      final gate = Completer<void>();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, (c) async {
        calls++;
        await gate.future;
        return {'merged': true, 'name': 'MAXCOM-2026-11-21-1930-subuh-all.mp4', 'pieces': 2};
      });
      final j = AndroidRecordingJoiner(channel: ch);
      final a = j.join([_p1, _p2]);
      final b = j.join([_p1, _p2]);
      gate.complete();
      expect((await a).joined, isTrue);
      expect((await b).joined, isTrue);
      expect(calls, 1);
      // after it ended, a new join is a new call
      final c = await j.join([_p1, _p2]);
      expect(c.joined, isTrue);
      expect(calls, 2);
    });
  });
}

class _ProbeTransfer extends _FakeTransfer implements RecordingLinkProbe {
  _ProbeTransfer(super.up);
  bool probeOk = true;
  final List<Uri> probed = [];

  @override
  Future<bool> probeLink(Uri url) async {
    probed.add(url);
    return probeOk;
  }
}

class _FakeTransfer implements RecordingTransfer {
  _FakeTransfer(this.up);
  final List<(String, Object)> up;
  final List<String> saved = [];
  bool tooBig = false;

  @override
  Future<void> uploadPiece(String path, Object blob, String mime) async => up.add((path, blob));

  @override
  Future<Object> fetchFile(String path) async {
    if (tooBig) throw const RecordingTooBig();
    return 'blob-file';
  }

  @override
  Future<void> saveFile(String fileName, Object file, String mime) async => saved.add(file as String);
  /// What the box answers to the link request: a link, null (no such route), or a thrown error.
  Uri? link;
  Object? linkError;
  Object? openError;
  final List<(Uri, String)> opened = [];
  final List<String> linkAsked = [];

  @override
  Future<Uri?> requestLink(String path) async {
    linkAsked.add(path);
    final e = linkError;
    if (e != null) throw e;
    return link;
  }

  @override
  Future<void> openLink(Uri url, String fileName) async {
    final e = openError;
    if (e != null) throw e;
    opened.add((url, fileName));
  }
}

