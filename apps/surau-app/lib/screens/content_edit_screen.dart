// `/content/:kind/new` and `/content/:kind/:id`: the editor for the kind
// (lib/content/editors/) over the item from the box's list, or over the
// kind's defaults for a new one (today's date, the next order, status
// aktif). Someone with `content:read` only sees the same form read-only.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../content/editors/content_form.dart';
import '../content/editors/hadis_editor.dart';
import '../content/editors/kitab_editor.dart';
import '../content/editors/kuliah_editor.dart';
import '../content/editors/penceramah_editor.dart';
import '../content/editors/pengumuman_editor.dart';
import '../content/editors/petugas_editor.dart';
import '../content/editors/poster_editor.dart';
import '../content/editors/program_khas_editor.dart';
import '../content/editors/takwim_editor.dart';
import '../content/editors/ticker_editor.dart';
import '../content/editors/tilawah_slot_editor.dart';
import '../content/editors/tugasan_editor.dart';
import '../content/editors/world_time_editor.dart';
import '../content/editors/zikir_editor.dart';
import '../content/kinds.dart';
import '../features/shell/permissions.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';

class ContentEditScreen extends ConsumerWidget {
  const ContentEditScreen({super.key, required this.kind, this.itemId});

  final String kind;

  /// Null for a new item.
  final String? itemId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final spec = contentKindByKey(kind);
    if (spec == null) {
      return ShellPage(
        title: s.navContent,
        body: SurauTheme.page(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Text(s.contentNotFound, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
            ),
          ],
        ),
      );
    }
    final readOnly = !canSee(ref.watch(rolesProvider), 'content:write');
    final id = itemId;
    return ShellPage(
      title: id == null ? s.contentNew(spec.labelMs) : s.contentEdit(spec.labelMs.toLowerCase()),
      body: SurauTheme.page(
        children: [
          BoxReadView(
            path: contentPath(spec.key),
            builder: (context, body) {
              final items = parseItems(body);
              if (id == null) {
                final deps = ref.read(appDepsProvider);
                final today = deps.toLocal(deps.now());
                var maxOrder = 0;
                for (final it in items) {
                  final o = it['order'];
                  if (o is num && o > maxOrder) maxOrder = o.toInt();
                }
                return _editor(spec.key, _defaults(spec.key, today, maxOrder + 1, items.length), null, readOnly);
              }
              final item = items.where((x) => x['id'] == id).firstOrNull;
              if (item == null) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 28),
                  child: Text(s.contentNotFound, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyLarge),
                );
              }
              return _editor(spec.key, item, id, readOnly);
            },
          ),
        ],
      ),
    );
  }
}

/// [liveCount] is how many items of the kind the box lists (the posters'
/// default title counts from it, as core's `defaultPosterTitle`).
Map<String, dynamic> _defaults(String kind, DateTime today, int nextOrder, int liveCount) => switch (kind) {
  'penceramah' => PenceramahEditor.defaults(),
  'kitab' => KitabEditor.defaults(),
  'kuliah' => KuliahEditor.defaults(today),
  'pengumuman' => PengumumanEditor.defaults(today),
  'ticker' => TickerEditor.defaults(today),
  'poster' => PosterEditor.defaults(nextOrder, liveCount),
  'programKhas' => ProgramKhasEditor.defaults(today),
  'takwim' => TakwimEditor.defaults(today),
  'hadis' => HadisEditor.defaults(),
  'worldTime' => WorldTimeEditor.defaults(nextOrder),
  'petugas' => PetugasEditor.defaults(),
  'tugasan' => TugasanEditor.defaults(today),
  'zikir' => ZikirEditor.defaults(nextOrder),
  'tilawahSlot' => TilawahSlotEditor.defaults(),
  _ => const {},
};

Widget _editor(String kind, Map<String, dynamic> initial, String? id, bool readOnly) {
  // One element per item so a fresh item never inherits another's state.
  final key = ValueKey('editor-$kind-${id ?? 'new'}');
  return switch (kind) {
    'penceramah' => PenceramahEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'kitab' => KitabEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'kuliah' => KuliahEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'pengumuman' => PengumumanEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'ticker' => TickerEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'poster' => PosterEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'programKhas' => ProgramKhasEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'takwim' => TakwimEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'hadis' => HadisEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'worldTime' => WorldTimeEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'petugas' => PetugasEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'tugasan' => TugasanEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'zikir' => ZikirEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    'tilawahSlot' => TilawahSlotEditor(key: key, initial: initial, itemId: id, readOnly: readOnly),
    _ => const SizedBox.shrink(),
  };
}
