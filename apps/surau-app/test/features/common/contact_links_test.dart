import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/common/contact_links.dart';

void main() {
  test('tel keeps the number as dialled, without spaces or dashes', () {
    expect(ContactLinks.tel('012-345 6789').toString(), 'tel:0123456789');
    expect(ContactLinks.tel('+60 12-345 6789').toString(), 'tel:+60123456789');
  });

  test('WhatsApp turns a Malaysian 0 into 60 and keeps a + country code', () {
    expect(
      ContactLinks.whatsApp('012-345 6789').toString(),
      'https://wa.me/60123456789',
    );
    expect(
      ContactLinks.whatsApp('+60 12-345 6789').toString(),
      'https://wa.me/60123456789',
    );
    expect(
      ContactLinks.whatsApp('+65 9123 4567').toString(),
      'https://wa.me/6591234567',
    );
    expect(ContactLinks.internationalDigits('03-7654 3210'), '60376543210');
    expect(ContactLinks.internationalDigits('60123456789'), '60123456789');
  });

  test('mailto', () {
    expect(
      ContactLinks.mailto(' hafiz@contoh.my ').toString(),
      'mailto:hafiz@contoh.my',
    );
  });
}
