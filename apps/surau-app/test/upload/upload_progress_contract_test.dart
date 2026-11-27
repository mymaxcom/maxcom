// The progress call of the upload API: the box answers 200 with `{ok}` and the app stops only on `ok: false`.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/upload/upload_api.dart';

import '../features/fakes.dart';

void main() {
  HttpUploadApi apiAnswering(Map<String, Object?> body) {
    final fake = FakeBox((r) async => jsonResponse(200, body));
    return HttpUploadApi(client: fake.client(Uri.parse('https://10.168.50.10:8443')), token: 't');
  }

  test('progress is true while the box answers ok: true', () async {
    expect(await apiAnswering({'ok': true}).progress('u1'), isTrue);
  });

  test('progress is false when the box answers ok: false (claim taken over)', () async {
    expect(await apiAnswering({'ok': false}).progress('u1'), isFalse);
  });

  test('an answer without a body (older box) counts as still alive', () async {
    expect(await apiAnswering(<String, Object?>{}).progress('u1'), isTrue);
  });
}
