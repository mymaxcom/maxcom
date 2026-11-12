// The warning sheet before a report leaves the app, and the thin seam over
// the save and share helpers so the report screen is tested without a
// platform. The report holds the surau's money and its donors' names: the
// sheet says so, and the share is only noted in the audit when the system
// reports that the person really sent it (Task 9's [ShareResult.completed]).

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import 'share.dart';

/// Saving and sharing the PDF, by the platform halves of `share.dart`.
class ReportFileOps {
  const ReportFileOps();

  Future<SaveResult> save(Uint8List bytes, String filename) =>
      saveBytes(bytes, filename, mime: 'application/pdf');

  Future<ShareResult> share(Uint8List bytes, String filename) =>
      shareBytes(bytes, filename, mime: 'application/pdf');
}

final reportFileOpsProvider = Provider<ReportFileOps>(
  (ref) => const ReportFileOps(),
);

/// `Surau D'Waqaf` and `2026-10` become
/// `Penyata-Kewangan-Surau-D-Waqaf-2026-10.pdf`: the box's own name
/// for the download (letters and digits only, 40 characters at most).
String reportFileName(String surauName, String ym) {
  var slug = surauName
      .replaceAll(RegExp(r'[^A-Za-z0-9]+'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
  if (slug.length > 40) slug = slug.substring(0, 40);
  slug = slug.replaceAll(RegExp(r'-+$'), '');
  if (slug.isEmpty) slug = 'Surau';
  return 'Penyata-Kewangan-$slug-$ym.pdf';
}

/// Shows the warning. Returns true when the person chose to go on to the
/// system share sheet.
Future<bool> showReportShareSheet(
  BuildContext context, {
  required String filename,
}) async {
  final go = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => ReportShareSheet(filename: filename),
  );
  return go == true;
}

class ReportShareSheet extends StatelessWidget {
  const ReportShareSheet({super.key, required this.filename});

  final String filename;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.finrShareTitle, style: text.titleLarge),
            const SizedBox(height: 4),
            Text(
              filename,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              decoration: BoxDecoration(
                color: SurauColors.dangerSoft,
                borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.warning_amber_rounded,
                    color: SurauColors.danger,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      s.finrShareWarning,
                      key: const Key('finr-share-warning'),
                      style: text.bodyMedium!.copyWith(
                        color: SurauColors.dangerInk,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              key: const Key('finr-share-go'),
              onPressed: () => Navigator.of(context).pop(true),
              icon: const Icon(Icons.share_rounded),
              label: Text(s.finrShareGo),
            ),
            const SizedBox(height: 8),
            TextButton(
              key: const Key('finr-share-close'),
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(s.finrClose),
            ),
          ],
        ),
      ),
    );
  }
}
