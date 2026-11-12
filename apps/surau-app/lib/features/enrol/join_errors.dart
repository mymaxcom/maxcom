// Where joining a surau goes wrong (an expired or used code, a phone that
// already belongs to another surau, a box the phone cannot reach, a QR that is
// not the box in front of the phone), each explained in its own words with the
// next step. One pure classifier maps an exception to a kind; one view draws it.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../box/box_qr.dart';
import '../../box/setup_client.dart';
import '../../l10n/generated/s.dart';
import '../setup/setup_flow.dart';
import 'enrol_flow.dart';

enum JoinErrorKind {
  expired,
  used,
  otherSurau,
  unreachable,
  mismatch,
  invalid,
  alreadySetUp,
  notInRecovery,
  badRecoveryCode,
  tooMany,
  locked,
}

/// The kind of failure, or null when the error is not one of these (the caller shows its own text).
JoinErrorKind? classifyJoinError(Object error) => switch (error) {
  EnrolExpired() || BoxQrExpired() => JoinErrorKind.expired,
  BoxError(status: 401, code: 'bad_enrol_code') => JoinErrorKind.used,
  SetupCodeInvalid() => JoinErrorKind.badRecoveryCode,
  EnrolAlreadyEnrolled() => JoinErrorKind.otherSurau,
  BoxUnreachable() || TrustError() => JoinErrorKind.unreachable,
  BoxQrMismatch() => JoinErrorKind.mismatch,
  BoxQrInvalid() || WrongBoxQr() => JoinErrorKind.invalid,
  SetupAlreadyDone() => JoinErrorKind.alreadySetUp,
  RecoveryNotNeeded() => JoinErrorKind.notInRecovery,
  BoxLocked() => JoinErrorKind.locked,
  TooManyAttempts() => JoinErrorKind.tooMany,
  _ => null,
};

class JoinErrorView extends StatelessWidget {
  const JoinErrorView({
    super.key,
    required this.error,
    this.expiredAt,
    this.currentSurau,
    this.cloud,
    this.onRetry,
    this.onScanAnother,
    this.onLeave,
    this.setup = false,
    this.toLocal = _local,
  });

  final Object error;

  /// When the code expired, for the body text.
  final DateTime? expiredAt;

  /// The surau this phone already belongs to (the other-surau view).
  final String? currentSurau;

  /// The cloud origin the scanned QR named, when the box is linked.
  final Uri? cloud;

  final VoidCallback? onRetry;
  final VoidCallback? onScanAnother;

  /// "Keluar dari {surau}": goes to the leave sheet.
  final VoidCallback? onLeave;

  /// On the first-setup page a spent or wrong QR is worded for the QR, not for a recovery code.
  final bool setup;
  final DateTime Function(DateTime) toLocal;

  static DateTime _local(DateTime t) => t.toLocal();

  String _hhmm(DateTime t) {
    final l = toLocal(t);
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(l.hour)}:${two(l.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final kind = classifyJoinError(error);
    final (String title, String body) = switch (kind) {
      JoinErrorKind.expired => (
        s.errCodeExpired,
        s.errCodeExpiredBody(expiredAt == null ? '' : _hhmm(expiredAt!)),
      ),
      JoinErrorKind.used => (s.errCodeUsed, s.errCodeUsedBody),
      JoinErrorKind.otherSurau => (s.errOtherSurau, s.errOtherSurauBody(currentSurau ?? s.productName)),
      JoinErrorKind.unreachable => (s.errUnreachableTitle, s.errUnreachableBody),
      JoinErrorKind.mismatch => (s.setupMismatch, ''),
      JoinErrorKind.invalid => (s.scanUnknown, ''),
      JoinErrorKind.alreadySetUp => (s.setupAlreadyDone, ''),
      JoinErrorKind.notInRecovery => (s.recoveryNotInRecovery, ''),
      JoinErrorKind.locked => (s.recoveryBoxLocked, s.recoveryBoxLockedBody),
      JoinErrorKind.badRecoveryCode => (setup ? s.setupCodeInvalid : s.recoveryBadCode, ''),
      JoinErrorKind.tooMany => (
        s.setupRetryAfter(((error as TooManyAttempts).retryAfterSec ?? 60) ~/ 60 + 1),
        '',
      ),
      null => (error is BoxError ? (error as BoxError).message : s.errorUnreachableHint, ''),
    };
    return Card(
      key: ValueKey('join-error-${kind?.name ?? 'other'}'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.error_outline_rounded, color: SurauColors.danger, size: 26),
                const SizedBox(width: 12),
                Expanded(child: Text(title, style: text.titleMedium)),
              ],
            ),
            if (body.isNotEmpty) ...[
              const SizedBox(height: 10),
              Text(body, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
            ],
            if (kind == JoinErrorKind.unreachable) ...[
              const SizedBox(height: 12),
              for (final step in [s.errTryFirst1, s.errTryFirst2, s.errTryFirst3])
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('• '),
                      Expanded(child: Text(step, style: text.bodyMedium)),
                    ],
                  ),
                ),
              const SizedBox(height: 6),
              // The cloud relay is a later plan: shown greyed so nobody looks for a button.
              Text(
                key: const ValueKey('join-error-cloud-line'),
                cloud != null ? s.errRelaySoon : s.errNoCloud,
                style: text.bodySmall!.copyWith(color: SurauColors.muted),
              ),
            ],
            if (kind == JoinErrorKind.otherSurau) ...[
              const SizedBox(height: 8),
              Text(s.errCodeMayExpire, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
            ],
            const SizedBox(height: 16),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                if (kind == JoinErrorKind.otherSurau && onLeave != null)
                  FilledButton(
                    key: const ValueKey('join-error-leave'),
                    onPressed: onLeave,
                    child: Text(s.errLeaveFirst(currentSurau ?? s.productName)),
                  ),
                if (kind == JoinErrorKind.unreachable && onRetry != null)
                  FilledButton(
                    key: const ValueKey('join-error-retry'),
                    onPressed: onRetry,
                    child: Text(s.errRetry),
                  ),
                if (kind != JoinErrorKind.unreachable && kind != JoinErrorKind.otherSurau && onScanAnother != null)
                  FilledButton(
                    key: const ValueKey('join-error-scan'),
                    onPressed: onScanAnother,
                    child: Text(s.errScanAnother),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
