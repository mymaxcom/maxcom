// The refusal `kept_data` of a link start, said with its way out: "Data lama disimpan hingga <tarikh>. Buang data lama
// untuk memaut sekarang." A box keeps the data of a cut link for 7 days and refuses a new link until it is gone. When
// THIS box holds the data, "Buang data lama" is right here (the same sheet as on the list of screens). When the other
// box refused (its answer reaches this phone as the same code), this box holds nothing, so the line says to remove it
// on that one.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show ErrorLine;
import '../labels.dart' show appLangOf;
import 'link_backup.dart';
import 'link_backup_view.dart' show showKeptDrop;
import 'link_controller.dart';
import 'link_text.dart';
import 'link_widgets.dart';

/// The data this box keeps after an unlink, as `GET /api/link/backup` says; null when none, or when it did not answer.
final linkKeptProvider = FutureProvider.autoDispose<LinkKept?>((ref) async {
  final api = ref.watch(linkApiProvider);
  if (api == null) return null;
  try {
    return (await api.backup()).kept;
  } on Object {
    return null;
  }
});

class KeptDataNotice extends ConsumerWidget {
  const KeptDataNotice({super.key, required this.until});

  /// The date the refusing box named, or null when it named none.
  final DateTime? until;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final kept = ref.watch(linkKeptProvider);
    final own = kept.value;
    final deps = ref.watch(appDepsProvider);
    final date = until ?? (own == null ? null : deps.toLocal(own.until));
    return Column(
      key: const ValueKey('link-kept-notice'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ErrorLine(linkErrorText(s, 'kept_data', date, appLangOf(context))),
        if (own != null)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton(
              key: const ValueKey('link-kept-drop'),
              onPressed: () => showKeptDrop(
                context,
                ref,
                own,
                onDropped: () {
                  ref.invalidate(linkKeptProvider);
                  ref.read(linkControllerProvider.notifier).clearError();
                },
              ),
              child: Text(s.backupKeptDrop),
            ),
          )
        else if (kept.hasValue) ...[
          const SizedBox(height: 8),
          LinkNote(key: const ValueKey('link-kept-other'), tone: LinkTone.gold, icon: Icons.info_outline_rounded, text: s.linkKeptOtherBox),
        ],
      ],
    );
  }
}
