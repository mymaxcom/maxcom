// What the live notice sheet needs from the phone, behind one injectable
// object (tests fake it): is WhatsApp installed, send text and a picture, and
// delete the temporary picture. Plus the full-screen QR "Hantar dari telefon":
// a QR that opens `https://wa.me/?text=<notice>` on any phone that scans it,
// for an admin whose own device has no WhatsApp (an iPad, a computer).

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../finance/share.dart' as sh;
import '../finance/share.dart' show ShareResult;

abstract class LiveNoticePlatform {
  /// A browser (the iPad build): WhatsApp cannot be detected and the picture
  /// goes through the Web Share API.
  bool get isWeb;

  Future<bool> whatsAppInstalled();

  /// Text and an optional JPEG; aimed at WhatsApp when [toWhatsApp].
  Future<ShareResult> share(String text, {Uint8List? picture, bool toWhatsApp = false});

  /// Deletes the temporary picture file of an earlier share.
  Future<void> cleanTemp();
}

class _RealPlatform implements LiveNoticePlatform {
  _RealPlatform(this.isWeb);

  @override
  final bool isWeb;

  @override
  Future<bool> whatsAppInstalled() => isWeb ? Future.value(false) : sh.whatsAppInstalled();

  @override
  Future<ShareResult> share(String text, {Uint8List? picture, bool toWhatsApp = false}) =>
      picture == null && !toWhatsApp ? sh.shareText(text) : sh.shareNotice(text, picture: picture, toWhatsApp: toWhatsApp);

  @override
  Future<void> cleanTemp() => sh.cleanNotice();
}

final liveNoticePlatformProvider = Provider<LiveNoticePlatform>(
  (ref) => _RealPlatform(ref.watch(appDepsProvider).platform != 'android'),
);

/// Longest address a QR carries before the notice is shortened to its title
/// and link (a longer one is too dense to scan from a screen).
const int liveNoticeQrMaxLength = 700;

/// `https://wa.me/?text=<text>` (URL-encoded); when that is too long to scan,
/// the same with only [title] and [link].
String liveNoticeQrUrl(String text, {required String link, String? title}) {
  String url(String t) => 'https://wa.me/?text=${Uri.encodeComponent(t)}';
  final full = url(text);
  if (full.length <= liveNoticeQrMaxLength) return full;
  final t = (title ?? '').trim();
  return url(t.isEmpty ? link : '$t\n$link');
}

/// Opens the full-screen QR page for [data].
Future<void> showLiveNoticeQr(BuildContext context, {required String data, String? title}) {
  return Navigator.of(context, rootNavigator: true).push<void>(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => LiveNoticeQrPage(data: data, title: title),
    ),
  );
}

class LiveNoticeQrPage extends StatelessWidget {
  const LiveNoticeQrPage({super.key, required this.data, this.title});

  final String data;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Scaffold(
      key: const ValueKey('live-notice-qr-page'),
      appBar: AppBar(title: Text(s.liveNoticeFromPhone)),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (title != null && title!.isNotEmpty) ...[
                    Text(title!, style: text.titleLarge, textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                  ],
                  Container(
                    padding: const EdgeInsets.all(16),
                    color: Colors.white,
                    child: QrImageView(
                      key: const ValueKey('live-notice-qr'),
                      data: data,
                      size: 340,
                      backgroundColor: Colors.white,
                      errorCorrectionLevel: QrErrorCorrectLevel.M,
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    s.liveNoticeQrHint,
                    key: const ValueKey('live-notice-qr-hint'),
                    style: text.bodyLarge!.copyWith(color: SurauColors.muted),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 20),
                  TextButton(
                    key: const ValueKey('live-notice-qr-close'),
                    onPressed: () => Navigator.of(context).pop(),
                    child: Text(s.actionClose),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
