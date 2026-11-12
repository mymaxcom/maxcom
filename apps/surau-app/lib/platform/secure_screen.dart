// Blocks screenshots while a page that shows a secret (the recovery code) is open. Android sets FLAG_SECURE on
// the window through a tiny channel (android/.../SecureScreenChannel.kt). The web and iPad build cannot block a
// screenshot: both calls do nothing there, and the page shows its warning text instead.

import 'package:flutter/foundation.dart' show kIsWeb, visibleForTesting;
import 'package:flutter/services.dart';

class SecureScreen {
  const SecureScreen._();

  static const String channelName = 'my.maxcom/secure';

  static MethodChannel _channel = const MethodChannel(channelName);
  static bool _web = kIsWeb;

  /// Screenshots and the recent-apps thumbnail are blocked until [disable].
  static Future<void> enable() => _call('secure/enable');

  static Future<void> disable() => _call('secure/disable');

  static Future<void> _call(String method) async {
    if (_web) return;
    try {
      await _channel.invokeMethod<void>(method);
    } on MissingPluginException {
      // a platform without the channel (a desktop test run): nothing to block
    } on PlatformException {
      // blocking is best effort; the page still tells the person not to share the code
    }
  }

  @visibleForTesting
  static void debugOverride({MethodChannel? channel, bool? isWeb}) {
    if (channel != null) _channel = channel;
    if (isWeb != null) _web = isWeb;
  }

  @visibleForTesting
  static void debugReset() {
    _channel = const MethodChannel(channelName);
    _web = kIsWeb;
  }
}
