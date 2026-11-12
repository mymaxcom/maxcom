// Kandungan: the 14 kinds as a list (`/content`), and one kind's items
// (`/content/:kind`) sorted the way the person thinks of them (kuliah by
// date, newest first; announcements by when they end; posters by order),
// a search box, `Tambah`, and `Padam` behind a confirm. A kuliah row
// shows its speaker and a `Batal` badge; nothing in a row can be changed
// by a stray touch, the editor does that. Edit controls only with
// `content:write`; everyone with `content:read` can look.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../content/asset_picker.dart';
import '../content/editors/content_form.dart';
import '../content/image_ref.dart' show ImageSlot;
import '../content/kinds.dart';
import '../features/shell/permissions.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

/// `/content`: every kind with one line on what it is.
class ContentKindsScreen extends StatelessWidget {
  const ContentKindsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return ShellPage(
      title: s.navContent,
      body: SurauTheme.page(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 20),
            child: Text(s.contentKindsHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          ),
          RowsCard(
            children: [
              for (final k in contentKinds)
                ListTile(
                  leading: Icon(k.icon),
                  title: Text(k.labelMsPlural),
                  subtitle: Text(k.descriptionMs),
                  trailing: const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
                  onTap: () => context.go(AppRoutes.contentFor(k.key)),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// `/content/:kind`.
class ContentListScreen extends ConsumerStatefulWidget {
  const ContentListScreen({super.key, required this.kind});

  final String kind;

  @override
  ConsumerState<ContentListScreen> createState() => _ContentListScreenState();
}

class _ContentListScreenState extends ConsumerState<ContentListScreen> {
  String _query = '';

  Future<void> _delete(ContentKindSpec spec, Map<String, dynamic> item) async {
    final s = S.of(context);
    final ok = await confirmDialog(
      context,
      title: s.contentDeleteTitle(spec.labelMs.toLowerCase()),
      body: s.contentDeleteBody,
      confirm: s.actionDelete,
      destructive: true,
    );
    if (!ok || !mounted) return;
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    try {
      await gateway.delete('${contentPath(spec.key)}/${item['id']}');
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(contentPath(spec.key)));
      toast(context, s.contentDeleted(spec.labelMs));
    } catch (e) {
      if (!mounted) return;
      toast(context, contentWriteErrorText(s, e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final spec = contentKindByKey(widget.kind);
    if (spec == null) {
      return ShellPage(
        title: s.navContent,
        body: SurauTheme.page(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Text(s.contentNotFound, textAlign: TextAlign.center, style: text.bodyLarge),
            ),
          ],
        ),
      );
    }
    final canWrite = canSee(ref.watch(rolesProvider), 'content:write');
    // Names of referenced items, for kuliah (speaker) and tugasan (person).
    final refKind = switch (spec.key) {
      'kuliah' => 'penceramah',
      'tugasan' => 'petugas',
      _ => null,
    };
    final refNames = <String, String>{};
    if (refKind != null) {
      final read = ref.watch(boxJsonProvider(contentPath(refKind))).value;
      if (read != null) {
        for (final x in parseItems(read.value)) {
          refNames[x['id'] as String] = refName(x);
        }
      }
    }

    return ShellPage(
      title: spec.labelMsPlural,
      body: SurauTheme.page(
        children: [
          if (spec.descriptionMs.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
              child: Text(spec.descriptionMs, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            ),
          if (canWrite) ...[
            FilledButton.icon(
              key: const ValueKey('content-add'),
              onPressed: () => context.go(AppRoutes.contentNewFor(spec.key)),
              icon: const Icon(Icons.add_rounded),
              label: Text(s.contentAdd(spec.labelMs.toLowerCase())),
            ),
            const SizedBox(height: 16),
          ],
          TextField(
            key: const ValueKey('content-search'),
            decoration: InputDecoration(
              hintText: s.contentSearchHint,
              prefixIcon: const Icon(Icons.search_rounded),
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.close_rounded),
                      onPressed: () => setState(() => _query = ''),
                    ),
              isDense: true,
            ),
            onChanged: (q) => setState(() => _query = q.trim().toLowerCase()),
          ),
          const SizedBox(height: 16),
          BoxReadView(
            path: contentPath(spec.key),
            builder: (context, body) {
              final items = sortItems(spec.key, parseItems(body));
              if (items.isEmpty) return _Empty(s.contentEmpty(spec.labelMsPlural.toLowerCase()));
              final shown = _query.isEmpty
                  ? items
                  : [
                      for (final it in items)
                        if (_searchText(spec, it, refNames).contains(_query)) it,
                    ];
              if (shown.isEmpty) return _Empty(s.contentNoMatch);
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SectionLabel(s.contentCount(shown.length)),
                  RowsCard(
                    children: [
                      for (final it in shown)
                        _ItemRow(
                          spec: spec,
                          item: it,
                          refNames: refNames,
                          canWrite: canWrite,
                          onDelete: () => _delete(spec, it),
                        ),
                    ],
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

String _searchText(ContentKindSpec spec, Map<String, dynamic> it, Map<String, String> refNames) {
  final parts = <String>[
    for (final f in spec.fields)
      if (it[f.key] is String) it[f.key] as String,
    ...[for (final k in ['penceramahId', 'petugasId']) refNames[it[k]] ?? ''],
  ];
  return parts.join(' ').toLowerCase();
}

/// The order a person expects for each kind.
List<Map<String, dynamic>> sortItems(String kind, List<Map<String, dynamic>> items) {
  int cmpStr(Map<String, dynamic> a, Map<String, dynamic> b, String k) =>
      '${a[k] ?? ''}'.toLowerCase().compareTo('${b[k] ?? ''}'.toLowerCase());
  int cmpNum(Map<String, dynamic> a, Map<String, dynamic> b, String k) =>
      ((a[k] as num?) ?? 0).compareTo((b[k] as num?) ?? 0);
  final out = [...items];
  switch (kind) {
    case 'kuliah':
      out.sort((a, b) {
        final d = cmpStr(b, a, 'date');
        return d != 0 ? d : cmpStr(b, a, 'time');
      });
    case 'tugasan':
      out.sort((a, b) {
        final d = cmpStr(b, a, 'date');
        return d != 0 ? d : cmpStr(a, b, 'role');
      });
    case 'pengumuman':
    case 'ticker':
      out.sort((a, b) => cmpStr(a, b, 'to'));
    case 'poster':
    case 'worldTime':
    case 'zikir':
      out.sort((a, b) => cmpNum(a, b, 'order'));
    case 'programKhas':
      out.sort((a, b) => cmpStr(a, b, 'at'));
    case 'takwim':
      out.sort((a, b) => cmpStr(a, b, 'date'));
    case 'penceramah':
    case 'petugas':
      out.sort((a, b) => cmpStr(a, b, 'name'));
    case 'kitab':
      out.sort((a, b) => cmpStr(a, b, 'title'));
    case 'hadis':
      out.sort((a, b) => cmpStr(a, b, 'source'));
    case 'tilawahSlot':
      const order = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'];
      out.sort((a, b) {
        final d = order.indexOf('${a['before']}').compareTo(order.indexOf('${b['before']}'));
        return d != 0 ? d : cmpNum(b, a, 'minutesBefore');
      });
  }
  return out;
}

/// Title, subtitle and badges of one item, by kind; [image] is the image
/// field's value (plain id or adjusted object) shown as a thumbnail in
/// [slot]'s shape.
({String title, String subtitle, List<Widget> badges, Object? image, ImageSlot slot}) rowOf(
  S s,
  ContentKindSpec spec,
  Map<String, dynamic> it,
  Map<String, String> refNames,
) {
  String str(String k) => '${it[k] ?? ''}';
  String opt(String k) => it[k] is String && (it[k] as String).isNotEmpty ? it[k] as String : '';
  String range(String from, String to) {
    final f = opt(from);
    final t = opt(to);
    if (f.isEmpty && t.isEmpty) return '';
    if (f.isEmpty) return '${s.contentUntil} ${dateWordsMs(t, weekday: false)}';
    if (t.isEmpty) return dateWordsMs(f, weekday: false);
    return s.contentShownFromTo(dateWordsMs(f, weekday: false), dateWordsMs(t, weekday: false));
  }

  StateChip chip(String label, {bool danger = false, bool gold = false}) => StateChip(
    label: label,
    background: danger
        ? SurauColors.dangerSoft
        : gold
        ? SurauColors.goldSoft
        : SurauColors.paperDeep,
    foreground: danger
        ? SurauColors.dangerInk
        : gold
        ? SurauColors.ink
        : SurauColors.muted,
  );
  final cancelled = it['status'] == 'batal';
  switch (spec.key) {
    case 'penceramah':
      return (title: str('name'), subtitle: opt('title'), badges: const [], image: it['photoAssetId'], slot: ImageSlot.penceramah);
    case 'kitab':
      return (title: str('title'), subtitle: opt('author'), badges: const [], image: it['coverAssetId'], slot: ImageSlot.kitab);
    case 'kuliah':
      final who = refNames[it['penceramahId']] ?? s.contentRefUnknown('Penceramah');
      final slot = spec.field('slot').choiceLabelMs(str('slot'));
      return (
        title: str('label'),
        subtitle: '${dateWordsMs(str('date'))}, ${timeWordsMs(str('time'))} ($slot)\n$who',
        badges: [if (cancelled) chip(s.contentCancelledBadge, danger: true)],
        image: null, slot: ImageSlot.poster,
      );
    case 'pengumuman':
      final p = '${it['priority']}';
      return (
        title: str('title'),
        subtitle: range('from', 'to'),
        badges: [if (p != '1') chip(spec.field('priority').choiceLabelMs(p), gold: true)],
        image: null, slot: ImageSlot.poster,
      );
    case 'ticker':
      return (title: str('text'), subtitle: range('from', 'to'), badges: const [], image: null, slot: ImageSlot.poster);
    case 'poster':
      // The title names the poster (the box gives every poster one since
      // migration 005); a row never reads "Susunan n".
      final days = daysWordsMs((it['days'] as List?) ?? const []);
      final r = range('from', 'to');
      final title = opt('title');
      return (
        title: title.isEmpty ? spec.labelMs : title,
        subtitle: r.isEmpty ? days : '$days\n$r',
        badges: const [],
        image: it['assetId'],
        slot: ImageSlot.poster,
      );
    case 'programKhas':
      return (
        title: str('title'),
        subtitle: dateTimeWordsMs(str('at')),
        badges: [if (cancelled) chip(s.contentCancelledBadge, danger: true)],
        image: it['assetId'],
        slot: ImageSlot.programKhas,
      );
    case 'takwim':
      final h = opt('hijriLabel');
      return (
        title: str('title'),
        subtitle: h.isEmpty ? dateWordsMs(str('date')) : '${dateWordsMs(str('date'))} ($h)',
        badges: const [],
        image: it['assetId'],
        slot: ImageSlot.takwim,
      );
    case 'hadis':
      return (title: str('textMs'), subtitle: str('source'), badges: const [], image: null, slot: ImageSlot.poster);
    case 'worldTime':
      return (title: str('city'), subtitle: str('tz'), badges: const [], image: null, slot: ImageSlot.poster);
    case 'petugas':
      return (title: str('name'), subtitle: '', badges: const [], image: it['photoAssetId'], slot: ImageSlot.petugas);
    case 'tugasan':
      final who = refNames[it['petugasId']] ?? s.contentRefUnknown('Petugas');
      final note = opt('note');
      return (
        title: '${spec.field('role').choiceLabelMs(str('role'))}: $who',
        subtitle: note.isEmpty ? dateWordsMs(str('date')) : '${dateWordsMs(str('date'))}\n$note',
        badges: const [],
        image: null, slot: ImageSlot.poster,
      );
    case 'zikir':
      final rep = it['repeat'];
      return (
        title: str('textMs'),
        subtitle: str('textAr'),
        badges: [if (rep is num) chip(s.contentRepeat(rep.toInt()))],
        image: null, slot: ImageSlot.poster,
      );
    case 'tilawahSlot':
      final before = spec.field('before').choiceLabelMs(str('before'));
      return (
        title: s.contentSurah(((it['surah'] as num?) ?? 0).toInt()),
        subtitle:
            '${s.contentMinutesBefore(((it['minutesBefore'] as num?) ?? 0).toInt(), before)}\n${daysWordsMs((it['days'] as List?) ?? const [])}',
        badges: [if (it['enabled'] != true) chip(s.contentOff)],
        image: null, slot: ImageSlot.poster,
      );
  }
  return (title: str('id'), subtitle: '', badges: const [], image: null, slot: ImageSlot.poster);
}

class _ItemRow extends StatelessWidget {
  const _ItemRow({
    required this.spec,
    required this.item,
    required this.refNames,
    required this.canWrite,
    required this.onDelete,
  });

  final ContentKindSpec spec;
  final Map<String, dynamic> item;
  final Map<String, String> refNames;
  final bool canWrite;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final row = rowOf(s, spec, item, refNames);
    final id = item['id'] as String;
    final dim = item['status'] == 'batal' || item['enabled'] == false;
    return InkWell(
      key: ValueKey('item-$id'),
      onTap: () => context.go(AppRoutes.contentItemFor(spec.key, id)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 8, 14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            if (row.image != null) ...[
              AssetPicture(value: row.image, slot: row.slot, size: 56, radius: SurauTheme.radiusChip),
              const SizedBox(width: 14),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    row.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: text.titleSmall!.copyWith(color: dim ? SurauColors.muted : SurauColors.text),
                  ),
                  if (row.subtitle.isNotEmpty) ...[
                    const SizedBox(height: 3),
                    Text(
                      row.subtitle,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                    ),
                  ],
                  if (row.badges.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(spacing: 6, runSpacing: 6, children: row.badges),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 4),
            if (canWrite)
              IconButton(
                key: ValueKey('delete-$id'),
                tooltip: s.actionDelete,
                icon: const Icon(Icons.delete_outline_rounded, color: SurauColors.outline),
                onPressed: onDelete,
              )
            else
              const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
          ],
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodyLarge!.copyWith(color: SurauColors.muted),
      ),
    );
  }
}
