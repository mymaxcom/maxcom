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
import '../content/play_now.dart';
import '../content/video_rules.dart' show clockOf;
import '../features/labels.dart' show appLangOf, appLangOfS;
import '../features/registry.g.dart' show surahs;
import '../features/surah_names.dart' show surahName;
import '../features/shell/permissions.dart';
import '../l10n/generated/s.dart';
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

/// `/content`: every kind with one line on what it is.
class ContentKindsScreen extends ConsumerWidget {
  const ContentKindsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // A box older than 2026.11.13 has no Video: the kind is not offered there.
    final videoOk = ref.watch(boxSupportsProvider('video'));
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
              for (final k in contentKinds.where((k) => k.key != 'video' || videoOk))
                ListTile(
                  leading: Icon(k.icon),
                  title: Text(k.labelPlural(appLangOf(context))),
                  subtitle: Text(k.description(s)),
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
      title: s.contentDeleteTitle(spec.label(appLangOf(context)).toLowerCase()),
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
      toast(context, s.contentDeleted(spec.label(appLangOf(context))));
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
      title: spec.labelPlural(appLangOf(context)),
      body: SurauTheme.page(
        children: [
          if (spec.description(s).isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
              child: Text(spec.description(s), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            ),
          if (canWrite) ...[
            FilledButton.icon(
              key: const ValueKey('content-add'),
              onPressed: () => context.go(AppRoutes.contentNewFor(spec.key)),
              icon: const Icon(Icons.add_rounded),
              label: Text(s.contentAdd(spec.label(appLangOf(context)).toLowerCase())),
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
              if (items.isEmpty) return _Empty(s.contentEmpty(spec.labelPlural(appLangOf(context)).toLowerCase()));
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
    case 'video':
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
  final lang = appLangOfS(s);
  String opt(String k) => it[k] is String && (it[k] as String).isNotEmpty ? it[k] as String : '';
  String range(String from, String to) {
    final f = opt(from);
    final t = opt(to);
    if (f.isEmpty && t.isEmpty) return '';
    if (f.isEmpty) return '${s.contentUntil} ${dateWords(t, lang, weekday: false)}';
    if (t.isEmpty) return dateWords(f, lang, weekday: false);
    return s.contentShownFromTo(dateWords(f, lang, weekday: false), dateWords(t, lang, weekday: false));
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
      final who = refNames[it['penceramahId']] ?? s.contentRefDeleted(contentKindByKey('penceramah')!.label(lang));
      final slot = spec.choiceLabel(spec.field('slot'), str('slot'), lang);
      return (
        title: str('label'),
        subtitle: '${dateWords(str('date'), lang)}, ${timeWords(str('time'), lang)} ($slot)\n$who',
        badges: [if (cancelled) chip(s.contentCancelledBadge, danger: true)],
        image: null, slot: ImageSlot.poster,
      );
    case 'pengumuman':
      final p = '${it['priority']}';
      return (
        title: str('title'),
        subtitle: range('from', 'to'),
        badges: [if (p != '1') chip(spec.choiceLabel(spec.field('priority'), p, lang), gold: true)],
        image: it['pictureAssetId'], slot: ImageSlot.pengumuman,
      );
    case 'ticker':
      return (title: str('text'), subtitle: range('from', 'to'), badges: const [], image: null, slot: ImageSlot.poster);
    case 'poster':
      // The title names the poster (the box gives every poster one since
      // migration 005); a row never reads "Susunan n".
      final days = daysWords((it['days'] as List?) ?? const [], lang);
      final r = range('from', 'to');
      final title = opt('title');
      return (
        title: title.isEmpty ? spec.label(lang) : title,
        subtitle: r.isEmpty ? days : '$days\n$r',
        badges: const [],
        image: it['assetId'],
        slot: ImageSlot.poster,
      );
    case 'video':
      final days = daysWords((it['days'] as List?) ?? const [], lang);
      final r = range('from', 'to');
      final source = str('source');
      final what = switch (source) {
        'upload' => s.videoRowUpload(clockOf(((it['durationSec'] as num?) ?? 0).toInt())),
        'rakaman' => s.videoRowRakaman(
          clockOf(((it['startSec'] as num?) ?? 0).toInt()),
          it['endSec'] is num ? clockOf((it['endSec'] as num).toInt()) : '',
        ),
        _ => s.videoRowYoutube,
      };
      final to = opt('to');
      final today = DateTime.now();
      final todayIso = '${today.year.toString().padLeft(4, '0')}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
      final over = to.isNotEmpty && to.compareTo(todayIso) < 0;
      final title = opt('title');
      return (
        title: title.isEmpty ? spec.label(lang) : title,
        subtitle: [what, days, if (r.isNotEmpty) r, if (over && source == 'upload') s.videoExpiredSuggest].join('\n'),
        badges: [if (it['sound'] == true) chip(s.videoSoundOn, gold: true)],
        image: null,
        slot: ImageSlot.poster,
      );
    case 'programKhas':
      return (
        title: str('title'),
        subtitle: dateTimeWords(str('at'), lang),
        badges: [if (cancelled) chip(s.contentCancelledBadge, danger: true)],
        image: it['assetId'],
        slot: ImageSlot.programKhas,
      );
    case 'takwim':
      final h = opt('hijriLabel');
      return (
        title: str('title'),
        subtitle: h.isEmpty ? dateWords(str('date'), lang) : '${dateWords(str('date'), lang)} ($h)',
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
      final who = refNames[it['petugasId']] ?? s.contentRefDeleted(contentKindByKey('petugas')!.label(lang));
      final note = opt('note');
      return (
        title: '${spec.choiceLabel(spec.field('role'), str('role'), lang)}: $who',
        subtitle: note.isEmpty ? dateWords(str('date'), lang) : '${dateWords(str('date'), lang)}\n$note',
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
      final before = spec.choiceLabel(spec.field('before'), str('before'), lang);
      return (
        title: _surahTitle(s, ((it['surah'] as num?) ?? 0).toInt()),
        subtitle:
            '${s.contentMinutesBefore(((it['minutesBefore'] as num?) ?? 0).toInt(), before)}\n${daysWords((it['days'] as List?) ?? const [], lang)}',
        badges: [if (it['enabled'] != true) chip(s.contentOff)],
        image: null, slot: ImageSlot.poster,
      );
  }
  return (title: str('id'), subtitle: '', badges: const [], image: null, slot: ImageSlot.poster);
}

String _surahTitle(S s, int n) {
  final name = n >= 1 && n <= surahs.length ? surahName(s, n) : '';
  return s.contentSurah(n, name);
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
        padding: const EdgeInsetsDirectional.fromSTEB(20, 14, 8, 14),
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
            if (canWrite && spec.key == 'video') PlayNowButton(itemId: id, compact: true),
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
