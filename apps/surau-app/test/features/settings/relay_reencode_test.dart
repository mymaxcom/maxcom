// "Kod semula" (relayVideo reencode) is offered only where the box can encode
// H.264: the box says so as `relayReencode` of its live status.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/registry.g.dart' as reg;
import 'package:surau_app/features/settings_form.dart';
import 'package:surau_app/features/settings_widgets/chips_field.dart';
import 'package:surau_app/features/settings_widgets/field_meta.dart';
import 'package:surau_app/l10n/generated/s.dart';
import 'package:surau_app/ops/ops_build.dart';

Widget _wrap(Widget child, {Locale locale = const Locale('ms')}) => MaterialApp(
  locale: locale,
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

const _note = 'Kod semula tidak disokong pada kotak ini. Gunakan Salin terus.';

Widget _cards({
  required String value,
  Map<String, String> extra = const {},
  void Function(String)? onChanged,
}) => ChoiceCards(
  path: 'relayVideo',
  name: 'relayVideo',
  label: 'Video ke YouTube',
  value: value,
  meta: fieldMeta('liveYoutube', 'relayVideo')!,
  onChanged: onChanged ?? (_) {},
  extraDisabled: extra,
);

void main() {
  testWidgets('capable box: both choices are enabled and no note shows', (
    tester,
  ) async {
    final picked = <String>[];
    await tester.pumpWidget(
      _wrap(_cards(value: 'copy', onChanged: picked.add)),
    );
    expect(find.text(_note), findsNothing);
    await tester.tap(find.byKey(const ValueKey('setting-relayVideo-reencode')));
    expect(picked, ['reencode']);
  });

  testWidgets('old box (field missing): both choices stay enabled', (
    tester,
  ) async {
    final picked = <String>[];
    await tester.pumpWidget(
      _wrap(_cards(value: 'reencode', onChanged: picked.add)),
    );
    await tester.tap(find.byKey(const ValueKey('setting-relayVideo-copy')));
    expect(picked, ['copy']);
    expect(find.text(_note), findsNothing);
  });

  testWidgets(
    'incapable box: reencode is disabled with the note, copy still works',
    (tester) async {
      final picked = <String>[];
      await tester.pumpWidget(
        _wrap(
          _cards(
            value: 'copy',
            extra: const {'reencode': _note},
            onChanged: picked.add,
          ),
        ),
      );
      expect(find.text(_note), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('setting-relayVideo-reencode')),
      );
      expect(picked, isEmpty);
      await tester.tap(find.byKey(const ValueKey('setting-relayVideo-copy')));
      expect(picked, ['copy']);
    },
  );

  testWidgets(
    'incapable box with a saved reencode: copy is shown as what runs and can be saved',
    (tester) async {
      final picked = <String>[];
      await tester.pumpWidget(
        _wrap(
          _cards(
            value: 'reencode',
            extra: const {'reencode': _note},
            onChanged: picked.add,
          ),
        ),
      );
      expect(find.text(_note), findsOneWidget);
      // the copy card carries the selected look (2 px teal border)
      final copy = tester.widget<Material>(
        find
            .descendant(
              of: find.byKey(const ValueKey('setting-relayVideo-copy')),
              matching: find.byType(Material),
            )
            .first,
      );
      expect((copy.shape as RoundedRectangleBorder).side.width, 2);
      await tester.tap(find.byKey(const ValueKey('setting-relayVideo-copy')));
      expect(picked, ['copy']);
    },
  );

  testWidgets('the note is worded in English and Arabic', (tester) async {
    late S s;
    await tester.pumpWidget(
      _wrap(
        Builder(
          builder: (c) {
            s = S.of(c);
            return const SizedBox();
          },
        ),
        locale: const Locale('en'),
      ),
    );
    expect(
      s.settingsReencodeUnsupported,
      'Re-encode is not supported on this box. Use Copy as is.',
    );
    await tester.pumpWidget(
      _wrap(
        Builder(
          builder: (c) {
            s = S.of(c);
            return const SizedBox();
          },
        ),
        locale: const Locale('ar'),
      ),
    );
    expect(s.settingsReencodeUnsupported, isNotEmpty);
  });

  // relayVideo is a system setting: only the ops build draws it (Lanjutan card).
  testWidgets(
    'SettingsForm passes relayReencode: false to the relayVideo cards (ops build)',
    (tester) async {
      final feature = reg.features.firstWhere((f) => f.key == 'liveYoutube');
      await tester.pumpWidget(
        _wrap(
          SettingsForm(
            feature: feature,
            values: const {'relayVideo': 'reencode'},
            errors: const {},
            onChanged: (k, v) {},
            lanjutanVisible: true,
            relayReencode: false,
          ),
        ),
      );
      expect(find.text(_note), findsOneWidget);
    },
    skip: !kOpsBuild,
  );
}
