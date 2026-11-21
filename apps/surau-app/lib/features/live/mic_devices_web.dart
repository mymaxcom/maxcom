// The browser's microphones: `enumerateDevices` (audioinput) and the
// `devicechange` event. Labels are empty until the page has microphone
// permission; the watcher waits for them.
import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import 'mic_watch.dart';

MicDevices? browserMicDevices() => BrowserMicDevices();

class BrowserMicDevices implements MicDevices {
  @override
  Future<bool> headphonesWithoutMic() async => false;

  @override
  Duration? get pollEvery => const Duration(seconds: 10);

  @override
  Stream<void> get changes {
    final c = StreamController<void>.broadcast();
    final devices = web.window.navigator.mediaDevices;
    final fn = ((web.Event _) {
      if (!c.isClosed) c.add(null);
    }).toJS;
    c.onListen = () => devices.addEventListener('devicechange', fn);
    c.onCancel = () => devices.removeEventListener('devicechange', fn);
    return c.stream;
  }

  @override
  Future<List<MicInfo>> list() async {
    final all = await web.window.navigator.mediaDevices.enumerateDevices().toDart;
    return [
      for (final d in all.toDart)
        if (d.kind == 'audioinput') MicInfo(deviceId: d.deviceId, label: d.label),
    ];
  }
}
