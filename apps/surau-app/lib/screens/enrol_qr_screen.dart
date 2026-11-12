// Daftar peranti: the admin names the person's new device, the box makes
// a one-time code (`POST /api/enrol/begin`) and this page shows it as the
// QR the person scans on their own phone or iPad, with the code in large
// letters for typing, how long it is still good for, `Salin kod`, and
// the certificate fingerprint behind the same collapsed `Butiran teknikal`
// the enrolling person has on their screen (operator rule 2026-11-04: no
// certificate wording on normal screens; the fingerprint lives only inside
// the technical details).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/payload.dart';
import '../box/setup_client.dart' show EnrolCodeStatus;
import '../features/setup/setup_providers.dart';
import '../features/sync/live_only_dialog.dart';
import '../box/wire.dart';
import '../features/common/help_card.dart' show DetailRow, TechnicalDetails;
import '../features/enrol/enrol_flow.dart';
import '../l10n/generated/s.dart';
import 'users_screen.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

class EnrolQrScreen extends StatelessWidget {
  const EnrolQrScreen({super.key, required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return ShellPage(
      title: s.enrolQrTitle,
      body: SurauTheme.page(
        children: [
          BoxReadView(
            path: usersPath,
            builder: (context, body) {
              final user = parseUsers(body)
                  .where((u) => u.id == userId)
                  .firstOrNull;
              if (user == null) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 28),
                  child: Text(
                    s.userNotFound,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                );
              }
              return _EnrolQrBody(user: user);
            },
          ),
        ],
      ),
    );
  }
}

/// `POST /api/enrol/begin`'s answer.
class _Invitation {
  const _Invitation({
    required this.code,
    required this.expiresAt,
    required this.payload,
  });

  final String code;
  final DateTime expiresAt;
  final String payload;
}

class _EnrolQrBody extends ConsumerStatefulWidget {
  const _EnrolQrBody({required this.user});

  final UserDto user;

  @override
  ConsumerState<_EnrolQrBody> createState() => _EnrolQrBodyState();
}

class _EnrolQrBodyState extends ConsumerState<_EnrolQrBody> {
  final _name = TextEditingController();
  String? _nameError;
  String? _error;
  bool _busy = false;
  _Invitation? _invitation;

  /// Always opens at 10: a longer code is a deliberate choice each time.
  int _ttl = 10;

  Timer? _ticker;
  String _countdown = '';
  bool _expired = false;

  @override
  void dispose() {
    _ticker?.cancel();
    _name.dispose();
    super.dispose();
  }

  Future<void> _begin() async {
    final s = S.of(context);
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _nameError = s.enrolDeviceNameRequired);
      return;
    }
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _busy = true;
      _error = null;
      _nameError = null;
    });
    try {
      final out = await gateway.post('/api/enrol/begin', {
        'userId': widget.user.id,
        'deviceName': name,
        'ttlMinutes': _ttl,
      });
      if (!mounted) return;
      final inv = _Invitation(
        code: out['code'] as String,
        expiresAt: DateTime.parse(out['expiresAt'] as String),
        payload: out['payload'] as String,
      );
      setState(() {
        _busy = false;
        _invitation = inv;
        _expired = false;
      });
      _startTicking();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = writeErrorText(s, e);
      });
      // No MAXCOM and no cloud: the calm dialog names the action too.
      await showLiveOnlyIf(context, e);
    }
  }

  /// The remaining time is read from the injected clock once a second,
  /// and the widget only rebuilds when the shown value changes.
  void _startTicking() {
    _ticker?.cancel();
    _tick();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
  }

  void _tick() {
    final inv = _invitation;
    if (inv == null) return;
    final left = inv.expiresAt.difference(ref.read(appDepsProvider).now());
    final expired = left <= Duration.zero;
    final secs = expired ? 0 : left.inSeconds;
    final shown =
        '${(secs ~/ 60).toString().padLeft(2, '0')}:${(secs % 60).toString().padLeft(2, '0')}';
    if (shown == _countdown && expired == _expired) return;
    if (expired) _ticker?.cancel();
    if (!mounted) return;
    setState(() {
      _countdown = shown;
      _expired = expired;
    });
  }

  Future<void> _copy() async {
    final s = S.of(context);
    await Clipboard.setData(ClipboardData(text: _invitation!.code));
    if (!mounted) return;
    toast(context, s.enrolQrCopied);
  }

  /// The payload's own fingerprint, else the one this device enrolled
  /// with (the same box).
  String? _fingerprint() {
    final inv = _invitation;
    if (inv != null) {
      try {
        return EnrolledBox.fingerprintOf(
          EnrolPayload.parse(inv.payload).caSha256,
        );
      } on FormatException {
        // fall through
      }
    }
    return ref.read(enrolledBoxProvider)?.caFingerprint;
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final u = widget.user;
    final inv = _invitation;
    final firstName = u.name.trim().split(RegExp(r'\s+')).first;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(s.enrolQrFor(u.name), style: text.headlineSmall),
        const SizedBox(height: 20),
        if (inv == null) ...[
          TextField(
            key: const ValueKey('enrol-device-name'),
            controller: _name,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            textInputAction: TextInputAction.done,
            maxLength: 40,
            decoration: InputDecoration(
              labelText: s.enrolDeviceNameLabel,
              hintText: s.enrolQrNameHint(firstName),
              errorText: _nameError,
              counterText: '',
            ),
            onChanged: (_) {
              if (_nameError != null) setState(() => _nameError = null);
            },
            onSubmitted: (_) => _begin(),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorLine(_error!),
          ],
          const SizedBox(height: 16),
          Text(
            s.enrolTtlLabel,
            style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 10),
          SegmentedButton<int>(
            key: const ValueKey('enrol-ttl'),
            segments: [
              for (final m in const [10, 30, 60])
                ButtonSegment(
                  value: m,
                  label: Text(
                    s.enrolTtlMinutes(m),
                    key: ValueKey('enrol-ttl-$m'),
                  ),
                ),
            ],
            selected: {_ttl},
            showSelectedIcon: false,
            style: ButtonStyle(
              minimumSize: const WidgetStatePropertyAll(Size(0, 48)),
              textStyle: WidgetStatePropertyAll(text.labelMedium),
              side: const WidgetStatePropertyAll(
                BorderSide(color: SurauColors.line),
              ),
              backgroundColor: WidgetStateProperty.resolveWith(
                (st) => st.contains(WidgetState.selected)
                    ? SurauColors.tealSoft
                    : SurauColors.card,
              ),
              foregroundColor: WidgetStateProperty.resolveWith(
                (st) => st.contains(WidgetState.selected)
                    ? SurauColors.glass
                    : SurauColors.teal,
              ),
            ),
            onSelectionChanged: _busy
                ? null
                : (sel) => setState(() => _ttl = sel.first),
          ),
          const SizedBox(height: 8),
          Text(s.enrolTtlHelp, style: text.bodySmall),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _busy ? null : _begin,
            icon: const Icon(Icons.qr_code_2_rounded),
            label: Text(s.enrolQrGenerate),
          ),
        ] else
          LayoutBuilder(
            builder: (context, constraints) {
              final wide = constraints.maxWidth >= 620;
              final qr = _QrCard(
                invitation: inv,
                countdown: _countdown,
                expired: _expired,
                onCopy: _copy,
              );
              final details = _Details(
                userId: u.id,
                boxFingerprint: ref
                    .watch(boxInfoProvider)
                    .value
                    ?.fingerprintGroups,
                name: u.name,
                fingerprint: _fingerprint(),
                expired: _expired,
                busy: _busy,
                error: _error,
                onNew: _begin,
              );
              if (!wide) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [qr, const SizedBox(height: 20), details],
                );
              }
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(width: 340, child: qr),
                  const SizedBox(width: 24),
                  Expanded(child: details),
                ],
              );
            },
          ),
      ],
    );
  }
}

/// The QR on white with the countdown under it, then the code in big
/// letters and `Salin kod`.
class _QrCard extends StatelessWidget {
  const _QrCard({
    required this.invitation,
    required this.countdown,
    required this.expired,
    required this.onCopy,
  });

  final _Invitation invitation;
  final String countdown;
  final bool expired;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
        child: Column(
          children: [
            Opacity(
              opacity: expired ? 0.25 : 1,
              child: InvitationQr(data: invitation.payload),
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
              decoration: BoxDecoration(
                color: expired ? SurauColors.dangerSoft : SurauColors.goldSoft,
                borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.timer_outlined,
                    size: 18,
                    color: expired ? SurauColors.dangerInk : SurauColors.ink,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    s.enrolQrExpiresIn(countdown),
                    style: text.labelMedium!.copyWith(
                      color: expired ? SurauColors.dangerInk : SurauColors.ink,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 18),
            Text(s.enrolQrCodeLabel, style: text.bodySmall),
            const SizedBox(height: 4),
            Text(
              invitation.code,
              textAlign: TextAlign.center,
              style: text.headlineMedium!.copyWith(
                letterSpacing: 1,
                color: expired ? SurauColors.muted : SurauColors.text,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: expired ? null : onCopy,
              icon: const Icon(Icons.copy_rounded),
              label: Text(s.enrolQrCopy),
            ),
          ],
        ),
      ),
    );
  }
}

/// The payload string verbatim as a QR (error correction M, the kiosk's
/// glass on white), 240 px square. [data] is readable, for the tests.
class InvitationQr extends StatelessWidget {
  const InvitationQr({super.key, required this.data});

  final String data;

  @override
  Widget build(BuildContext context) {
    return QrImageView(
      data: data,
      size: 240,
      padding: EdgeInsets.zero,
      errorCorrectionLevel: QrErrorCorrectLevel.M,
      backgroundColor: Colors.white,
      semanticsLabel: S.of(context).enrolQrTitle,
      eyeStyle: const QrEyeStyle(
        eyeShape: QrEyeShape.square,
        color: SurauColors.glass,
      ),
      dataModuleStyle: const QrDataModuleStyle(
        dataModuleShape: QrDataModuleShape.square,
        color: SurauColors.glass,
      ),
    );
  }
}

/// What to tell the person, the fingerprint to compare (folded away with
/// the technical details), and the way to a new code once this one has
/// run out.
class _Details extends StatelessWidget {
  const _Details({
    required this.userId,
    required this.boxFingerprint,
    required this.name,
    required this.fingerprint,
    required this.expired,
    required this.busy,
    required this.error,
    required this.onNew,
  });

  final String userId;

  /// The box's own key fingerprint (from `GET /api/box/info`), in groups of four: what the invited person compares.
  final String? boxFingerprint;
  final String name;
  final String? fingerprint;
  final bool expired;
  final bool busy;
  final String? error;
  final VoidCallback onNew;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final fp = fingerprint;
    final fpRows = fp?.replaceFirst(' ', '\n', fp.indexOf(' ', 19));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (expired) ...[
          ErrorLine(s.enrolQrExpired),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: busy ? null : onNew,
            icon: const Icon(Icons.refresh_rounded),
            label: Text(s.enrolQrNew),
          ),
          const SizedBox(height: 20),
        ],
        if (error != null) ...[ErrorLine(error!), const SizedBox(height: 12)],
        Text(s.enrolQrScanHint(name), style: text.bodyLarge),
        if (boxFingerprint != null) ...[
          const SizedBox(height: 8),
          Text(
            s.enrolQrFingerprint(boxFingerprint!),
            key: const ValueKey('enrol-qr-box-fp'),
            style: text.titleSmall,
          ),
        ],
        _RecentCodes(userId: userId),
        const SizedBox(height: 16),
        TechnicalDetails(
          rows: <DetailRow>[
            (label: s.enrolCaLabel, value: fpRows ?? s.enrolCaNone),
          ],
          note: fpRows == null ? null : s.enrolQrCaHint,
        ),
      ],
    );
  }
}

/// What became of the codes this Pentadbir issued for this person in the last 24 hours: used at what time, and how
/// many later tries met a used code. Never the code itself.
class _RecentCodes extends ConsumerWidget {
  const _RecentCodes({required this.userId});

  final String userId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final rows = [
      for (final c
          in ref.watch(enrolRecentProvider).value ?? const <EnrolCodeStatus>[])
        if (c.userId == userId) c,
    ];
    final lines = <String>[
      for (final r in rows) ...[
        if (r.usedAt != null) s.codeUsedAt(_hhmm(r.usedAt!)),
        if (r.reuseAttempts > 0) s.codeReuseAttempts(r.reuseAttempts),
      ],
    ];
    if (lines.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        key: const ValueKey('enrol-recent'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final l in lines)
            Text(l, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        ],
      ),
    );
  }

  static String _hhmm(DateTime t) {
    final l = t.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(l.hour)}:${two(l.minute)}';
  }
}
