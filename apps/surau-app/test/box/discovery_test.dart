import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/discovery.dart';

void main() {
  test('parseDiscovered keeps a plausible box and derives the name from the instance', () {
    final out = parseDiscovered([
      {'instance': 'MAXCOM box2', 'ip': '10.168.1.26', 'port': 8443, 'id': '0123456789abcdef', 'ca': 'abcdef0123456789'},
    ]);
    expect(out, hasLength(1));
    expect(out.single.name, 'box2-surau.local');
    expect(out.single.ip, '10.168.1.26');
    expect(out.single.port, 8443);
    expect(out.single.id, '0123456789abcdef');
    expect(out.single.ca, 'abcdef0123456789');
  });

  test('bad entries are dropped, bad TXT becomes null', () {
    final out = parseDiscovered([
      {'instance': 'MAXCOM evil', 'ip': '10.0.0.1', 'port': 8443},
      {'instance': 'MAXCOM box1', 'ip': 'evil.com', 'port': 8443},
      {'instance': 'MAXCOM box1', 'ip': '10.0.0.1', 'port': 0},
      {'instance': 'MAXCOM box100', 'ip': '10.0.0.1', 'port': 8443},
      'x',
      {'instance': 'MAXCOM box1', 'ip': '10.0.0.1', 'port': 8443, 'id': 'zz', 'ca': 5},
    ]);
    expect(out, hasLength(1));
    expect(out.single.id, isNull);
    expect(out.single.ca, isNull);
  });

  test('not a list gives nothing; the list is capped at 8', () {
    expect(parseDiscovered(null), isEmpty);
    expect(parseDiscovered({'a': 1}), isEmpty);
    final many = List.generate(20, (i) => {'instance': 'MAXCOM box${i + 1}', 'ip': '10.0.0.${i + 1}', 'port': 8443});
    expect(parseDiscovered(many), hasLength(8));
  });

  test('NoDiscovery and the platform default (not Android in tests) find nothing', () async {
    expect(await const NoDiscovery().discover(), isEmpty);
    expect(await platformDiscovery().discover(), isEmpty);
  });
}
