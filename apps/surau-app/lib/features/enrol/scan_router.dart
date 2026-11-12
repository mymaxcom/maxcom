// One scan button for every QR the box and the Pentadbir show. The text tells
// what it is: `surau1:` an enrolment code, `maxcom1:` a setup, recovery or probe
// QR from the box screen. This class only decides and navigates; the pages do
// the work. A phone that already belongs to a surau is refused a setup, recovery
// or enrolment with the "leave first" explanation.

import '../../box/box_qr.dart';
import '../setup/setup_flow.dart';
import 'enrol_flow.dart';

sealed class ScanOutcome {
  const ScanOutcome();
}

/// The text names a page and the router went there.
class ScanNavigated extends ScanOutcome {
  const ScanNavigated(this.kind);

  final ScannedKind kind;
}

/// A probe QR was scanned and read, but the phone has not contacted anything yet: the person is shown [host] and
/// asked first. [confirm] then runs the probe (a [ScanProbeOk] or a [ScanFailed]).
class ScanProbeAsk extends ScanOutcome {
  const ScanProbeAsk(this.host, this.confirm);

  /// `<box-ip>:8443`: where the phone would connect.
  final String host;
  final Future<ScanOutcome> Function() confirm;
}

/// A probe QR: the phone reached the box and the box has noted it.
class ScanProbeOk extends ScanOutcome {
  const ScanProbeOk();
}

/// Something went wrong; [error] goes to the join error view.
class ScanFailed extends ScanOutcome {
  const ScanFailed(this.error);

  final Object error;
}

/// Not a MAXCOM QR at all.
class ScanUnknown extends ScanOutcome {
  const ScanUnknown();
}

typedef GoTo = void Function(String path, {Object? extra});

class ScanRouter {
  const ScanRouter({required this.enrolled, required this.go, required this.flow});

  /// True when this phone already belongs to a surau.
  final bool enrolled;
  final GoTo go;
  final SetupFlow flow;

  Future<ScanOutcome> route(String text) async {
    final kind = kindOf(text);
    switch (kind) {
      case ScannedKind.unknown:
        return const ScanUnknown();
      case ScannedKind.enrol:
      case ScannedKind.setup:
      case ScannedKind.recovery:
        if (enrolled) return const ScanFailed(EnrolAlreadyEnrolled());
        go(
          switch (kind) {
            ScannedKind.enrol => '/enrol',
            ScannedKind.setup => '/setup',
            _ => '/recovery',
          },
          extra: text.trim(),
        );
        return ScanNavigated(kind);
      case ScannedKind.probe:
        // A QR from paper, a picture or a message can name any address: nothing is contacted before the person has
        // seen the host and said yes.
        final String host;
        try {
          final p = BoxQrPayload.parse(text, requireCa: false);
          final u = Uri.parse(p.box);
          host = u.hasPort ? '${u.host}:${u.port}' : u.host;
          if (host.isEmpty) return const ScanFailed(BoxQrInvalid());
        } on Object catch (e) {
          return ScanFailed(e);
        }
        return ScanProbeAsk(host, () => _probe(text));
    }
  }

  Future<ScanOutcome> _probe(String text) async {
    try {
      await flow.probe(text.trim());
      return const ScanProbeOk();
    } on Object catch (e) {
      return ScanFailed(e);
    }
  }
}
