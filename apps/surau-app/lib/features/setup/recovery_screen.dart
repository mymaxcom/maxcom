// Recovery from the box screen's QR (mockup screen 2, app side): the surau has
// no Pentadbir who can sign in. The would-be Pentadbir scans the recovery QR,
// types the recovery code written on paper, names themselves, chooses a PIN and
// becomes a NEW Pentadbir. The answer carries a NEW recovery code, shown once.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';
import '../../box/box_qr.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import '../enrol/enrol_flow.dart';
import '../enrol/join_errors.dart';
import '../enrol/pin_policy.dart';
import 'fingerprint_compare.dart';
import 'recovery_code_view.dart';
import 'setup_flow.dart';

enum _Step { loading, found, form, working, code, done, failed }

/// Keeps the recovery code to its alphabet (upper case, no spaces) and groups it `XXXX-XXXX-XXXX-XXXX` as it is typed
/// or pasted.
class RecoveryCodeFormatter extends TextInputFormatter {
  const RecoveryCodeFormatter();

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final raw = newValue.text.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    final clipped = raw.length > 16 ? raw.substring(0, 16) : raw;
    final b = StringBuffer();
    for (var i = 0; i < clipped.length; i++) {
      if (i > 0 && i % 4 == 0) b.write('-');
      b.write(clipped[i]);
    }
    final out = b.toString();
    return TextEditingValue(text: out, selection: TextSelection.collapsed(offset: out.length));
  }
}

/// The 16 symbols of a typed recovery code, or null when it is not 16 long.
String? normalisedRecoveryCode(String typed) {
  final raw = typed.toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
  return raw.length == 16 ? raw : null;
}

class RecoveryScreen extends StatefulWidget {
  const RecoveryScreen({
    super.key,
    required this.flow,
    required this.qrText,
    required this.defaultPhoneName,
    required this.onAdopt,
    required this.onDone,
    required this.onScanAnother,
    this.toLocal = _local,
  });

  final SetupFlow flow;
  final String qrText;
  final String defaultPhoneName;
  final void Function(EnrolledBox box) onAdopt;
  final VoidCallback onDone;
  final VoidCallback onScanAnother;
  final DateTime Function(DateTime) toLocal;

  static DateTime _local(DateTime t) => t.toLocal();

  @override
  State<RecoveryScreen> createState() => _RecoveryScreenState();
}

class _RecoveryScreenState extends State<RecoveryScreen> {
  _Step _step = _Step.loading;
  BoxInspection? _inspection;
  SetupOutcome? _outcome;
  Object? _failure;
  String? _error;
  String? _codeError;
  String? _pinError;

  /// The last send got no usable answer: the box may have committed. The button then reads `Cuba lagi`.
  bool _notConfirmed = false;

  final _code = TextEditingController();
  final _admin = TextEditingController();
  late final _phone = TextEditingController(text: widget.defaultPhoneName);
  final _pin = TextEditingController();
  final _pinAgain = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  @override
  void initState() {
    super.initState();
    _inspect();
  }

  @override
  void dispose() {
    for (final c in [_code, _admin, _phone, _pin, _pinAgain]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _inspect() async {
    setState(() {
      _step = _Step.loading;
      _failure = null;
    });
    try {
      final i = await widget.flow.inspect(widget.qrText, expect: ScannedKind.recovery);
      if (!mounted) return;
      setState(() {
        _inspection = i;
        _step = _Step.found;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _failure = e;
        _step = _Step.failed;
      });
    }
  }

  Future<void> _submit() async {
    final s = S.of(context);
    final code = normalisedRecoveryCode(_code.text);
    String? codeError;
    String? pinError;
    if (code == null) codeError = s.recoveryCodeShort;
    if (_pin.text != _pinAgain.text) {
      pinError = s.pinMismatch;
    } else if (!isValidPin(_pin.text)) {
      pinError = s.pinTooWeak;
    }
    final formOk = _formKey.currentState?.validate() ?? false;
    if (codeError != null || pinError != null || !formOk) {
      setState(() {
        _codeError = codeError;
        _pinError = pinError;
      });
      return;
    }
    setState(() {
      _codeError = null;
      _pinError = null;
      _error = null;
      _notConfirmed = false;
      _step = _Step.working;
    });
    try {
      final o = await widget.flow.recover(
        _inspection!,
        recoveryCode: code!,
        adminName: _admin.text,
        deviceName: _phone.text,
        pin: _pin.text,
      );
      if (!mounted) return;
      setState(() {
        _outcome = o;
        _step = _Step.code;
      });
    } on Object catch (e) {
      if (!mounted) return;
      if (e is SetupNotConfirmed) {
        // keep every value; the same step sends the same request again
        setState(() {
          _notConfirmed = true;
          _error = S.of(context).recoveryNotConfirmed;
          _step = _Step.form;
        });
        return;
      }
      setState(() {
        _failure = e;
        _step = _Step.failed;
      });
    }
  }

  void _finish() {
    final o = _outcome;
    if (o != null) widget.onAdopt(o.box);
    widget.onDone();
  }

  String? _required(String? v) => v == null || v.trim().isEmpty ? S.of(context).setupFieldRequired : null;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(s.recoverySubmit)),
      body: SurauTheme.page(children: [_body(context, s)]),
    );
  }

  Widget _body(BuildContext context, S s) {
    final text = Theme.of(context).textTheme;
    final info = _inspection?.info;
    switch (_step) {
      case _Step.loading:
      case _Step.working:
        return const Padding(
          padding: EdgeInsets.symmetric(vertical: 60),
          child: Center(child: CircularProgressIndicator(key: ValueKey('recovery-busy'))),
        );
      case _Step.failed:
        final f = _failure!;
        return JoinErrorView(
          error: f,
          expiredAt: f is BoxQrExpired ? f.expiredAt : null,
          toLocal: widget.toLocal,
          onRetry: _inspect,
          onScanAnother: widget.onScanAnother,
        );
      case _Step.found:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.recoveryFoundTitle, style: text.titleLarge),
            const SizedBox(height: 8),
            Text(s.recoveryFoundHint, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 14),
            RowsCard(
              children: [
                ListTile(title: Text(info!.name), subtitle: Text(info.boxIdGroups)),
              ],
            ),
            const SizedBox(height: 16),
            // Required before the recovery code or a PIN can be typed.
            FingerprintCompare(
              fingerprint: info.fingerprintGroups,
              keyPrefix: 'recovery-found',
              onSame: () => setState(() => _step = _Step.form),
              onDifferent: widget.onScanAnother,
            ),
          ],
        );
      case _Step.form:
        return Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(s.recoveryFoundTitle, style: text.titleLarge),
              const SizedBox(height: 8),
              Text(info!.name, style: text.titleSmall),
              const SizedBox(height: 16),
              TextField(
                key: const ValueKey('recovery-code-field'),
                controller: _code,
                inputFormatters: const [RecoveryCodeFormatter()],
                textCapitalization: TextCapitalization.characters,
                autocorrect: false,
                enableSuggestions: false,
                style: text.titleMedium!.copyWith(letterSpacing: 2, fontFeatures: const [FontFeature.tabularFigures()]),
                decoration: InputDecoration(
                  labelText: s.recoveryCodeField,
                  hintText: s.recoveryCodeFieldHint,
                  errorText: _codeError,
                ),
                onChanged: (_) {
                  if (_codeError != null) setState(() => _codeError = null);
                },
              ),
              if (info.linked) ...[
                const SizedBox(height: 8),
                Text(
                  s.recoveryLinkedHint,
                  key: const ValueKey('recovery-linked-hint'),
                  style: text.bodySmall!.copyWith(color: SurauColors.muted),
                ),
              ],
              const SizedBox(height: 16),
              TextFormField(
                key: const ValueKey('recovery-admin'),
                controller: _admin,
                textCapitalization: TextCapitalization.words,
                maxLength: 80,
                decoration: InputDecoration(labelText: s.setupYourName, hintText: s.setupYourNameHint, counterText: ''),
                validator: _required,
              ),
              const SizedBox(height: 14),
              TextFormField(
                key: const ValueKey('recovery-phone'),
                controller: _phone,
                textCapitalization: TextCapitalization.words,
                maxLength: 80,
                decoration: InputDecoration(labelText: s.setupPhoneName, counterText: ''),
                validator: _required,
              ),
              const SizedBox(height: 16),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: PinField(
                      key: const ValueKey('recovery-pin'),
                      controller: _pin,
                      label: s.enrolPinNewHint,
                      onChanged: (_) => setState(() => _pinError = null),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: PinField(
                      key: const ValueKey('recovery-pin-again'),
                      controller: _pinAgain,
                      label: s.enrolPinAgainLabel,
                      onChanged: (_) => setState(() => _pinError = null),
                    ),
                  ),
                ],
              ),
              if (_pinError != null) ...[const SizedBox(height: 10), ErrorLine(_pinError!)],
              if (_error != null) ...[const SizedBox(height: 10), ErrorLine(_error!)],
              const SizedBox(height: 20),
              FilledButton(
                key: ValueKey(_notConfirmed ? 'recovery-retry' : 'recovery-submit'),
                onPressed: _submit,
                child: Text(_notConfirmed ? s.actionRetry : s.recoverySubmit),
              ),
            ],
          ),
        );
      case _Step.code:
        return RecoveryCodeView(
          code: _outcome!.recoveryCode,
          title: s.recoveryCodeTitle,
          onContinue: () => setState(() => _step = _Step.done),
        );
      case _Step.done:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DoneLine(s.recoveryDoneTitle),
            const SizedBox(height: 20),
            FilledButton(key: const ValueKey('recovery-to-dashboard'), onPressed: _finish, child: Text(s.setupToDashboard)),
          ],
        );
    }
  }
}
