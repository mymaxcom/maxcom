import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:surau_app/features/shell/read_cache.dart';

void main() {
  final at = DateTime.utc(2026, 11, 4, 9);

  Future<PrefsReadCacheStore> openStore([
    Map<String, Object> seed = const {},
  ]) async {
    SharedPreferences.setMockInitialValues(seed);
    return PrefsReadCacheStore(await SharedPreferences.getInstance());
  }

  test('keys are namespaced by box id and one put writes one key', () async {
    final store = await openStore();
    final cache = ReadCache(store: store, boxId: 'boxA');
    cache.put('/api/health', {'v': 1}, at);
    cache.put('/api/settings', {'v': 2}, at);
    await store.load('boxA'); // drains the queue
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getKeys().toSet(), {
      'surau.cache.boxA/api/health',
      'surau.cache.boxA/api/settings',
    });
    final back = await store.load('boxA');
    expect(back['/api/health']!.body, {'v': 1});
    expect(back['/api/health']!.at, at);
  });

  test('another box id sees nothing and its leftovers are dropped', () async {
    final store = await openStore();
    ReadCache(store: store, boxId: 'boxA').put('/api/health', {'v': 1}, at);
    expect(await store.load('boxB'), isEmpty);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getKeys(), isEmpty);
  });

  test('clear empties memory and the store for every box', () async {
    final store = await openStore();
    final cache = ReadCache(store: store, boxId: 'boxA');
    cache.put('/api/health', {'v': 1}, at);
    cache.clear();
    expect(cache.isEmpty, isTrue);
    await store.load('boxA');
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getKeys(), isEmpty);
  });

  test('a save queued before a clear cannot rewrite keys after it', () async {
    final store = await openStore();
    final cache = ReadCache(store: store, boxId: 'boxA');
    for (var i = 0; i < 5; i++) {
      cache.put('/api/p$i', {'i': i}, at); // not awaited, like the gateway
    }
    cache.clear();
    cache.put('/api/after', {'ok': true}, at);
    final back = await store.load('boxA');
    expect(back.keys, ['/api/after']);
  });

  test(
    'a load that started before clear does not seed the cleared cache',
    () async {
      final store = await openStore();
      ReadCache(store: store, boxId: 'boxA').put('/api/health', {'v': 1}, at);
      final cache = ReadCache(store: store, boxId: 'boxA');
      final restoring = cache.restore();
      cache.clear();
      await restoring;
      expect(cache.isEmpty, isTrue);
    },
  );

  test('restore seeds this box and a fresh body wins', () async {
    final store = await openStore();
    ReadCache(store: store, boxId: 'boxA').put('/api/health', {'v': 1}, at);
    final cache = ReadCache(store: store, boxId: 'boxA');
    cache.put('/api/health', {'v': 9}, at);
    await cache.restore();
    expect(cache.get('/api/health')!.body, {'v': 9});
  });
}
