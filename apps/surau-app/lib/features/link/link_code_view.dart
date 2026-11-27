// The matching code (step `code`), both sides. The box computes the six digits from both boxes' keys; each admin
// sees them on a phone. The admin of the box that showed the QR (or, for a new box without an admin, the scanning
// admin) compares them with the other phone and presses "Setuju" or "Tolak"; the other admin only shows the code.
// The TV never shows it: the TV and the approving phone get their numbers from the same box, so comparing those two
// proves nothing.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'link_models.dart';
import 'link_text.dart';
import 'link_widgets.dart';

class LinkCodeView extends StatelessWidget {
  const LinkCodeView({
    super.key,
    required this.session,
    required this.busy,
    required this.onApprove,
    required this.onCancel,
    required this.remaining,
  });

  final LinkSession session;
  final bool busy;

  /// `true`: "Setuju" or "Kod sama"; `false`: "Tolak".
  final void Function(bool ok) onApprove;
  final VoidCallback onCancel;

  /// Time left to approve (the session's own expiry).
  final Duration remaining;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final peer = session.peer;
    final code = linkCodeGroups(session.code ?? '');
    final timer = s.linkWaitExpires(linkCountdown(remaining));
    if (session.approvesCode) {
      final newBox = session.showIsNew;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            s.linkCodeApproveTitle(peer?.name ?? ''),
            key: const ValueKey('link-code-title'),
            style: text.titleLarge,
          ),
          if (peer != null && !newBox) ...[
            const SizedBox(height: 4),
            Text(
              s.linkCodeApproveFacts(peer.facts.people, peer.facts.content),
              key: const ValueKey('link-code-facts'),
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ],
          const SizedBox(height: 16),
          LinkCodeDigits(code),
          const SizedBox(height: 12),
          Text(newBox ? s.linkCodeNewBoxBody : s.linkCodeApproveBody(peer?.name ?? ''), style: text.bodyLarge),
          const SizedBox(height: 4),
          Text(timer, key: const ValueKey('link-code-timer'), style: text.bodySmall),
          const SizedBox(height: 16),
          if (newBox)
            FilledButton(
              key: const ValueKey('link-code-same'),
              onPressed: busy ? null : () => onApprove(true),
              child: Text(s.linkSameCode),
            )
          else
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    key: const ValueKey('link-code-reject'),
                    onPressed: busy ? null : () => onApprove(false),
                    child: Text(s.linkReject),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    key: const ValueKey('link-code-approve'),
                    onPressed: busy ? null : () => onApprove(true),
                    child: Text(s.linkApprove),
                  ),
                ),
              ],
            ),
          if (newBox)
            TextButton(
              key: const ValueKey('link-code-cancel'),
              onPressed: busy ? null : onCancel,
              child: Text(s.actionCancel),
            ),
          const SizedBox(height: 12),
          LinkNote(tone: LinkTone.grey, icon: Icons.info_outline_rounded, text: s.linkCodeNoData),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(s.linkCodeShowTitle, key: const ValueKey('link-code-title'), style: text.titleLarge),
        const SizedBox(height: 16),
        LinkCodeDigits(code),
        const SizedBox(height: 16),
        RowOfBoxes(show: session.face(LinkSide.show), scan: session.face(LinkSide.scan), role: session.role),
        const SizedBox(height: 12),
        Row(
          children: [
            const SizedBox(width: 18, height: 18, child: Icon(Icons.hourglass_top_rounded, size: 18, color: SurauColors.muted)),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                s.linkWaitingApproval(peer?.name ?? ''),
                key: const ValueKey('link-code-waiting'),
                style: text.bodyMedium!.copyWith(color: SurauColors.muted),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        LinkNote(
          tone: LinkTone.teal,
          icon: Icons.verified_user_outlined,
          title: s.linkCodeMismatchTitle,
          text: s.linkCodeMismatch,
        ),
        const SizedBox(height: 16),
        OutlinedButton(
          key: const ValueKey('link-code-cancel'),
          onPressed: busy ? null : onCancel,
          child: Text(s.actionCancel),
        ),
      ],
    );
  }
}

/// The two boxes of the session on two lines: the box that showed the QR first, then the one that scanned it.
class RowOfBoxes extends StatelessWidget {
  const RowOfBoxes({super.key, required this.show, required this.scan, required this.role});

  final LinkFace? show;
  final LinkFace? scan;
  final LinkSide role;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    Widget line(LinkSide side, LinkFace? f) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(side == LinkSide.show ? Icons.qr_code_2_rounded : Icons.qr_code_scanner_rounded, size: 20, color: SurauColors.teal),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              f == null ? '' : (side == role ? s.linkBoxThisNamed(f.name) : f.name),
              style: text.bodyMedium,
            ),
          ),
          Text(linkHardwareShort(s, f), style: text.bodySmall),
        ],
      ),
    );
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 8),
        child: Column(children: [line(LinkSide.show, show), line(LinkSide.scan, scan)]),
      ),
    );
  }
}

/// The hardware of a box in one short phrase, empty when the box is not known yet.
String linkHardwareShort(S s, LinkFace? f) => f == null ? '' : linkHardware(s, f.facts);
