// First setup from the box screen's QR (mockup screen 7): found, the form,
// confirm (with the fingerprint to compare against the TV), the PIN, the
// recovery code once, done. The phone becomes the surau's first Pentadbir.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../box/box_qr.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import '../enrol/enrol_flow.dart';
import '../enrol/join_errors.dart';
import '../enrol/pin_policy.dart';
import 'fingerprint_compare.dart';
import 'recovery_code_view.dart';
import 'setup_flow.dart';

enum _Step { loading, found, form, confirm, pin, working, code, done, failed }

class SetupScreen extends StatefulWidget {
  const SetupScreen({
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

  /// The `maxcom1:` text the phone scanned.
  final String qrText;

  /// Prefilled in "Nama telefon ini".
  final String defaultPhoneName;

  /// The person finished with the recovery code: the app now treats this phone as enrolled (and locks).
  final void Function(EnrolledBox box) onAdopt;

  /// "Ke papan pemuka".
  final VoidCallback onDone;
  final VoidCallback onScanAnother;
  final DateTime Function(DateTime) toLocal;

  static DateTime _local(DateTime t) => t.toLocal();

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  _Step _step = _Step.loading;
  BoxInspection? _inspection;
  SetupOutcome? _outcome;
  Object? _failure;
  String? _error;

  final _surau = TextEditingController();
  final _admin = TextEditingController();
  late final _phone = TextEditingController(text: widget.defaultPhoneName);
  final _box = TextEditingController();
  final _pin = TextEditingController();
  final _pinAgain = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  String? _pinError;

  /// The last send got no usable answer: the box may have committed. The button then reads `Cuba lagi`.
  bool _notConfirmed = false;

  @override
  void initState() {
    super.initState();
    _inspect();
  }

  @override
  void dispose() {
    for (final c in [_surau, _admin, _phone, _box, _pin, _pinAgain]) {
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
      final i = await widget.flow.inspect(widget.qrText, expect: ScannedKind.setup);
      if (!mounted) return;
      setState(() {
        _inspection = i;
        if (_box.text.isEmpty) _box.text = i.info.name;
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
    if (_pin.text != _pinAgain.text) {
      setState(() => _pinError = s.pinMismatch);
      return;
    }
    if (!isValidPin(_pin.text)) {
      setState(() => _pinError = s.pinTooWeak);
      return;
    }
    setState(() {
      _pinError = null;
      _error = null;
      _notConfirmed = false;
      _step = _Step.working;
    });
    try {
      final o = await widget.flow.run(
        _inspection!,
        surauName: _surau.text,
        adminName: _admin.text,
        deviceName: _phone.text,
        boxName: _box.text,
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
          _error = S.of(context).setupNotConfirmed;
          _step = _Step.pin;
        });
      } else if (classifyJoinError(e) != null) {
        setState(() {
          _failure = e;
          _step = _Step.failed;
        });
      } else {
        setState(() {
          _error = e is BoxError ? e.message : S.of(context).errorUnreachableHint;
          _step = _Step.pin;
        });
      }
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
      appBar: AppBar(title: Text(s.setupSubmit)),
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
          child: Center(child: CircularProgressIndicator(key: ValueKey('setup-busy'))),
        );
      case _Step.failed:
        final f = _failure!;
        return JoinErrorView(
          error: f,
          setup: true,
          expiredAt: f is BoxQrExpired ? f.expiredAt : null,
          toLocal: widget.toLocal,
          onRetry: _inspect,
          onScanAnother: widget.onScanAnother,
        );
      case _Step.found:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.setupFoundTitle, style: text.titleLarge),
            const SizedBox(height: 8),
            Text(s.setupFoundHint, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 16),
            RowsCard(
              children: [
                _Fact(label: s.setupBoxName, value: info!.name),
                _Fact(label: s.setupIdLabel, value: info.boxIdGroups),
                _Fact(label: '', value: s.setupNotSetUp),
              ],
            ),
            const SizedBox(height: 16),
            // Required before anything is typed: the fingerprint on the TV must be the one the phone shows.
            FingerprintCompare(
              fingerprint: info.fingerprintGroups,
              keyPrefix: 'setup-found',
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
              TextFormField(
                key: const ValueKey('setup-surau'),
                controller: _surau,
                textCapitalization: TextCapitalization.words,
                maxLength: 80,
                decoration: InputDecoration(labelText: s.setupSurauName, counterText: ''),
                validator: _required,
              ),
              const SizedBox(height: 14),
              TextFormField(
                key: const ValueKey('setup-admin'),
                controller: _admin,
                textCapitalization: TextCapitalization.words,
                maxLength: 80,
                decoration: InputDecoration(labelText: s.setupYourName, hintText: s.setupYourNameHint, counterText: ''),
                validator: _required,
              ),
              const SizedBox(height: 14),
              TextFormField(
                key: const ValueKey('setup-phone'),
                controller: _phone,
                textCapitalization: TextCapitalization.words,
                maxLength: 80,
                decoration: InputDecoration(labelText: s.setupPhoneName, counterText: ''),
                validator: _required,
              ),
              const SizedBox(height: 14),
              TextFormField(
                key: const ValueKey('setup-box'),
                controller: _box,
                textCapitalization: TextCapitalization.words,
                maxLength: 60,
                decoration: InputDecoration(labelText: s.setupBoxName, hintText: s.setupBoxNameHint, counterText: ''),
                validator: _required,
              ),
              const SizedBox(height: 20),
              FilledButton(
                key: const ValueKey('setup-form-continue'),
                onPressed: () {
                  if (_formKey.currentState?.validate() ?? false) setState(() => _step = _Step.confirm);
                },
                child: Text(s.actionContinue),
              ),
            ],
          ),
        );
      case _Step.confirm:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.setupConfirmTitle, style: text.titleLarge),
            const SizedBox(height: 8),
            Text(s.setupConfirmHint, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 16),
            RowsCard(
              children: [
                _Fact(label: s.setupSurauName, value: _surau.text.trim()),
                _Fact(label: s.setupYourName, value: _admin.text.trim()),
                _Fact(label: s.setupPhoneName, value: _phone.text.trim()),
                _Fact(label: s.setupBoxName, value: _box.text.trim()),
              ],
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: SurauColors.tealSoft.withValues(alpha: 0.55),
                borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    info!.fingerprintGroups,
                    key: const ValueKey('setup-confirm-fp'),
                    style: text.titleMedium!.copyWith(letterSpacing: 1.5, fontFeatures: const [FontFeature.tabularFigures()]),
                  ),
                  const SizedBox(height: 4),
                  Text(s.setupFingerprintHint, style: text.bodyMedium),
                ],
              ),
            ),
            const SizedBox(height: 10),
            Text(s.setupOnlyFirst, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 18),
            FilledButton(
              key: const ValueKey('setup-confirm-continue'),
              onPressed: () => setState(() => _step = _Step.pin),
              child: Text(s.actionContinue),
            ),
            TextButton(onPressed: () => setState(() => _step = _Step.form), child: Text(s.actionBack)),
          ],
        );
      case _Step.pin:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.enrolPinChoiceTitle, style: text.titleLarge),
            const SizedBox(height: 6),
            Text(s.enrolPinCreateHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 14),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: PinField(
                    key: const ValueKey('setup-pin'),
                    controller: _pin,
                    label: s.enrolPinNewHint,
                    autofocus: true,
                    onChanged: (_) => setState(() => _pinError = null),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: PinField(
                    key: const ValueKey('setup-pin-again'),
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
              key: ValueKey(_notConfirmed ? 'setup-retry' : 'setup-submit'),
              onPressed: _submit,
              child: Text(_notConfirmed ? s.actionRetry : s.setupSubmit),
            ),
            TextButton(onPressed: () => setState(() => _step = _Step.confirm), child: Text(s.actionBack)),
          ],
        );
      case _Step.code:
        return RecoveryCodeView(code: _outcome!.recoveryCode, onContinue: () => setState(() => _step = _Step.done));
      case _Step.done:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DoneLine(s.setupDoneTitle(_outcome!.surauName)),
            const SizedBox(height: 16),
            Text(s.setupDoneHint, style: text.titleSmall),
            const SizedBox(height: 8),
            RowsCard(
              children: [
                _Next(icon: Icons.person_add_alt_1_outlined, label: s.setupNextEnrol),
                _Next(icon: Icons.tv_outlined, label: s.setupNextPair),
                _Next(icon: Icons.cloud_outlined, label: s.setupNextLink),
              ],
            ),
            const SizedBox(height: 20),
            FilledButton(key: const ValueKey('setup-to-dashboard'), onPressed: _finish, child: Text(s.setupToDashboard)),
          ],
        );
    }
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (label.isNotEmpty) Text(label, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
          Text(value, style: text.titleSmall),
        ],
      ),
    );
  }
}

class _Next extends StatelessWidget {
  const _Next({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => ListTile(
    leading: Icon(icon, color: SurauColors.teal),
    title: Text(label),
  );
}
