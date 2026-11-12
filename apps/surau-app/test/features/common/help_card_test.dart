// The help card: only the ways that exist, each a 52 px pill that opens
// tel:, wa.me or mailto:. Goldens: help_card (paper and glass, phone).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/app/theme.dart';
import 'package:surau_app/features/common/help_card.dart';
import 'package:surau_app/features/common/surau_info.dart';
import 'package:surau_app/l10n/generated/s.dart';

import '../../golden_sizes.dart';
import '../fakes.dart';

Widget app(Widget body, {bool glass = false}) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: SurauTheme.light(),
  locale: const Locale('ms'),
  localizationsDelegates: S.localizationsDelegates,
  supportedLocales: S.supportedLocales,
  home: Scaffold(
    backgroundColor: glass ? SurauColors.glass : SurauColors.paper,
    body: Padding(padding: const EdgeInsets.all(20), child: body),
  ),
);

const full = HelpContact(
  name: 'Encik Hafiz',
  phone: '012-345 6789',
  email: 'hafiz@contoh.my',
);

void main() {
  testWidgets('shows the contact and opens tel, WhatsApp and mailto', (
    tester,
  ) async {
    final opener = FakeOpener();
    await pumpAtSize(
      tester,
      app(HelpCard(contact: full, openUrl: opener.call)),
      GoldenSize.phone,
    );
    expect(find.text('Perlukan bantuan?'), findsOneWidget);
    expect(find.text('Hubungi Encik Hafiz'), findsOneWidget);
    expect(find.text('012-345 6789'), findsOneWidget);

    await tester.tap(find.text('Telefon'));
    await tester.tap(find.text('WhatsApp'));
    await tester.tap(find.text('E-mel'));
    expect(opener.opened.map((u) => u.toString()), [
      'tel:0123456789',
      'https://wa.me/60123456789',
      'mailto:hafiz@contoh.my',
    ]);
  });

  testWidgets('every pill is at least 48 px tall', (tester) async {
    await pumpAtSize(
      tester,
      app(HelpCard(contact: full, openUrl: FakeOpener().call)),
      GoldenSize.phone,
    );
    for (final label in ['Telefon', 'WhatsApp', 'E-mel']) {
      final size = tester.getSize(
        find
            .ancestor(of: find.text(label), matching: find.byType(InkWell))
            .first,
      );
      expect(size.height, greaterThanOrEqualTo(48), reason: label);
    }
  });

  testWidgets('only the fields that exist: email only, name only, nothing', (
    tester,
  ) async {
    await pumpAtSize(
      tester,
      app(
        HelpCard(
          contact: const HelpContact(email: 'ajk@surau.my'),
          openUrl: FakeOpener().call,
        ),
      ),
      GoldenSize.phone,
    );
    expect(find.text('Hubungi pentadbir surau'), findsOneWidget);
    expect(find.text('ajk@surau.my'), findsOneWidget);
    expect(find.text('E-mel'), findsOneWidget);
    expect(find.text('Telefon'), findsNothing);
    expect(find.text('WhatsApp'), findsNothing);

    await tester.pumpWidget(
      app(
        HelpCard(
          contact: const HelpContact(name: 'Puan Aminah'),
          openUrl: FakeOpener().call,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Hubungi Puan Aminah'), findsOneWidget);
    expect(find.byType(InkWell), findsNothing);

    await tester.pumpWidget(
      app(HelpCard(contact: null, openUrl: FakeOpener().call)),
    );
    await tester.pumpAndSettle();
    expect(find.text('Minta bantuan pentadbir surau anda.'), findsOneWidget);
  });

  testWidgets('Butiran teknikal is collapsed until tapped', (tester) async {
    await pumpAtSize(
      tester,
      app(
        const TechnicalDetails(
          boxAddress: 'https://10.168.0.154:8443',
          fingerprint: 'abcd ef01 2345 6789 abcd ef01 2345 6789',
        ),
      ),
      GoldenSize.phone,
    );
    expect(find.text('Butiran teknikal'), findsOneWidget);
    expect(find.text('https://10.168.0.154:8443'), findsNothing);
    await tester.tap(find.text('Butiran teknikal'));
    await tester.pumpAndSettle();
    expect(find.text('https://10.168.0.154:8443'), findsOneWidget);
    expect(
      find.text('abcd ef01 2345 6789\nabcd ef01 2345 6789'),
      findsOneWidget,
    );
    expect(
      find.text('Bandingkan dengan cetakan pentadbir sebelum teruskan.'),
      findsOneWidget,
    );
  });

  group('goldens', () {
    testWidgets('help_card', (tester) async {
      final w = app(
        Column(
          children: [
            HelpCard(contact: full, openUrl: FakeOpener().call),
            const SizedBox(height: 16),
            HelpCard(
              contact: const HelpContact(
                name: 'Puan Aminah',
                phone: '013-222 1111',
              ),
              openUrl: FakeOpener().call,
              lead: 'Kod pendaftaran telah tamat.',
            ),
            const SizedBox(height: 16),
            HelpCard(contact: null, openUrl: FakeOpener().call),
            const SizedBox(height: 16),
            const TechnicalDetails(
              boxAddress: 'https://10.168.0.154:8443',
              fingerprint: 'abcd ef01 2345 6789 abcd ef01 2345 6789',
              initiallyOpen: true,
            ),
          ],
        ),
      );
      await pumpAtSize(tester, w, GoldenSize.phone);
      await expectLater(
        find.byWidget(w),
        matchesGoldenFile('help_card_phone.png'),
      );
    });

    testWidgets('help_card_glass', (tester) async {
      final w = app(
        Column(
          children: [
            HelpCard(contact: full, onGlass: true, openUrl: FakeOpener().call),
            const SizedBox(height: 16),
            HelpCard(contact: null, onGlass: true, openUrl: FakeOpener().call),
          ],
        ),
        glass: true,
      );
      await pumpAtSize(tester, w, GoldenSize.phone);
      await expectLater(
        find.byWidget(w),
        matchesGoldenFile('help_card_glass_phone.png'),
      );
    });
  });
}
