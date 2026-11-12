// The Tetapan search: what matches, why, and what a surau admin cannot find.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/settings_search.dart';

void main() {
  const index = SettingsSearchIndex(
    extras: [
      SearchExtra('order', 'Susunan kad di skrin TV', 'Kandungan', keywords: ['giliran']),
    ],
  );
  const admin = {'admin'};
  const superadmin = {'admin', 'superadmin'};

  Map<String, String?> run(String q, [Set<String> roles = admin]) => {
    for (final h in index.search(q, roles: roles)) h.feature: h.why,
  };

  test('azan: title hits carry no reason, keyword hits say so', () {
    final r = run('azan');
    expect(r.containsKey('azanCountdown'), isTrue);
    expect(r['azanCountdown'], isNull, reason: 'the title has the word');
    expect(r['firstAzanSubuh'], isNull);
    expect(r['masukWaktu'], 'Kata kunci: azan');
    expect(r['beeps'], 'Kata kunci: azan');
  });

  test('a field, a choice, a group and English titles match', () {
    expect(run('kuat bunyi')['beeps'], 'Medan: Kuat bunyi');
    expect(run('tengah malam')['hijriDate'], 'Pilihan: Tengah malam');
    expect(run('kewangan')['tabungCard'], 'Kumpulan: Kewangan');
    expect(run('CLOCK').containsKey('clock'), isTrue, reason: 'EN title, any case');
  });

  test('nothing matches a thing MAXCOM has no setting for; a blank query finds nothing', () {
    expect(run('tempat letak kereta'), isEmpty);
    expect(run('   '), isEmpty);
  });

  test('system values cannot be found by a surau admin, and can by a Pentadbir MAXCOM', () {
    expect(run('kadar bit').containsKey('liveYoutube'), isFalse);
    expect(run('kadar bit', superadmin)['liveYoutube'], 'Medan: Kadar bit maksimum (kbps)');
    expect(run('kadar bit', superadmin)['lj:liveYoutube'], 'Medan: Kadar bit maksimum (kbps)');
    expect(run('amaran tiada video').containsKey('system'), isFalse);
    expect(run('amaran tiada video', superadmin)['system'], 'Medan: Amaran tiada video (saat)');
    expect(run('sumber data').containsKey('dataSources'), isFalse);
    expect(run('penyiaran youtube', superadmin).containsKey('lj:liveYoutube'), isTrue);
  });

  test('an extra row is found by its title and keyword', () {
    expect(run('giliran')['order'], 'Kata kunci: giliran');
    expect(run('susunan kad').containsKey('order'), isTrue);
  });
}
