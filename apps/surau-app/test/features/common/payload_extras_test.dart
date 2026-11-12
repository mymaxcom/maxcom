// The optional people-and-place fields of the enrolment payload: present
// in a new payload, absent (not an error) in an old one.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/box/payload.dart';
import 'package:surau_app/features/common/payload_extras.dart';

import '../fakes.dart';

void main() {
  test('reads surau, help, roles and invitedBy from a new payload', () {
    final x = EnrolPayloadExtras.parse(
      fixturePayload(roles: ['admin', 'media']),
    );
    expect(x.surau!.name, 'Surau D\'Waqaf');
    expect(x.surau!.kind, 'surau');
    expect(x.help!.name, 'Encik Hafiz');
    expect(x.help!.phone, '012-345 6789');
    expect(x.roles, ['admin', 'media']);
    expect(x.invitedBy, 'Encik Hafiz');
    expect(x.surauWithHelp!.help!.email, 'hafiz@contoh.my');
  });

  test('an old payload still parses strictly and has no extras', () {
    final text = fixturePayload(legacy: true);
    expect(EnrolPayload.parse(text).user, 'Ustaz Ali');
    final x = EnrolPayloadExtras.parse(text);
    expect(x.surau, isNull);
    expect(x.help, isNull);
    expect(x.roles, isEmpty);
    expect(x.invitedBy, isNull);
    expect(x.surauWithHelp, isNull);
  });

  test('never throws: junk, wrong types, oversized', () {
    expect(EnrolPayloadExtras.parse('nope').roles, isEmpty);
    expect(EnrolPayloadExtras.parse('surau1:!!!').surau, isNull);
    expect(EnrolPayloadExtras.parse('surau1:${'A' * 5000}').surau, isNull);
    final odd = fixturePayload().replaceFirst('surau1:', '');
    expect(EnrolPayloadExtras.parse(odd).surau, isNull);
  });

  test('ignores non-string roles and a blank invitedBy', () {
    // Build by hand: roles with a number inside, invitedBy blank.
    final text = fixturePayload(invitedBy: '   ');
    final x = EnrolPayloadExtras.parse(text);
    expect(x.invitedBy, isNull);
    expect(x.roles, ['admin']);
  });
}
