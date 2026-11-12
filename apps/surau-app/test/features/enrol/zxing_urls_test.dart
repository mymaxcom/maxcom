import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/enrol/zxing_urls.dart';

void main() {
  test('bundled paths are relative (no leading slash, no CDN)', () {
    expect(zxingScriptPath, 'zxing/index.js');
    expect(zxingWasmPath, 'zxing/zxing_reader.wasm');
  });

  test('resolve under the /app/ base href', () {
    final base = Uri.parse('http://box.local:8787/app/');
    expect(zxingUrl(base, zxingScriptPath),
        'http://box.local:8787/app/zxing/index.js');
    expect(zxingUrl(base, zxingWasmPath),
        'http://box.local:8787/app/zxing/zxing_reader.wasm');
  });
}
