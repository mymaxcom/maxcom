// Route guard and menu rules, pure: no box, no widgets.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/guards.dart';
import 'package:surau_app/app/router.dart';
import 'package:surau_app/features/shell/menu.dart';
import 'package:surau_app/features/shell/permissions.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';

GuardResult run(
  String location, {
  bool enrolled = true,
  bool unlocked = true,
  Set<String> roles = const {'ajk'},
  FeatureFlags features = FeatureFlags.defaults,
}) => guard(
  GuardInput(
    location: location,
    enrolled: enrolled,
    unlocked: unlocked,
    roles: roles,
    features: features,
  ),
);

List<String> labels(Set<String> roles, [FeatureFlags f = FeatureFlags.defaults]) {
  final s = SMs();
  return menuFor(roles, f).map((i) => i.label(s)).toList();
}

void main() {
  group('guard', () {
    test('no enrolled box: everything goes to /enrol', () {
      expect(run('/', enrolled: false).redirect, AppRoutes.enrol);
      expect(run('/unlock', enrolled: false).redirect, AppRoutes.enrol);
      expect(run('/settings/clock', enrolled: false).redirect, AppRoutes.enrol);
      expect(run('/enrol', enrolled: false).redirect, isNull);
    });

    test('a phone with no surau may open the setup and recovery pages; an enrolled app may not', () {
      expect(run('/setup', enrolled: false).redirect, isNull);
      expect(run('/recovery', enrolled: false).redirect, isNull);
      expect(run('/setup', unlocked: false).redirect, AppRoutes.unlock);
      expect(run('/recovery', unlocked: false).redirect, AppRoutes.unlock);
      expect(run('/setup').redirect, AppRoutes.dashboard);
      expect(run('/recovery').redirect, AppRoutes.dashboard);
      // everything else still goes to /enrol
      expect(run('/scan', enrolled: false).redirect, AppRoutes.enrol);
    });

    test('/scan is open to every signed-in role', () {
      for (final roles in [
        {'ajk'},
        {'media'},
        {'admin'},
      ]) {
        expect(run('/scan', roles: roles).redirect, isNull, reason: roles.toString());
      }
    });

    test('enrolled, no session: everything goes to /unlock', () {
      expect(run('/', unlocked: false).redirect, AppRoutes.unlock);
      expect(run('/content', unlocked: false).redirect, AppRoutes.unlock);
      expect(run('/unlock', unlocked: false).redirect, isNull);
      expect(run('/enrol', unlocked: false).redirect, AppRoutes.unlock,
          reason: 'an enrolled app never shows the enrol form');
    });

    test('unlocked: the doors lead home', () {
      expect(run('/unlock').redirect, AppRoutes.dashboard);
      expect(run('/enrol').redirect, AppRoutes.dashboard);
      expect(run('/').redirect, isNull);
    });

    test('a page the roles do not allow goes home with the notice', () {
      final r = run('/users', roles: {'ajk'});
      expect(r.redirect, AppRoutes.dashboard);
      expect(r.forbidden, isTrue);
      expect(run('/users', roles: {'admin'}).redirect, isNull);
      expect(run('/users', roles: {'ajk', 'admin'}).redirect, isNull, reason: 'union');
      expect(run('/audit?x=1', roles: {'media'}).forbidden, isTrue);
      expect(run('/settings/clock', roles: {'ajk'}).redirect, isNull);
      expect(run('/prayer-data', roles: {'treasurer'}).forbidden, isTrue);
      expect(run('/this-device', roles: {'ajk'}).redirect, isNull);
    });

    test('the MAXCOM system pages need system:read: an admin is sent home, the Pentadbir MAXCOM may open them', () {
      for (final p in ['/settings/system', '/settings/cloudSync', '/settings/dataSources', '/settings/system?x=1']) {
        expect(run(p, roles: {'admin'}).forbidden, isTrue, reason: p);
        expect(run(p, roles: {'ajk'}).forbidden, isTrue, reason: p);
        expect(run(p, roles: {'superadmin'}).redirect, isNull, reason: p);
        expect(run(p, roles: {'admin', 'superadmin'}).redirect, isNull, reason: p);
      }
      // an ordinary settings page is unchanged
      expect(run('/settings/clock', roles: {'admin'}).redirect, isNull);
      expect(run('/settings/clock', roles: {'superadmin'}).redirect, isNull);
    });

    test('feature-gated pages need the switch on', () {
      expect(run('/finance', roles: {'treasurer'}).forbidden, isTrue);
      final financeOn = FeatureFlags.defaults.copyWith({'finance': true});
      expect(run('/finance', roles: {'treasurer'}, features: financeOn).redirect, isNull);
      expect(run('/finance', roles: {'media'}, features: financeOn).forbidden, isTrue);

      expect(run('/live', roles: {'media'}).redirect, isNull, reason: 'liveOnKiosk default on');
      final liveOff = FeatureFlags.defaults.copyWith({
        'liveOnKiosk': false,
        'liveYoutube': false,
      });
      expect(run('/live', roles: {'media'}, features: liveOff).forbidden, isTrue);
      final youtubeOnly = liveOff.copyWith({'liveYoutube': true});
      expect(run('/live', roles: {'media'}, features: youtubeOnly).redirect, isNull);

      expect(run('/jemaah', roles: {'admin'}).forbidden, isTrue);
      final jemaahOn = FeatureFlags.defaults.copyWith({'jemaahPage': true});
      expect(run('/jemaah', roles: {'ajk'}, features: jemaahOn).redirect, isNull);
    });

    test('the finance settings pages follow their permission', () {
      final on = FeatureFlags.defaults.copyWith({'finance': true});
      // /finance/tabung needs settings:write; the treasurer and AJK lack it.
      expect(run('/finance/tabung', roles: {'admin'}, features: on).redirect, isNull);
      expect(run('/finance/tabung', roles: {'superadmin'}, features: on).redirect, isNull);
      expect(run('/finance/tabung', roles: {'treasurer'}, features: on).forbidden, isTrue);
      expect(run('/finance/tabung', roles: {'ajk'}, features: on).forbidden, isTrue);
      expect(routeAllowed('/finance/tabung', {'ajk'}, on), isFalse);
      // /finance/setup needs finance:write: the treasurer keys the opening balances.
      expect(run('/finance/setup', roles: {'treasurer'}, features: on).redirect, isNull);
      expect(run('/finance/setup', roles: {'admin'}, features: on).redirect, isNull);
      expect(run('/finance/setup', roles: {'ajk'}, features: on).forbidden, isTrue);
      // Reading the report is finance:read, the audit trail finance:write.
      expect(run('/finance/laporan', roles: {'ajk'}, features: on).redirect, isNull);
      expect(run('/finance/audit', roles: {'treasurer'}, features: on).redirect, isNull);
      expect(run('/finance/audit', roles: {'ajk'}, features: on).forbidden, isTrue);
      // None of them while the module is off.
      expect(run('/finance/setup', roles: {'admin'}).forbidden, isTrue);
    });

    test('an unknown path is refused', () {
      expect(run('/nothing', roles: {'admin'}).forbidden, isTrue);
    });
  });

  group('menu', () {
    test('an AJK sees exactly Papan pemuka, Kandungan, Tetapan', () {
      expect(labels({'ajk'}), ['Papan pemuka', 'Kandungan', 'Tetapan']);
    });

    test('a treasurer gets Kewangan once finance is on', () {
      expect(labels({'treasurer'}), ['Papan pemuka', 'Kandungan', 'Tetapan']);
      expect(
        labels({'treasurer'}, FeatureFlags.defaults.copyWith({'finance': true})),
        ['Papan pemuka', 'Kewangan', 'Kandungan', 'Tetapan'],
      );
    });

    test('an admin sees all but the switched-off features', () {
      final off = FeatureFlags.defaults.copyWith({
        'finance': false,
        'liveOnKiosk': false,
        'liveYoutube': false,
      });
      expect(labels({'admin'}, off), [
        'Papan pemuka',
        'Kandungan',
        'Tetapan',
        'Pengguna & peranti',
        'Log perubahan',
      ]);
      final allOn = FeatureFlags.defaults.copyWith({
        'finance': true,
        'jemaahPage': true,
      });
      expect(labels({'admin'}, allOn), [
        'Papan pemuka',
        'Kewangan',
        'Kandungan',
        'Tetapan',
        'Pengguna & peranti',
        'Log perubahan',
        'Siaran langsung',
        'Jemaah',
      ]);
    });

    test('several roles show the union', () {
      expect(
        labels({'treasurer', 'media'}, FeatureFlags.defaults.copyWith({'finance': true})),
        ['Papan pemuka', 'Kewangan', 'Kandungan', 'Tetapan', 'Siaran langsung'],
      );
    });

    test('menu entries agree with the guard', () {
      for (final roles in [
        {'admin'},
        {'treasurer'},
        {'media'},
        {'ajk'},
      ]) {
        final f = FeatureFlags.defaults.copyWith({'finance': true, 'jemaahPage': true});
        for (final item in menuFor(roles, f)) {
          expect(run(item.route, roles: roles, features: f).redirect, isNull,
              reason: '${item.route} for $roles');
        }
      }
    });

    test('an entry matches its own page and its children only', () {
      final s = SMs();
      final items = menuFor({'admin'}, FeatureFlags.defaults);
      final settings = items.singleWhere((i) => i.label(s) == 'Tetapan');
      final home = items.first;
      expect(settings.matches('/settings'), isTrue);
      expect(settings.matches('/settings/clock'), isTrue);
      expect(settings.matches('/settingsx'), isFalse);
      expect(home.matches('/'), isTrue);
      expect(home.matches('/settings'), isFalse);
    });
  });
}
