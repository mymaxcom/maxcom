// Wording fixes of release 2026.11.14 (qs-gate M3): the Friday Zohor label in Arabic, the BM retry sentence, and the
// joined-recording texts in all three languages.

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/l10n/generated/s_ar.dart';
import 'package:surau_app/l10n/generated/s_en.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';

void main() {
  test('Arabic Friday Zohor reads "al-Jumaa on the day of Jumaa" properly', () {
    expect(SAr().videoAfterPrayerZohor, 'الظهر (الجمعة في يوم الجمعة)');
  });

  test('BM mic list retry has no double "lagi"', () {
    expect(SMs().errcMicListFailed, 'Senarai Mic-in tidak dapat dibaca. Cuba semula sebentar lagi.');
  });

  test('the save question and its answers exist in BM, EN and AR', () {
    expect(SMs().liveRecSavedAsk, 'Rakaman sudah disimpan dalam Fail/Downloads?');
    expect(SMs().liveRecSavedYes, 'Ya');
    expect(SMs().liveRecSavedNo, 'Belum');
    for (final s in [SMs(), SEn(), SAr()]) {
      expect(s.liveRecSavedNotYetNote, contains('7'));
      expect(s.liveRecSaveTooBigNote, isNotEmpty);
      expect(s.liveRecJoinNeedsWifiNote, isNotEmpty);
      expect(s.liveRecBadPieceNote, isNotEmpty);
      expect(s.liveRecJoinedUntrackedNote, isNotEmpty);
    }
    expect(SEn().liveRecSavedAsk, contains('Files/Downloads'));
    expect(SAr().liveRecSavedAsk, isNot(SEn().liveRecSavedAsk));
  });

  test('the new texts carry no dash, arrow or approximation sign', () {
    final bad = RegExp('[\u2013\u2014\u2192\u2248]');
    for (final s in [SMs(), SEn(), SAr()]) {
      for (final t in [
        s.liveRecSavedAsk, s.liveRecSavedNotYetNote, s.liveRecSaveTooBigNote, s.liveRecJoinNeedsWifiNote,
        s.liveRecBadPieceNote, s.liveRecJoinedUntrackedNote, s.errcMicDeviceUnavailable, s.errcMicSilent,
      ]) {
        expect(bad.hasMatch(t), isFalse, reason: t);
      }
    }
  });
}
