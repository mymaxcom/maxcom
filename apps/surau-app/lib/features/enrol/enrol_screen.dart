// Enrolment in three steps on the app's paper, named at the top of every
// view (Imbas kod, Semak, Tetapkan PIN) so a first-time user knows where
// they are. The one dark element is the glass card on the review step: the
// surau's name, "Assalamualaikum, <name>", their roles and who invited
// them, which is what the person should recognise before trusting the
// code. The box address and certificate fingerprint wait behind "Butiran
// teknikal" for the admin's comparison. Wherever a person can get stuck
// (expired invitation, camera failure, box away) the surau's helper
// appears with a call button.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../box/box_qr.dart';
import '../../box/payload.dart';
import '../../box/setup_client.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show confirmDialog;
import '../common/contact_links.dart';
import '../common/help_card.dart';
import '../common/identity.dart';
import '../common/payload_extras.dart';
import '../common/roles.dart';
import '../common/surau_info.dart';
import '../common/surau_logo.dart';
import '../common/time_words.dart';
import 'enrol_flow.dart';
import 'join_errors.dart';
import 'join_review.dart';
import 'pin_policy.dart';
import 'scan_router.dart';
import 'zxing_web.dart';

enum EnrolMode { scan, manual }

/// Builds the camera view; it calls [onCode] with every decoded text that
/// starts with `surau1:` or `maxcom1:` and [onCameraError] when the camera cannot be
/// opened (permission refused, no camera, browser without the scanner
/// script), after which the screen falls back to the paste field. The
/// default uses `mobile_scanner`; tests pass a placeholder.
typedef ScannerBuilder = Widget Function(
  BuildContext context,
  void Function(String code) onCode,
  VoidCallback onCameraError,
);

/// The surau logo of the box named in the invitation, with whether the
/// surau wants its name written beside it.
class LoadedLogo {
  const LoadedLogo(this.bytes, {this.showName = true});

  final Uint8List bytes;
  final bool showName;
}

/// Fetches the surau logo of the box named in the invitation (its public
/// `/surau-logo`), for the review card; null when there is none or the
/// box cannot be reached. The default asks nothing.
typedef LogoLoader = Future<LoadedLogo?> Function(Uri box);

Future<LoadedLogo?> noLogo(Uri box) async => null;

/// Asks the invitation's box who it is (`GET /api/box/info`), for the fingerprint shown before the join. Null when
/// it cannot answer.
typedef BoxInfoLoader = Future<BoxInfo?> Function(Uri box, String? caSha256);

Widget defaultScanner(
  BuildContext context,
  void Function(String) onCode,
  VoidCallback onCameraError,
) {
  // On web the QR reader is bundled under zxing/ and must be ready before
  // the scanner starts; prepareZxing never throws and is a no-op on Android.
  return FutureBuilder<void>(
    future: prepareZxing(),
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const ColoredBox(color: SurauColors.glass);
      }
      return MobileScanner(
        onDetect: (capture) {
          for (final b in capture.barcodes) {
            final v = b.rawValue;
            if (v != null && (v.startsWith('surau1:') || v.startsWith('maxcom1:'))) {
              onCode(v);
              return;
            }
          }
        },
        errorBuilder: (context, error) {
          WidgetsBinding.instance.addPostFrameCallback((_) => onCameraError());
          return const ColoredBox(color: SurauColors.glass);
        },
      );
    },
  );
}

class EnrolScreen extends StatefulWidget {
  const EnrolScreen({
    super.key,
    required this.flow,
    required this.cameraAvailable,
    required this.onEnrolled,
    this.scannerBuilder = defaultScanner,
    this.initialMode = EnrolMode.scan,
    this.initialCode,
    this.knownSurau,
    this.logoLoader = noLogo,
    this.pairingUi = false,
    this.onBoxQr,
    this.boxInfoLoader,
    this.openUrl = launchOutside,
    this.now = DateTime.now,
    this.toLocal = _toLocal,
  });

  final EnrolFlow flow;

  /// The surau logo for the review card, by the invitation's box.
  final LogoLoader logoLoader;

  /// Plan 14 look: the "not joined" start copy, "Sertai Surau X?" with the box's fingerprint, and the join error
  /// views. Off in the older tests; the app turns it on.
  final bool pairingUi;

  /// A scanned `maxcom1:` text (setup, recovery, probe): the router decides and navigates.
  final Future<ScanOutcome> Function(String text)? onBoxQr;

  /// Reads the invitation box's public identity for [JoinReview].
  final BoxInfoLoader? boxInfoLoader;

  /// False on a browser without `getUserMedia`: the paste field is shown
  /// and the scan button is hidden.
  final bool cameraAvailable;
  final void Function(EnrolOutcome outcome) onEnrolled;
  final ScannerBuilder scannerBuilder;
  final EnrolMode initialMode;

  /// Starts on the review view with this code (deep links, tests).
  final String? initialCode;

  /// The surau this device was enrolled with before (re-enrolment): lets
  /// the help card appear before any code is scanned.
  final SurauInfo? knownSurau;

  final UrlOpener openUrl;

  /// Clock and zone, injectable so goldens are stable.
  final DateTime Function() now;
  final DateTime Function(DateTime) toLocal;

  static DateTime _toLocal(DateTime t) => t.toLocal();

  @override
  State<EnrolScreen> createState() => _EnrolScreenState();
}

enum _View { capture, review, done }

class _EnrolScreenState extends State<EnrolScreen> {
  _View _view = _View.capture;
  late EnrolMode _mode;
  final _pasteCtl = TextEditingController();
  final _nameCtl = TextEditingController();
  final _pinCtl = TextEditingController();
  final _pinAgainCtl = TextEditingController();

  String? _code;

  /// The pasted code is shown as dots until the eye is pressed.
  bool _showCode = false;
  EnrolPayload? _payload;
  EnrolPayloadExtras _extras = EnrolPayloadExtras.none;
  bool? _hasPinAlready;
  bool _busy = false;
  bool _cameraFailed = false;

  /// Error under the paste field (capture) or above the button (review).
  String? _error;

  /// The capture view shows the help card with the error (expired code,
  /// camera failure) when a contact is known.
  bool _errorNeedsHelp = false;
  String? _nameError;
  String? _pinError;
  EnrolOutcome? _outcome;

  /// The invitation box's logo for the review card, asked once per box.
  Uint8List? _logo;
  bool _logoShowName = true;
  String? _logoBox;

  /// Plan 14: what the invitation's box says about itself, and any join error shown as a card.
  BoxInfo? _boxInfo;
  bool _boxMismatch = false;
  Object? _joinError;

  @override
  void initState() {
    super.initState();
    _mode = widget.cameraAvailable ? widget.initialMode : EnrolMode.manual;
    final code = widget.initialCode;
    if (code != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _accept(code));
    }
  }

  @override
  void dispose() {
    _pasteCtl.dispose();
    _nameCtl.dispose();
    _pinCtl.dispose();
    _pinAgainCtl.dispose();
    super.dispose();
  }

  bool get _scanPossible => widget.cameraAvailable && !_cameraFailed;

  /// The helper from the last payload read, else from the known surau.
  HelpContact? get _contact => _extras.help ?? widget.knownSurau?.help;

  String _surauName(S s) =>
      _extras.surau?.name ?? widget.knownSurau?.name ?? s.productName;

  void _onCameraError() {
    if (!mounted || _cameraFailed) return;
    setState(() {
      _cameraFailed = true;
      _mode = EnrolMode.manual;
    });
  }

  bool _probeAsking = false; // the camera keeps scanning behind the question

  Future<void> _routeBoxQr(String code) async {
    if (_probeAsking) return;
    final s = S.of(context);
    final router = widget.onBoxQr!;
    var outcome = await router(code);
    if (!mounted) return;
    if (outcome is ScanProbeAsk) {
      final ask = outcome;
      _probeAsking = true;
      final yes = await confirmDialog(
        context,
        title: s.probeAskTitle,
        body: s.probeAskBody(ask.host),
        confirm: s.probeAskConfirm,
      );
      _probeAsking = false;
      if (!mounted || !yes) return;
      outcome = await ask.confirm();
      if (!mounted) return;
    }
    switch (outcome) {
      case ScanProbeAsk():
        break;
      case ScanNavigated():
        break;
      case ScanProbeOk():
        setState(() {
          _joinError = null;
          _error = null;
        });
        ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(SnackBar(content: Text(s.probeOk)));
      case ScanFailed(:final error):
        setState(() {
          _joinError = error;
          _error = null;
        });
      case ScanUnknown():
        setState(() {
          _joinError = null;
          _error = s.scanUnknown;
        });
    }
  }

  void _accept(String code) {
    if (_view != _View.capture) return;
    final s = S.of(context);
    if (widget.onBoxQr != null) {
      final kind = kindOf(code);
      if (kind == ScannedKind.setup || kind == ScannedKind.recovery || kind == ScannedKind.probe) {
        _routeBoxQr(code);
        return;
      }
    }
    // The people-and-place fields are read first so an expired invitation
    // can still name the surau and its helper.
    final extras = EnrolPayloadExtras.parse(code);
    try {
      final payload = widget.flow.inspect(code);
      setState(() {
        _code = code.trim();
        _payload = payload;
        // A box with its app lock off asks for no PIN at all.
        _hasPinAlready = payload.appLock == false ? true : payload.pinSet;
        _extras = extras;
        _view = _View.review;
        _error = null;
        _errorNeedsHelp = false;
      });
      _loadLogo(payload.box);
      _loadBoxInfo(payload);
    } on FormatException catch (e) {
      setState(() {
        _error = e.message;
        _errorNeedsHelp = false;
      });
    } on EnrolExpired {
      setState(() {
        _extras = extras;
        _error = s.enrolExpired;
        _errorNeedsHelp = true;
      });
    }
  }

  /// The review card's logo: the invitation box's own, if it has one and
  /// answers. A failure simply leaves the card without a logo.
  void _loadLogo(String box) {
    if (_logoBox == box) return;
    _logoBox = box;
    _logo = null;
    final uri = Uri.tryParse(box);
    if (uri == null) return;
    widget.logoLoader(uri).then((loaded) {
      if (!mounted || loaded == null || _logoBox != box) return;
      setState(() {
        _logo = loaded.bytes;
        _logoShowName = loaded.showName;
      });
    }, onError: (Object _) {});
  }

  /// The box's own identity for the review card; a different box id than the invitation names stops the join.
  void _loadBoxInfo(EnrolPayload payload) {
    final loader = widget.boxInfoLoader;
    if (loader == null) return;
    _boxInfo = null;
    _boxMismatch = false;
    loader(Uri.parse(payload.box), payload.caSha256).then((info) {
      if (!mounted || _payload?.box != payload.box || info == null) return;
      setState(() {
        _boxInfo = info;
        _boxMismatch = info.boxId != payload.boxId;
      });
    }, onError: (Object _) {});
  }

  void _backToCapture() {
    setState(() {
      _joinError = null;
      _boxInfo = null;
      _boxMismatch = false;
      _view = _View.capture;
      _code = null;
      _payload = null;
      _hasPinAlready = null;
      _error = null;
      _errorNeedsHelp = false;
      _pinError = null;
      _nameError = null;
      _pinCtl.clear();
      _pinAgainCtl.clear();
    });
  }

  Future<void> _enrol() async {
    final s = S.of(context);
    final name = _nameCtl.text.trim();
    final hasPin = _hasPinAlready;
    String? nameError;
    String? pinError;
    String? error;
    if (name.isEmpty) nameError = s.enrolDeviceNameRequired;
    if (hasPin == null) {
      error = s.enrolPinChoiceTitle;
    } else if (!hasPin) {
      if (_pinCtl.text != _pinAgainCtl.text) {
        pinError = s.pinMismatch;
      } else if (!isValidPin(_pinCtl.text)) {
        pinError = s.pinTooWeak;
      }
    }
    if (nameError != null || pinError != null || error != null) {
      setState(() {
        _nameError = nameError;
        _pinError = pinError;
        _error = error == null ? null : s.enrolPinChoiceTitle;
        _errorNeedsHelp = false;
      });
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
      _errorNeedsHelp = false;
      _nameError = null;
      _pinError = null;
    });
    try {
      final outcome = await widget.flow.run(
        _code!,
        deviceName: name,
        hasPinAlready: hasPin!,
        newPin: hasPin ? null : _pinCtl.text,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _outcome = outcome;
        _view = _View.done;
      });
    } on EnrolFailure catch (e) {
      if (!mounted) return;
      if (_showAsCard(e)) return;
      setState(() {
        _busy = false;
        _error = switch (e) {
          EnrolExpired() => s.enrolExpired,
          EnrolPinTooWeak() => s.pinTooWeak,
          EnrolPinExists() => s.enrolPinExists,
          EnrolAlreadyEnrolled() => s.enrolAlreadyEnrolled,
        };
        _errorNeedsHelp = e is EnrolExpired;
      });
    } on TrustError catch (e) {
      if (!mounted) return;
      if (_showAsCard(e)) return;
      setState(() {
        _busy = false;
        _error = e.message;
        _errorNeedsHelp = true;
      });
    } on BoxUnreachable catch (e) {
      if (!mounted) return;
      if (_showAsCard(e)) return;
      setState(() {
        _busy = false;
        _error = s.errorUnreachableNamed(_surauName(s));
        _errorNeedsHelp = true;
      });
    } on BoxError catch (e) {
      if (!mounted) return;
      if (_showAsCard(e)) return;
      setState(() {
        _busy = false;
        _error = e.message;
        _errorNeedsHelp = false;
      });
    } on StateError catch (e) {
      // deviceKeySelfCheck: the store returned a bad key.
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
        _errorNeedsHelp = true;
      });
    }
  }

  /// Plan 14: an expired or used code, a phone that already belongs to a surau, a box that cannot be reached are
  /// explained on a card with the next step, not as one red line.
  bool _showAsCard(Object e) {
    if (!widget.pairingUi || classifyJoinError(e) == null) return false;
    setState(() {
      _busy = false;
      _joinError = e;
      _error = null;
      _errorNeedsHelp = false;
    });
    return true;
  }

  Widget _joinErrorCard() => JoinErrorView(
    error: _joinError!,
    currentSurau: widget.knownSurau?.name,
    cloud: _payload?.cloud == null ? null : Uri.tryParse(_payload!.cloud!),
    expiredAt: _payload == null ? null : DateTime.fromMillisecondsSinceEpoch(_payload!.exp, isUtc: true),
    toLocal: widget.toLocal,
    onRetry: _view == _View.review ? _enrol : null,
    onScanAnother: _view == _View.review ? _backToCapture : () => setState(() => _joinError = null),
  );

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.enrolTitle)),
      body: switch (_view) {
        _View.capture => _buildCapture(context, s),
        _View.review => _buildReview(context, s),
        _View.done => _buildDone(context, s),
      },
    );
  }

  /// Two steps when the box has its app lock off (no PIN to choose).
  Widget _steps(S s, int current) => _Steps(
    labels: [
      s.enrolStepScan,
      s.enrolStepReview,
      if (_payload?.appLock != false) s.enrolStepPin,
    ],
    current: current,
  );

  // ---- capture ----

  Widget _buildCapture(BuildContext context, S s) {
    final text = Theme.of(context).textTheme;
    final scanning = _mode == EnrolMode.scan && _scanPossible;
    final helpHere = (_errorNeedsHelp || _cameraFailed) && _contact != null;
    return SurauTheme.page(
      children: [
        _steps(s, 1),
        const SizedBox(height: 24),
        if (widget.pairingUi) ...[
          Text(s.startNotJoined, style: text.titleLarge),
          const SizedBox(height: 8),
          Text(s.startSetupHint, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 4),
          Text(s.startJoinHint, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 20),
        ],
        if (_joinError != null) ...[_joinErrorCard(), const SizedBox(height: 20)],
        if (scanning) ...[
          Text(s.enrolScanHint, style: text.titleMedium),
          if (widget.pairingUi) ...[
            const SizedBox(height: 6),
            Text(s.scanOnlyTvQr, key: const ValueKey('scan-only-tv'), style: text.bodyMedium),
          ],
          const SizedBox(height: 16),
          _Viewfinder(
            child: widget.scannerBuilder(context, _accept, _onCameraError),
          ),
          const SizedBox(height: 20),
          OutlinedButton.icon(
            onPressed: () => setState(() => _mode = EnrolMode.manual),
            icon: const Icon(Icons.keyboard_outlined),
            label: Text(s.enrolManualButton),
          ),
        ] else ...[
          Text(
            _scanPossible ? s.enrolManualHint : s.enrolCameraUnavailable,
            style: text.titleMedium,
          ),
          const SizedBox(height: 16),
          TextField(
            key: const ValueKey('enrol-code-field'),
            controller: _pasteCtl,
            obscureText: !_showCode,
            obscuringCharacter: '●',
            maxLines: 1,
            autocorrect: false,
            enableSuggestions: false,
            keyboardType: TextInputType.visiblePassword,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _accept(_pasteCtl.text),
            style: text.bodyMedium!.copyWith(
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
            decoration: InputDecoration(
              labelText: s.enrolPasteLabel,
              hintText: s.enrolPasteHint,
              errorText: _error,
              errorMaxLines: 3,
              suffixIcon: IconButton(
                key: const ValueKey('enrol-code-eye'),
                tooltip: _showCode ? s.enrolCodeHide : s.enrolCodeShow,
                icon: Icon(
                  _showCode
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                ),
                onPressed: () => setState(() => _showCode = !_showCode),
              ),
            ),
            onChanged: (_) {
              if (_error != null) {
                setState(() {
                  _error = null;
                  _errorNeedsHelp = false;
                });
              }
            },
          ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: () => _accept(_pasteCtl.text),
            child: Text(s.actionContinue),
          ),
          if (_scanPossible) ...[
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: () => setState(() {
                _mode = EnrolMode.scan;
                _error = null;
                _errorNeedsHelp = false;
              }),
              icon: const Icon(Icons.qr_code_scanner),
              label: Text(s.enrolScanButton),
            ),
          ],
        ],
        if (scanning && _error != null) ...[
          const SizedBox(height: 12),
          _ErrorLine(_error!),
        ],
        if (helpHere) ...[
          const SizedBox(height: 20),
          HelpCard(contact: _contact, openUrl: widget.openUrl),
        ],
      ],
    );
  }

  // ---- review ----

  Widget _newPinFields(S s) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 14, 0, 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: _PinField(
              controller: _pinCtl,
              label: s.enrolPinNewHint,
              autofocus: true,
              onChanged: _clearPinError,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _PinField(
              controller: _pinAgainCtl,
              label: s.enrolPinAgainLabel,
              onChanged: _clearPinError,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildReview(BuildContext context, S s) {
    final text = Theme.of(context).textTheme;
    final p = _payload!;
    final x = _extras;
    final expiry = widget.toLocal(
      DateTime.fromMillisecondsSinceEpoch(p.exp, isUtc: true),
    );
    final when = whenWords(expiry, today: widget.toLocal(widget.now()));
    final invitedBy = x.invitedBy;
    final note = invitedBy != null
        ? s.invitedByUntil(invitedBy, when)
        : s.validUntil(when);
    return SurauTheme.page(
      children: [
        _steps(s, 2),
        const SizedBox(height: 24),
        Text(s.enrolReviewHint, style: text.titleMedium),
        const SizedBox(height: 14),
        if (widget.pairingUi) ...[
          JoinReview(
            surau: _surauName(s),
            greetingName: p.user,
            validUntil: when,
            invitedBy: invitedBy,
            boxName: _boxInfo?.name,
            boxIdGroups: _boxInfo?.boxIdGroups,
            fingerprintGroups: _boxInfo?.fingerprintGroups,
          ),
          if (_boxMismatch) ...[const SizedBox(height: 12), _ErrorLine(s.errMismatch)],
          const SizedBox(height: 14),
        ],
        _GlassCard(
          child: SurauIdentity(
            surauName: _surauName(s),
            logo: _logo == null
                ? null
                : LogoImage(
                    bytes: _logo,
                    height: 56,
                    maxWidth: 260,
                    radius: 12,
                  ),
            showName: _logoShowName,
            greeting: s.greeting(p.user),
            roles: rolesSentence(s, x.roles),
            note: widget.pairingUi ? null : note,
            centered: false,
          ),
        ),
        const SizedBox(height: 24),
        TextField(
          controller: _nameCtl,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.next,
          maxLength: 40,
          decoration: InputDecoration(
            labelText: s.enrolDeviceNameLabel,
            hintText: s.enrolDeviceNameHint,
            errorText: _nameError,
            counterText: '',
          ),
          onChanged: (_) {
            if (_nameError != null) setState(() => _nameError = null);
          },
        ),
        const SizedBox(height: 24),
        if (p.appLock == false)
          _NoLockNote(text: s.appLockEnrolHint)
        else ...[
          Text(s.enrolPinChoiceTitle, style: text.titleSmall),
          const SizedBox(height: 10),
          if (p.pinSet == true)
            Text(s.enrolPinKnownSet, style: text.bodyMedium)
          else if (p.pinSet == false) ...[
            Text(s.enrolPinKnownNew, style: text.bodyMedium),
            _newPinFields(s),
          ] else ...[
            _ChoiceTile(
              selected: _hasPinAlready == true,
              title: s.enrolPinHaveOne,
              hint: s.enrolPinHaveOneHint,
              onTap: () => setState(() {
                _hasPinAlready = true;
                _error = null;
                _errorNeedsHelp = false;
                _pinError = null;
              }),
            ),
            const SizedBox(height: 10),
            _ChoiceTile(
              selected: _hasPinAlready == false,
              title: s.enrolPinCreate,
              hint: s.enrolPinCreateHint,
              onTap: () => setState(() {
                _hasPinAlready = false;
                _error = null;
                _errorNeedsHelp = false;
              }),
              child: _hasPinAlready == false ? _newPinFields(s) : null,
            ),
          ],
        ],
        if (_pinError != null) ...[
          const SizedBox(height: 10),
          _ErrorLine(_pinError!),
        ],
        const SizedBox(height: 16),
        TechnicalDetails(
          boxAddress: p.box,
          fingerprint: EnrolledBox.fingerprintOf(p.caSha256),
        ),
        if (_joinError != null) ...[const SizedBox(height: 16), _joinErrorCard()],
        if (_error != null) ...[
          const SizedBox(height: 16),
          _ErrorLine(_error!),
          if (_errorNeedsHelp) ...[
            const SizedBox(height: 12),
            HelpCard(contact: _contact, openUrl: widget.openUrl),
          ],
        ],
        const SizedBox(height: 24),
        FilledButton(
          onPressed: _busy || _boxMismatch ? null : _enrol,
          child: _busy
              ? Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: SurauColors.ink,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Text(s.enrolWorking),
                  ],
                )
              : Text(widget.pairingUi ? s.joinYes : s.enrolSubmit),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: _busy ? null : _backToCapture,
          child: Text(widget.pairingUi ? s.joinNo : s.enrolAnother),
        ),
      ],
    );
  }

  void _clearPinError(String _) {
    if (_pinError != null) setState(() => _pinError = null);
  }

  // ---- done ----

  Widget _buildDone(BuildContext context, S s) {
    final text = Theme.of(context).textTheme;
    final o = _outcome!;
    return SurauTheme.page(
      children: [
        _steps(s, 4),
        const SizedBox(height: 36),
        Center(
          child: Container(
            width: 84,
            height: 84,
            decoration: const BoxDecoration(
              color: SurauColors.tealSoft,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.check_rounded,
              size: 48,
              color: SurauColors.teal,
            ),
          ),
        ),
        const SizedBox(height: 20),
        Text(
          s.enrolDone,
          textAlign: TextAlign.center,
          style: text.headlineSmall,
        ),
        const SizedBox(height: 8),
        Text(
          '${o.box.userName}\n${o.surau?.name ?? _surauName(s)}',
          textAlign: TextAlign.center,
          style: text.bodyLarge!.copyWith(color: SurauColors.muted),
        ),
        const SizedBox(height: 20),
        Container(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
          decoration: BoxDecoration(
            color: o.pinPending ? SurauColors.goldSoft : SurauColors.card,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
            border: o.pinPending ? null : Border.all(color: SurauColors.line),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(
                  o.pinPending ? Icons.pin_outlined : Icons.lock_open_rounded,
                  color: o.pinPending ? SurauColors.ink : SurauColors.teal,
                  size: 22,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  o.pinPending
                      ? s.enrolPinPending
                      : (o.box.appLock
                            ? s.enrolDoneHint
                            : s.enrolDoneHintNoLock),
                  style: text.bodyMedium!.copyWith(
                    color: o.pinPending ? SurauColors.ink : SurauColors.text,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 28),
        FilledButton(
          onPressed: () => widget.onEnrolled(o),
          child: Text(s.actionContinue),
        ),
      ],
    );
  }
}

/// Review step on a box with the app lock off: where the PIN choice would
/// be, one calm line saying there is none.
class _NoLockNote extends StatelessWidget {
  const _NoLockNote({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('enrol-no-lock'),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: SurauColors.card,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        border: Border.all(color: SurauColors.line),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 2),
            child: Icon(
              Icons.lock_open_rounded,
              color: SurauColors.teal,
              size: 22,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}

/// The three steps as a row of numbered marks with short names; the
/// current one is filled, the ones before it ticked. Enrolment really is a
/// sequence, so numbers belong here.
class _Steps extends StatelessWidget {
  const _Steps({required this.labels, required this.current});

  final List<String> labels;

  /// 1-based; a value past the end marks every step done.
  final int current;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Row(
      children: [
        for (var i = 0; i < labels.length; i++) ...[
          if (i > 0)
            Expanded(
              child: Container(
                height: 2,
                margin: const EdgeInsets.symmetric(horizontal: 8),
                color: i < current ? SurauColors.teal : SurauColors.line,
              ),
            ),
          _StepMark(
            number: i + 1,
            label: labels[i],
            state: i + 1 < current
                ? _StepState.done
                : i + 1 == current
                ? _StepState.current
                : _StepState.ahead,
            style: text,
          ),
        ],
      ],
    );
  }
}

enum _StepState { done, current, ahead }

class _StepMark extends StatelessWidget {
  const _StepMark({
    required this.number,
    required this.label,
    required this.state,
    required this.style,
  });

  final int number;
  final String label;
  final _StepState state;
  final TextTheme style;

  @override
  Widget build(BuildContext context) {
    final filled = state != _StepState.ahead;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: filled ? SurauColors.teal : Colors.transparent,
            border: filled
                ? null
                : Border.all(color: SurauColors.outline, width: 1.5),
          ),
          child: Center(
            child: state == _StepState.done
                ? const Icon(Icons.check_rounded, size: 18, color: Colors.white)
                : Text(
                    '$number',
                    style: style.labelMedium!.copyWith(
                      color: filled ? Colors.white : SurauColors.muted,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
          ),
        ),
        const SizedBox(width: 8),
        Text(
          label,
          style: style.labelMedium!.copyWith(
            color: state == _StepState.current
                ? SurauColors.text
                : SurauColors.muted,
          ),
        ),
      ],
    );
  }
}

/// The kiosk's glass as a card on the paper, for the identity block.
class _GlassCard extends StatelessWidget {
  const _GlassCard({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 22),
      decoration: BoxDecoration(
        color: SurauColors.glass,
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        border: Border.all(color: SurauColors.goldHairline),
      ),
      child: child,
    );
  }
}

/// A 6-digit PIN field: numbers only, hidden, large tabular digits.
class _PinField extends StatelessWidget {
  const _PinField({
    required this.controller,
    required this.label,
    required this.onChanged,
    this.autofocus = false,
  });

  final TextEditingController controller;
  final String label;
  final void Function(String) onChanged;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return TextField(
      controller: controller,
      autofocus: autofocus,
      obscureText: true,
      obscuringCharacter: '●',
      keyboardType: TextInputType.number,
      inputFormatters: [
        FilteringTextInputFormatter.digitsOnly,
        LengthLimitingTextInputFormatter(pinLength),
      ],
      autocorrect: false,
      enableSuggestions: false,
      textAlign: TextAlign.center,
      style: text.titleLarge!.copyWith(
        letterSpacing: 6,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
      decoration: InputDecoration(
        labelText: label,
        floatingLabelAlignment: FloatingLabelAlignment.center,
      ),
      onChanged: onChanged,
    );
  }
}

/// A square camera window with gold corner brackets, the kiosk's hairline
/// turned into a viewfinder.
class _Viewfinder extends StatelessWidget {
  const _Viewfinder({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 340),
        child: AspectRatio(
          aspectRatio: 1,
          child: Stack(
            fit: StackFit.expand,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
                child: ColoredBox(color: SurauColors.glass, child: child),
              ),
              IgnorePointer(child: CustomPaint(painter: _BracketPainter())),
            ],
          ),
        ),
      ),
    );
  }
}

class _BracketPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = SurauColors.gold
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    const inset = 22.0;
    const arm = 34.0;
    const r = 10.0;
    final w = size.width;
    final h = size.height;

    void corner(Offset c, double sx, double sy) {
      final path = Path()
        ..moveTo(c.dx + sx * arm, c.dy)
        ..lineTo(c.dx + sx * r, c.dy)
        ..arcToPoint(
          Offset(c.dx, c.dy + sy * r),
          radius: const Radius.circular(r),
          clockwise: sx * sy < 0,
        )
        ..lineTo(c.dx, c.dy + sy * arm);
      canvas.drawPath(path, paint);
    }

    corner(const Offset(inset, inset), 1, 1);
    corner(Offset(w - inset, inset), -1, 1);
    corner(Offset(inset, h - inset), 1, -1);
    corner(Offset(w - inset, h - inset), -1, -1);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// A selectable card with a drawn radio mark; [child] (the PIN fields)
/// appears inside the selected tile.
class _ChoiceTile extends StatelessWidget {
  const _ChoiceTile({
    required this.selected,
    required this.title,
    required this.hint,
    required this.onTap,
    this.child,
  });

  final bool selected;
  final String title;
  final String hint;
  final VoidCallback onTap;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Material(
      color: selected
          ? SurauColors.tealSoft.withValues(alpha: 0.55)
          : SurauColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        side: BorderSide(
          color: selected ? SurauColors.teal : SurauColors.line,
          width: selected ? 2 : 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: _RadioMark(selected: selected),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: text.titleSmall),
                        const SizedBox(height: 2),
                        Text(
                          hint,
                          style: text.bodyMedium!.copyWith(
                            color: SurauColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              ?child,
            ],
          ),
        ),
      ),
    );
  }
}

class _RadioMark extends StatelessWidget {
  const _RadioMark({required this.selected});

  final bool selected;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 120),
      width: 22,
      height: 22,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(
          color: selected ? SurauColors.teal : SurauColors.outline,
          width: selected ? 7 : 1.5,
        ),
      ),
    );
  }
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: SurauColors.dangerSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Text(
        text,
        style: style.bodyMedium!.copyWith(color: SurauColors.dangerInk),
      ),
    );
  }
}
