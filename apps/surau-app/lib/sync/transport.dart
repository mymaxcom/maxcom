// The real [SyncTransport]: locate a base (the box first with a short
// timeout, then the cloud) and pair it with a client and a session token.
// Also the per-host session tokens and the unlock against the located base
// (the challenge/unlock protocol is identical on the cloud).

import '../box/box_client.dart';
import '../box/cloud_origin.dart';
import '../box/device_key.dart';
import '../box/locator.dart';
import '../features/enrol/enrol_flow.dart' show EnrolledBox;
import '../features/unlock/biometric_pin.dart';
import '../features/unlock/unlock_flow.dart';
import 'sync_engine.dart';

/// Session tokens kept per base (`surau.session.<host>`), in memory only: a
/// restart unlocks again, as before. A token for the box is never offered to
/// the cloud, nor the other way round.
class SessionTokens {
  final Map<String, String> _tokens = {};

  static String hostKey(Uri base) =>
      'surau.session.${base.host}${base.hasPort ? ':${base.port}' : ''}';

  String? get(Uri base) => _tokens[hostKey(base)];

  void set(Uri base, String token) => _tokens[hostKey(base)] = token;

  void clear() => _tokens.clear();
}

/// The box with its base swapped, for building a client to the cloud with
/// the same pinned root CA. The cloud is always named ([cloudOriginOf]), so
/// a client to the cloud on its public domain uses the public roots.
EnrolledBox boxAt(EnrolledBox b, Uri base) => EnrolledBox(
  box: base,
  boxId: b.boxId,
  deviceId: b.deviceId,
  userId: b.userId,
  userName: b.userName,
  roles: b.roles,
  caSha256: b.caSha256,
  appLock: b.appLock,
  cloud: cloudOriginOf(b),
);

class LocatorTransport implements SyncTransport, CloudLinkSource {
  LocatorTransport({
    required this.locator,
    required this.box,
    required this.clientFor,
    required this.tokenFor,
  });

  final BoxLocator locator;
  final EnrolledBox Function() box;

  /// A pinned client for [base] (the box or the cloud origin).
  final Future<BoxClient> Function(Uri base) clientFor;

  /// The session token this device holds for [base], or null.
  final String? Function(Uri base) tokenFor;

  @override
  Future<SyncLink?> cloudLink() async {
    final cloud = box().cloud;
    if (cloud == null) return null;
    final token = tokenFor(cloud);
    if (token == null) return null;
    return SyncLink(
      base: cloud,
      via: 'cloud',
      client: await clientFor(cloud),
      token: token,
    );
  }

  @override
  Future<SyncLink> connect() async {
    final Located at;
    try {
      at = await locator.locate(box());
    } on CloudWaking catch (w) {
      throw CloudWakingSignal(retryAfterSec: w.retryAfterSec);
    } on BoxUnreachable {
      rethrow;
    } on BoxError catch (e) {
      throw BoxUnreachable(e);
    }
    final token = tokenFor(at.base);
    if (token == null) throw const NeedsUnlock();
    return SyncLink(
      base: at.base,
      via: at.via,
      client: await clientFor(at.base),
      token: token,
    );
  }
}

/// Unlocks against whichever base the locator finds: the challenge is posted
/// to `Located.base`, the session token is kept under that base's host.
/// Returns the located base with the session. [newPin], [sealPin] and
/// [onAppLock] are passed to [UnlockFlow.run] as the unlock screen uses them.
Future<({Located at, SessionDto session})> unlockAtLocated({
  required BoxLocator locator,
  required EnrolledBox box,
  required Future<BoxClient> Function(Uri base) clientFor,
  required DeviceKey key,
  required BiometricPin biometric,
  required SessionTokens tokens,
  String? pin,
  String? newPin,
  bool noPin = false,
  bool sealPin = false,
  Future<void> Function(bool appLock)? onAppLock,
  void Function(String? pin)? onPinAccepted,
}) async {
  final at = await locator.locate(box);
  final flow = UnlockFlow(
    client: await clientFor(at.base),
    key: key,
    box: box,
    biometric: biometric,
    onAppLock: onAppLock,
    onPinAccepted: onPinAccepted,
  );
  final SessionDto session;
  try {
    session = (await flow.run(
      pin: pin,
      newPin: newPin,
      noPin: noPin,
      sealPin: sealPin,
    )).issuedBy(at.base, at.via);
  } on UnlockRevoked {
    // The default cloud (the box never named one) answers "revoked" for a
    // device it has never seen: that is no verdict on this phone.
    if (at.via == 'cloud' && usesDefaultCloud(box)) {
      throw const BoxUnreachable('awan tidak mengenali peranti ini');
    }
    rethrow;
  }
  tokens.set(at.base, session.token);
  return (at: at, session: session);
}

/// The unlock screen's flow (Task 9): every attempt first locates a base
/// (MAXCOM at the surau within its short budget, else the cloud) and
/// unlocks there through [unlockAtLocated], so the app opens at home too.
/// [client] (the box's) is only the fallback the base class keeps; the
/// biometric path goes through [run] as well. A sleeping cloud
/// ([CloudWaking]) asks for a wake through [onWaking] before the refusal
/// reaches the screen.
class LocatedUnlockFlow extends UnlockFlow {
  LocatedUnlockFlow({
    required super.client,
    required super.key,
    required super.box,
    required super.biometric,
    super.onAppLock,
    required this.locator,
    required this.clientFor,
    required this.tokens,
    super.onPinAccepted,
    this.onLocated,
    this.onWaking,
  });

  final BoxLocator locator;
  final Future<BoxClient> Function(Uri base) clientFor;
  final SessionTokens tokens;

  /// Told where the unlock happened (`box` or `cloud`).
  final void Function(Located at)? onLocated;
  final void Function()? onWaking;

  @override
  Future<SessionDto> run({
    String? pin,
    String? newPin,
    bool noPin = false,
    bool sealPin = false,
  }) async {
    try {
      final out = await unlockAtLocated(
        locator: locator,
        box: box,
        clientFor: clientFor,
        key: key,
        biometric: biometric,
        tokens: tokens,
        pin: pin,
        newPin: newPin,
        noPin: noPin,
        sealPin: sealPin,
        onAppLock: onAppLock,
        onPinAccepted: onPinAccepted,
      );
      onLocated?.call(out.at);
      return out.session;
    } on CloudWaking {
      onWaking?.call();
      rethrow;
    }
  }
}
