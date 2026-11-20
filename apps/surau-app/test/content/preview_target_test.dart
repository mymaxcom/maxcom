// Which address the Android preview WebView is given: the one the app has
// proven for the box now (route table), else the enrolled origin.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/routes.dart';
import 'package:surau_app/content/preview_target.dart';

import '../features/fakes.dart' show fixtureBox;

const _name = 'box1-surau.local';

void main() {
  group('previewTargetFor', () {
    test('a name with a route gives the IPv4 origin with the stored scheme and port', () {
      final routes = BoxRoutes()..set(_name, '192.0.2.7');
      final box = fixtureBox(name: _name);
      final t = previewTargetFor(box, routes, isWeb: false);
      expect(t.routed, isTrue);
      expect(t.origin, Uri.parse('https://192.0.2.7:8443'));
      expect(t.origin.scheme, 'https');
      expect(t.origin.port, 8443);
      // The pinned leaf is fetched at the name (the route opens the address).
      expect(t.leafBox.box, Uri.parse('https://box1-surau.local:8443'));
      expect(t.leafBox.boxId, box.boxId);
      expect(t.leafBox.caSha256, box.caSha256);
    });

    test('no name keeps the stored origin', () {
      final routes = BoxRoutes()..set(_name, '192.0.2.7');
      final box = fixtureBox();
      final t = previewTargetFor(box, routes, isWeb: false);
      expect(t.routed, isFalse);
      expect(t.origin, box.box);
      expect(identical(t.leafBox, box), isTrue);
    });

    test('a name without a route keeps the stored origin', () {
      final box = fixtureBox(name: _name);
      expect(previewTargetFor(box, BoxRoutes(), isWeb: false).origin, box.box);
      // A route for another name does not count.
      final other = BoxRoutes()..set('box2-surau.local', '192.0.2.8');
      expect(previewTargetFor(box, other, isWeb: false).origin, box.box);
    });

    test('no route table keeps the stored origin', () {
      final box = fixtureBox(name: _name);
      expect(previewTargetFor(box, null, isWeb: false).origin, box.box);
    });

    test('the web build keeps the box origin (an iframe on it)', () {
      final routes = BoxRoutes()..set(_name, '192.0.2.7');
      final box = fixtureBox(name: _name);
      final t = previewTargetFor(box, routes, isWeb: true);
      expect(t.routed, isFalse);
      expect(t.origin, box.box);
    });

    test('a route change gives the new origin and bumps the epoch', () {
      final routes = BoxRoutes();
      final box = fixtureBox(name: _name);
      expect(previewTargetFor(box, routes, isWeb: false).origin, box.box);
      final e0 = routes.epoch.value;
      routes.set(_name, '192.0.2.7');
      expect(routes.epoch.value, e0 + 1);
      expect(previewTargetFor(box, routes, isWeb: false).origin, Uri.parse('https://192.0.2.7:8443'));
      routes.set(_name, '192.0.2.9');
      expect(routes.epoch.value, e0 + 2);
      expect(previewTargetFor(box, routes, isWeb: false).origin, Uri.parse('https://192.0.2.9:8443'));
      routes.remove(_name);
      expect(routes.epoch.value, e0 + 3);
      expect(previewTargetFor(box, routes, isWeb: false).origin, box.box);
    });
  });
}
