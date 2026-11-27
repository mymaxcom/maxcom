// The l10n keys of the 2026.11.15 Siaran langsung revamp, added up front in
// Lane 0 so no lane edits the arb files. Every key exists in BM, EN and AR,
// reads as Malaysian Malay, carries no long dash, arrow or approximation
// sign, and never calls the device a "kotak".

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:surau_app/l10n/generated/s_ar.dart';
import 'package:surau_app/l10n/generated/s_en.dart';
import 'package:surau_app/l10n/generated/s_ms.dart';

const liveRevampKeys = <String>[
  // destination strip and sheet (the choice is held per MAXCOM Kiosk Box)
  'liveDestUnconfirmed',
  'liveDestSaving',
  'liveDestPerBoxNote',
  'liveDestRecUnavailable',
  // own live after an app restart
  'liveMineTitle',
  'liveMineResume',
  'liveMineStillSending',
  // stops without a tap
  'liveStoppedCameraLost',
  'liveStoppedByBox',
  'liveStoppedByAdmin',
  // who pulls the external camera
  'liveVideoPathLabel',
  'liveVideoPathDevice',
  'liveVideoPathBox',
  'liveVideoPathBoxNote',
  'liveCameraHeavyWarn',
  // why Rakam is not offered when the box pulls the camera
  'liveRecNoBoxPullStart',
  'liveRecNoBoxPullSummary',
  // camera in use: join the shared picture
  'liveCameraInUseBy',
  'liveCameraInUseByBox',
  'liveCameraJoinNote',
  'errcCameraInUse',
  // ingest warning
  'liveWarnWeakPhoneWifi',
  // refusals
  'errcResumeMismatch',
  'errcYoutubeLiveNotEnabled',
  'errcBoxClockWrong',
  'errcYoutubeBusyOtherBox',
  'errcTooManyViewers',
  'errcYoutubeBroadcastOpen',
  'errcAlreadyUploading',
  // phone notification
  'liveNotifStop',
  // sync sheet
  'syncBoxFailed',
  // settings pages
  'settingsChangedElsewhereNow',
  'settingsReload',
  'settingsMaybeStale',
  'cameraResetBody',
  'cameraFoundByPort',
  // upload screen
  'uploadReasonNoBox',
  'uploadAwaitingConfirm',
  'uploadErrorEmptyFile',
  'uploadEarlierEntry',
  // after a live with drops
  'liveGapReplaceAsk',
  'liveGapReplaceYes',
  'liveGapReplaceNo',
  // YouTube sign-out
  'liveYoutubeSignOutOtherBoxes',
  // added at the integration of the lanes
  'errcYoutubeClientRefused',
  'errcUploadAbandoned',
  'liveStoppedUnattended',
  'liveWarnCameraH265',
];

Map<String, dynamic> _arb(String lang) =>
    jsonDecode(File('lib/l10n/app_$lang.arb').readAsStringSync())
        as Map<String, dynamic>;

void main() {
  final arb = {'ms': _arb('ms'), 'en': _arb('en'), 'ar': _arb('ar')};

  test('every new key exists, with text, in BM, EN and AR', () {
    expect(liveRevampKeys.toSet().length, liveRevampKeys.length);
    for (final lang in arb.keys) {
      for (final k in liveRevampKeys) {
        final v = arb[lang]![k];
        expect(v, isA<String>(), reason: '$lang $k');
        expect((v as String).trim(), isNotEmpty, reason: '$lang $k');
      }
    }
  });

  test('no long dash, arrow or approximation sign in any of them', () {
    final bad = RegExp('[‒–—―←-⇿≈~]');
    for (final lang in arb.keys) {
      for (final k in liveRevampKeys) {
        final v = arb[lang]![k] as String;
        expect(bad.hasMatch(v), isFalse, reason: '$lang $k: $v');
      }
    }
  });

  test('BM is Malaysian Malay: no Indonesian words, never "kotak"', () {
    final bad = RegExp(
      r'\b(kotak|bisa|unduh|mengunduh|unggah|mengunggah|butuh|membutuhkan|butuhkan|ponsel|silakan|sinyal|kamu|anda\s+bisa)\b',
      caseSensitive: false,
    );
    for (final k in liveRevampKeys) {
      final v = arb['ms']![k] as String;
      expect(bad.hasMatch(v), isFalse, reason: '$k: $v');
    }
  });

  test('"Kiosk Box" appears only as the whole product term', () {
    for (final lang in arb.keys) {
      for (final k in liveRevampKeys) {
        final v = arb[lang]![k] as String;
        for (final m in RegExp('Kiosk Box').allMatches(v)) {
          expect(v.substring(0, m.start).endsWith('MAXCOM '), isTrue, reason: '$lang $k');
        }
      }
    }
  });

  test('Arabic and English are real translations, not copies of BM', () {
    // The product name alone reads the same everywhere.
    const sameEverywhere = {'liveVideoPathBox'};
    for (final k in liveRevampKeys) {
      if (sameEverywhere.contains(k)) continue;
      expect(arb['en']![k], isNot(arb['ms']![k]), reason: 'en $k');
      expect(arb['ar']![k], isNot(arb['ms']![k]), reason: 'ar $k');
      expect(arb['ar']![k], isNot(arb['en']![k]), reason: 'ar $k');
      expect(RegExp('[؀-ۿ]').hasMatch(arb['ar']![k] as String), isTrue, reason: 'ar $k');
    }
  });

  test('the device is MAXCOM or the whole product term, never "peranti MAXCOM" (the app-wide rule)', () {
    final bad = RegExp('peranti maxcom|maxcom device|aplikasi surau', caseSensitive: false);
    for (final lang in arb.keys) {
      for (final k in liveRevampKeys) {
        expect(bad.hasMatch(arb[lang]![k] as String), isFalse, reason: '$lang $k');
      }
    }
  });

  test('the wording of the plan is carried (BM), with the device named MAXCOM', () {
    final s = SMs();
    expect(s.liveMineTitle, 'Siaran anda masih berjalan');
    expect(s.liveMineResume, 'Sambung semula');
    expect(s.liveMineStillSending, 'Siaran masih dihantar dari telefon ini');
    expect(s.liveStoppedCameraLost, 'Siaran dihentikan kerana kamera luaran terputus');
    expect(s.liveStoppedByBox, 'Siaran dihentikan oleh MAXCOM');
    expect(s.liveStoppedByAdmin, 'Siaran dihentikan oleh pentadbir');
    expect(s.liveVideoPathLabel, 'Video diambil oleh');
    expect(s.liveVideoPathDevice, 'Telefon ini');
    expect(s.liveVideoPathBox, 'MAXCOM Kiosk Box');
    expect(s.liveVideoPathBoxNote, 'Telefon hanya mengawal siaran. Rakaman pada telefon tidak tersedia.');
    expect(s.liveCameraHeavyWarn, 'Strim kamera terlalu besar untuk YouTube. Turunkan kepada 720p, 3 hingga 4 Mbps pada kamera.');
    expect(s.liveWarnWeakPhoneWifi, 'Isyarat Wi-Fi telefon lemah. Gambar mungkin tersekat.');
    expect(s.errcYoutubeLiveNotEnabled, 'Siaran langsung belum diaktifkan pada saluran YouTube ini.');
    expect(s.errcBoxClockWrong, 'Jam MAXCOM tidak tepat. Betulkan jam dan cuba lagi.');
    expect(s.errcYoutubeBusyOtherBox, 'YouTube sedang digunakan oleh MAXCOM Kiosk Box lain.');
    expect(s.liveNotifStop, 'Hentikan siaran');
    expect(s.syncBoxFailed, 'Tidak dapat menyelaras dengan MAXCOM');
    expect(s.settingsChangedElsewhereNow, 'Tetapan ini baru diubah pada peranti lain');
    expect(s.settingsReload, 'Muat semula');
    expect(s.settingsMaybeStale, 'Mungkin belum terkini');
    expect(s.cameraResetBody, 'Pilihan lanjutan akan dikembalikan kepada lalai. Kamera kekal dihidupkan.');
    expect(s.uploadReasonNoBox, 'Tidak dapat menghubungi MAXCOM');
    expect(s.uploadAwaitingConfirm, 'Menunggu pengesahan');
    expect(s.uploadErrorEmptyFile, 'Fail rakaman kosong');
    expect(s.uploadEarlierEntry, 'Muat naik rakaman terdahulu');
    expect(s.liveGapReplaceAsk(7), 'Siaran tadi terputus selama 7 minit. Gantikan dengan rakaman penuh?');
    expect(s.liveGapReplaceYes, 'Ganti');
    expect(s.liveGapReplaceNo, 'Tidak');
    expect(s.liveYoutubeSignOutOtherBoxes, 'MAXCOM Kiosk Box lain yang menggunakan akaun YouTube ini perlu disambung semula.');
    expect(s.errcYoutubeBroadcastOpen, 'Siaran YouTube belum ditutup. Cuba lagi dalam beberapa minit.');
    expect(s.liveDestUnconfirmed, 'Belum dapat disahkan dengan MAXCOM');
    expect(s.errcTooManyViewers, 'Had paparan siaran langsung telah dicapai');
  });

  test('Rakam with the box pull: the start screen and the summary both say why', () {
    for (final s in [SMs(), SEn(), SAr()]) {
      expect(s.liveRecNoBoxPullStart, contains('MAXCOM Kiosk Box'));
      expect(s.liveRecNoBoxPullSummary, contains('MAXCOM Kiosk Box'));
      expect(s.liveRecNoBoxPullStart, isNot(s.liveRecNoBoxPullSummary));
    }
    // BM names the reason (the phone gets no camera picture) and the way out (choose the phone).
    expect(SMs().liveRecNoBoxPullStart, contains('Rakam tidak ditawarkan'));
    expect(SMs().liveRecNoBoxPullStart, contains('Telefon ini'));
    expect(SMs().liveRecNoBoxPullSummary, contains('tidak dirakam'));
  });

  test('camera in use names the device and the time; minutes read well in English', () {
    expect(SMs().liveCameraInUseBy('Telefon Ujian', '8:15 mlm'), 'Kamera sedang digunakan oleh Telefon Ujian sejak 8:15 mlm.');
    expect(SEn().liveCameraInUseBy('Test phone', '8:15 pm'), contains('Test phone'));
    expect(SAr().liveCameraInUseBy('Test phone', '8:15'), contains('Test phone'));
    expect(SMs().liveCameraInUseByBox('8:15 mlm'), contains('8:15 mlm'));
    expect(SEn().liveGapReplaceAsk(1), contains('1 minute.'));
    expect(SEn().liveGapReplaceAsk(7), contains('7 minutes.'));
    expect(SAr().liveGapReplaceAsk(7), contains('7'));
  });
}
