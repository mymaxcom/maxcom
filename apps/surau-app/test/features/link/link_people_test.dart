// The people part of the questions screen (phase 2C): the models (null-safe, the last four digits only), the controller
// (one role per person, "same person", a new revision each time, the answers start again when another box is kept),
// the screen in three languages, every refusal worded, and that a phone number is never drawn. Goldens: the people part
// in BM, English and Arabic.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/app_lang.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/link/link_models.dart';
import 'package:surau_app/features/link/link_people_view.dart';
import 'package:surau_app/features/link/link_text.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/l10n/s_lookup.dart';

import '../fakes.dart' show jsonResponse;
import 'link_fixtures.dart';
import 'link_screens_test.dart' show close, count, expectTall, openLink, sent, tapKey;

Map<String, Object?> withPeople({
  Map<String, Object?>? people,
  bool noPeople = false,
  Map<String, String> roles = const {},
  List<String>? same,
  String keep = 'scan',
  String master = 'scan',
}) => statusJson(
  session: linkSession(
    step: 'questions',
    answers: answersJson(keep: keep, master: master, roles: roles, same: same),
    people: noPeople ? null : (people ?? peopleJson()),
  ),
);

/// Every string a widget tree draws: texts, tooltips and semantic labels.
List<String> drawn(WidgetTester tester) {
  final out = <String>[];
  for (final w in tester.widgetList<Text>(find.byType(Text))) {
    out.add(w.data ?? w.textSpan?.toPlainText() ?? '');
  }
  for (final w in tester.widgetList<Tooltip>(find.byType(Tooltip))) {
    out.add(w.message ?? '');
  }
  return out;
}

Widget peopleApp(AppLang lang, LinkPeople people) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: Locale(lang.name),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: LinkPeopleSection(people: people, otherName: 'Dewan Utama', busy: false, onRole: (_, _) {}, onSame: (_, _) {}),
    ),
  ),
);

void main() {
  group('the models', () {
    test('a session without people (an older box, or the lists not stored yet) has none', () {
      final st = statusOf(withPeople(noPeople: true));
      expect(st.session!.people, isNull);
      expect(st.session!.answers!.same, isEmpty);
    });

    test('the people read: lists, last four digits, the admins after, the tickets', () {
      final people = statusOf(withPeople()).session!.people!;
      expect(people.add.map((p) => p.name), ['Farid', 'Hasnah']);
      expect(people.add[1].roles, ['ajk', 'media']);
      expect(people.same.single.keptName, 'Puan Aminah');
      expect(people.roleDiffs.single.phone4, '0002');
      expect(people.roleDiffs.single.phoneKey, aminahPhone);
      expect(people.nameAsk.single.same, isFalse);
      expect(people.adminsAfter, ['Aminah', 'Razak']);
      expect(people.tickets, 2);
    });

    test('a field of the wrong type fails the read rather than show half a truth', () {
      expect(() => LinkPeople.fromJson({'add': 'x'}), throwsFormatException);
      expect(() => LinkPeople.fromJson({'add': [{'id': 1}]}), throwsFormatException);
    });

    test('the roles that may be added are those of the other box not held already, never an ops role', () {
      const d = LinkRoleDiff(
        phoneKey: aminahPhone,
        phone4: '0002',
        name: 'Aminah',
        keptRoles: ['ajk'],
        otherRoles: ['admin', 'ajk', 'superadmin', 'support', 'media'],
        chosen: null,
      );
      expect(d.addable, ['admin', 'media']);
    });

    test('the number is not in the text of a difference', () {
      final d = statusOf(withPeople()).session!.people!.roleDiffs.single;
      expect(d.toString(), isNot(contains('0120000002')));
    });

    test('answers carry the same-person list', () {
      final a = statusOf(withPeople(same: ['p-razak-0004'], roles: {aminahPhone: 'admin'})).session!.answers!;
      expect(a.same, ['p-razak-0004']);
      expect(a.roles, {aminahPhone: 'admin'});
    });
  });

  group('the screen', () {
    testWidgets('counts, names, the same people, the differences, the questions, the admins and the phones', (tester) async {
      await openLink(tester, withPeople());
      await tester.ensureVisible(find.byKey(const ValueKey('link-people')));
      await tester.pump();
      expect(find.text('Pengguna selepas pautan'), findsOneWidget);
      expect(find.text('2 orang ditambah daripada Dewan Utama'), findsOneWidget);
      expect(find.text('Farid'), findsOneWidget);
      expect(find.text('Hasnah'), findsOneWidget);
      expect(find.text('Sama (nombor telefon sama)'), findsOneWidget);
      expect(find.text('Puan Aminah'), findsOneWidget);
      expect(find.text('Aminah, telefon berakhir 0002'), findsOneWidget);
      expect(find.text('Kekal: AJK'), findsOneWidget);
      expect(find.text('Di Dewan Utama: Pentadbir dan AJK'), findsOneWidget);
      expect(find.text('Tambah satu peranan daripada Dewan Utama:'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-role-0-admin')), findsOneWidget);
      // the role the kept person holds already cannot be added
      expect(find.byKey(const ValueKey('link-role-0-ajk')), findsNothing);
      expect(
        find.text('Pilihan ini membuat semakan baharu. Persetujuan kedua-dua pentadbir dibatalkan dan perlu diberi semula.'),
        findsOneWidget,
      );
      expect(find.text('Razak di Dewan Utama ada nama yang sama dengan Razak, tetapi nombor telefonnya tidak sepadan.'), findsOneWidget);
      expect(find.text('Pentadbir selepas pautan'), findsOneWidget);
      expect(find.text('2 telefon akan diminta menyambung ke Box utama'), findsOneWidget);
      await close(tester);
    });

    testWidgets('"Orang berbeza" is the default answer of a same-name question', (tester) async {
      await openLink(tester, withPeople());
      final yes = tester.widget<ChoiceChip>(find.byKey(const ValueKey('link-same-p-razak-0004-yes')));
      final no = tester.widget<ChoiceChip>(find.byKey(const ValueKey('link-same-p-razak-0004-no')));
      expect(yes.selected, isFalse);
      expect(no.selected, isTrue);
      expect(find.text('Orang yang sama'), findsOneWidget);
      expect(find.text('Orang berbeza'), findsOneWidget);
      await close(tester);
    });

    testWidgets('no phone number is drawn, in any language', (tester) async {
      for (final lang in AppLang.values) {
        await openLink(tester, withPeople(), lang: lang);
        await tester.ensureVisible(find.byKey(const ValueKey('link-people')));
        await tester.pump();
        final all = drawn(tester).join('\n');
        expect(all, isNot(contains('0120000002')));
        expect(all, isNot(contains('60120000002')));
        expect(all, isNot(contains('+60')));
        expect(all, contains('0002'));
        await close(tester);
      }
    });

    testWidgets('the Pentadbir list is always there, also when it is empty; no phone asked to move says so', (tester) async {
      await openLink(tester, withPeople(people: peopleJson(add: [], same: [], roleDiffs: [], nameAsk: [], adminsAfter: [], tickets: 0)));
      await tester.ensureVisible(find.byKey(const ValueKey('link-people-admins')));
      await tester.pump();
      expect(find.text('Pentadbir selepas pautan'), findsOneWidget);
      expect(find.text('Tiada pentadbir'), findsOneWidget);
      expect(find.text('Tiada orang baharu daripada Dewan Utama untuk ditambah.'), findsOneWidget);
      expect(find.text('Tiada telefon akan diminta menyambung ke Box utama'), findsOneWidget);
      expect(find.byKey(const ValueKey('link-people-same')), findsNothing);
      expect(find.byKey(const ValueKey('link-people-roles')), findsNothing);
      expect(find.byKey(const ValueKey('link-people-names')), findsNothing);
      await close(tester);
    });

    testWidgets('an older box sends no people: the part is not drawn and the rest is as before', (tester) async {
      await openLink(tester, withPeople(noPeople: true));
      expect(find.byKey(const ValueKey('link-people')), findsNothing);
      expect(find.byKey(const ValueKey('link-agree')), findsOneWidget);
      await close(tester);
    });

    testWidgets('a new box has nobody to merge: the part is not drawn', (tester) async {
      await openLink(
        tester,
        statusJson(
          session: linkSession(
            step: 'questions',
            scan: ruangMuslimat(setUp: false),
            answers: answersJson(keep: 'show', master: 'show'),
            people: peopleJson(),
          ),
        ),
      );
      expect(find.byKey(const ValueKey('link-people')), findsNothing);
      await close(tester);
    });

    testWidgets('choosing a role sends ONE new revision with that role under the number; choosing it again takes it back', (tester) async {
      final (h, box) = await openLink(tester, withPeople());
      // the box answers the write with the role chosen
      box.writes['PUT /api/link/answers'] = (r) {
        box.status = withPeople(
          roles: {aminahPhone: 'admin'},
          people: peopleJson(
            roleDiffs: [
              {'phone': aminahPhone, 'phone4': '0002', 'name': 'Aminah', 'keptRoles': ['ajk'], 'otherRoles': ['admin', 'ajk'], 'chosen': 'admin'},
            ],
          ),
        );
        return jsonResponse(200, box.status);
      };
      await tapKey(tester, 'link-role-0-admin');
      expect(count(h, '/api/link/answers', method: 'PUT'), 1);
      expect(sent(h, '/api/link/answers', method: 'PUT'), {
        'keep': 'scan',
        'master': 'scan',
        'roles': {aminahPhone: 'admin'},
        'same': <String>[],
        'phones': 'direct',
        'financeTick': false,
      });
      expect(tester.widget<FilterChip>(find.byKey(const ValueKey('link-role-0-admin'))).selected, isTrue);
      await tapKey(tester, 'link-role-0-admin');
      expect(count(h, '/api/link/answers', method: 'PUT'), 2);
      expect(sent(h, '/api/link/answers', method: 'PUT')['roles'], <String, String>{});
      await close(tester);
    });

    testWidgets('"Orang yang sama" sends the person\'s id in same; the answer is whole each time', (tester) async {
      final (h, _) = await openLink(tester, withPeople());
      await tapKey(tester, 'link-same-p-razak-0004-yes');
      expect(sent(h, '/api/link/answers', method: 'PUT'), {
        'keep': 'scan',
        'master': 'scan',
        'roles': <String, String>{},
        'same': ['p-razak-0004'],
        'phones': 'direct',
        'financeTick': false,
      });
      await close(tester);
    });

    testWidgets('keeping the other box starts the people answers again', (tester) async {
      final (h, _) = await openLink(
        tester,
        withPeople(roles: {aminahPhone: 'admin'}, same: ['p-razak-0004'], keep: 'scan', master: 'scan'),
      );
      await tapKey(tester, 'link-q1-show');
      final body = sent(h, '/api/link/answers', method: 'PUT');
      expect(body['keep'], 'show');
      expect(body['roles'], <String, String>{});
      expect(body['same'], <String>[]);
      await close(tester);
    });

    for (final (lang, line) in [
      (AppLang.ms, 'Pilihan tentang pengguna tidak lagi sesuai dengan senarai. Lihat semula bahagian Pengguna di atas.'),
      (AppLang.en, 'The choices about people no longer fit the lists. Look at the People part above again.'),
      (AppLang.ar, 'لم تعد اختيارات المستخدمين تناسب القوائم. راجع قسم المستخدمين أعلاه.'),
    ]) {
      testWidgets('people_answer is worded in ${lang.name}, and the screen looks at the lists again', (tester) async {
        final (h, box) = await openLink(tester, withPeople(), lang: lang);
        box.writes['PUT /api/link/answers'] = (r) => jsonResponse(409, {'code': 'people_answer', 'errors': ['people_answer']});
        final before = h.box.seen.where((r) => r.url.path == '/api/link/status').length;
        await tapKey(tester, 'link-same-p-razak-0004-yes');
        await tester.pump();
        await tester.pump();
        expect(find.text(line), findsOneWidget);
        // the box was asked for its status once more
        expect(h.box.seen.where((r) => r.url.path == '/api/link/status').length, greaterThan(before));
        await close(tester);
      });
    }

    test('the refusal is a code, worded here in three languages', () {
      for (final lang in AppLang.values) {
        final s = sFor(lang);
        expect(linkCodeText(s, 'people_answer'), isNot(linkCodeText(s, 'something-new')));
      }
    });
  });

  group('goldens', () {
    final people = LinkPeople.fromJson({
      'add': [
        {'id': 'p-farid-0001', 'name': 'Farid', 'roles': ['treasurer']},
        {'id': 'p-hasnah-002', 'name': 'Hasnah', 'roles': ['ajk', 'media']},
      ],
      'same': [
        {'id': 'p-aminah-003', 'name': 'Aminah', 'keptName': 'Puan Aminah', 'keptRoles': ['ajk'], 'rolesAfter': ['ajk', 'admin']},
      ],
      'roleDiffs': [
        {'phone': aminahPhone, 'phone4': '0002', 'name': 'Aminah', 'keptRoles': ['ajk'], 'otherRoles': ['admin', 'ajk'], 'chosen': 'admin'},
        {'phone': kamalPhone, 'phone4': '0001', 'name': 'Kamal', 'keptRoles': ['ajk'], 'otherRoles': ['media'], 'chosen': null},
      ],
      'nameAsk': [
        {'id': 'p-razak-0004', 'name': 'Razak', 'keptName': 'Razak', 'same': false},
        {'id': 'p-salmah-005', 'name': 'Salmah', 'keptName': 'Puan Salmah', 'same': true},
      ],
      'adminsAfter': ['Aminah', 'Razak'],
      'tickets': 3,
    });
    for (final lang in AppLang.values) {
      testWidgets('the people part in ${lang.name}', (tester) async {
        await expectTall(tester, peopleApp(lang, people), 'link_people_${lang.name}_phone', const Size(412, 1500));
        expect(tester.takeException(), isNull);
        await close(tester);
      });
    }
  });
}
