// One name rule for a device in enrol, first setup and recovery: trimmed and
// cut at 80 characters, as the box keeps it.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/features/common/device_name.dart';

void main() {
  test('[A13] the name is trimmed and kept to 80 characters', () {
    expect(maxDeviceNameLength, 80);
    expect(cleanDeviceName('  Telefon Ali  '), 'Telefon Ali');
    final long = 'a' * 100;
    expect(cleanDeviceName(long), 'a' * 80);
    expect(cleanDeviceName('b' * 80), 'b' * 80);
    // Arabic and emoji are cut by character, never in the middle of one.
    final arabic = 'هاتف' * 30;
    expect(cleanDeviceName(arabic).runes.length, 80);
    expect(cleanDeviceName('\u{1F4F1}' * 90).runes.length, 80);
  });

  test('[A13] enrol, setup and recovery all use the same field limit and rule', () {
    for (final f in [
      'lib/features/enrol/enrol_screen.dart',
      'lib/features/setup/setup_screen.dart',
      'lib/features/setup/recovery_screen.dart',
    ]) {
      final src = File(f).readAsStringSync();
      expect(src.contains('cleanDeviceName('), isTrue, reason: f);
    }
    final enrol = File('lib/features/enrol/enrol_screen.dart').readAsStringSync();
    expect(enrol.contains('maxLength: 40'), isFalse);
    expect(enrol.contains('maxLength: maxDeviceNameLength'), isTrue);
  });
}
