// Log perubahan: who changed what and when, newest first, in plain words
// (the person's name, the thing by its name rather than its id, the time
// as a Malaysian would say it). A tap opens the before/after as a table
// of keys with the changed ones highlighted. A row of chips narrows the
// list to one kind of thing; `Muat lagi` asks the box for more, up to
// its cap of 1000.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/wire.dart';
import '../features/common/roles.dart';
import '../features/common/time_words.dart';
import '../content/kinds.dart' show contentKindByKey;
import '../features/labels_ms.dart';
import '../l10n/generated/s.dart';
import 'devices_screen.dart' show devicesPath, parseDevices;
import 'users_screen.dart' show parseUsers, usersPath;
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const int auditPage = 200;
const int auditMax = 1000;

String auditPath(int limit) => '/api/audit?limit=$limit';

List<AuditEntry> parseAudit(Map<String, dynamic> body) {
  final out = [
    for (final e in (body['entries'] as List? ?? const []))
      AuditEntry.fromJson(e as Map<String, dynamic>),
  ];
  out.sort((a, b) => b.id.compareTo(a.id));
  return out;
}

String entityLabel(S s, String entity) => switch (entity) {
  'users' => s.auditEntityUsers,
  'devices' => s.auditEntityDevices,
  'settings' => s.auditEntitySettings,
  'content' => s.auditEntityContent,
  'prayer' => s.auditEntityPrayer,
  'islamic' => s.auditEntityIslamic,
  'assets' => s.auditEntityAssets,
  'prayer_days' => s.auditEntityPrayerDays,
  _ when entity.startsWith('content:') => _contentLabel(
    s,
    entity.substring('content:'.length),
  ),
  _ => readableKey(entity),
};

String _contentLabel(S s, String kind) {
  final spec = contentKindByKey(kind);
  return '${s.auditEntityContent}: ${spec?.labelMs ?? readableKey(kind)}';
}

/// A key the app has no label for, made readable: `some_key` and
/// `someKey` become "Some key". Never throws, whatever the box sends.
String readableKey(String key) {
  final spaced = key
      .replaceAllMapped(RegExp(r'([a-z0-9])([A-Z])'), (m) => '${m[1]} ${m[2]}')
      .replaceAll(RegExp(r'[_:.\-]+'), ' ')
      .trim()
      .toLowerCase();
  if (spaced.isEmpty) return key;
  return spaced[0].toUpperCase() + spaced.substring(1);
}

/// A snapshot key in plain BM: a setting by its form label (the `enabled`
/// switch included), a person's or device's field by its name; a key the
/// app does not know stays as the box wrote it.
String auditKeyLabel(S s, String entity, String key) {
  if (entity == 'settings') {
    return key == 'enabled' ? s.auditKeyEnabled : settingLabelMs(key);
  }
  if (entity == 'prayer_days') {
    switch (key) {
      case 'count':
        return s.auditKeyCount;
      case 'from':
        return s.auditKeyFrom;
      case 'to':
        return s.auditKeyTo;
      case 'summary':
        return s.auditKeySummary;
    }
  }
  if (entity == 'islamic' && key == 'detail') return s.auditKeyDetail;
  return switch (key) {
    'name' => s.auditKeyName,
    'roles' => s.auditKeyRoles,
    'active' => s.auditKeyActive,
    'pinRequired' => s.auditKeyPinRequired,
    'platform' => s.auditKeyPlatform,
    'revoked' => s.auditKeyRevoked,
    'userId' => s.auditKeyUser,
    'id' => s.auditKeyId,
    _ => key,
  };
}

/// A snapshot value in words: roles and platforms by their BM names, an
/// enum setting by its choice label, else [valueWords].
String auditValueLabel(S s, String entity, String key, Object? v) {
  if (key == 'roles' && v is List) {
    return v.isEmpty
        ? s.auditEmptyValue
        : rolesSentence(s, v.map((e) => e.toString()).toList());
  }
  if (key == 'platform' && v is String) return platformLabel(s, v);
  if (entity == 'settings' && v is String) return choiceLabelMs(key, v);
  return _Diff.valueWords(s, v);
}

class AuditScreen extends ConsumerStatefulWidget {
  const AuditScreen({super.key});

  @override
  ConsumerState<AuditScreen> createState() => _AuditScreenState();
}

class _AuditScreenState extends ConsumerState<AuditScreen> {
  int _limit = auditPage;
  String? _entity;
  final _open = <int>{};

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final today = deps.toLocal(deps.now());

    // Names for the ids the log carries, when those lists are readable.
    final users = ref.watch(boxJsonProvider(usersPath)).value;
    final devices = ref.watch(boxJsonProvider(devicesPath)).value;
    final names = <String, Map<String, String>>{
      'users': {
        if (users != null)
          for (final u in parseUsers(users.value)) u.id: u.name,
      },
      'devices': {
        if (devices != null)
          for (final d in parseDevices(devices.value)) d.id: d.name,
      },
    };

    return ShellPage(
      title: s.navAudit,
      body: SurauTheme.page(
        children: [
          BoxReadView(
            path: auditPath(_limit),
            builder: (context, body) {
              final all = parseAudit(body);
              if (all.isEmpty) {
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 28),
                  child: Text(
                    s.auditEmpty,
                    textAlign: TextAlign.center,
                    style: text.bodyLarge!.copyWith(color: SurauColors.muted),
                  ),
                );
              }
              final entities = <String>[];
              for (final e in all) {
                if (!entities.contains(e.entity)) entities.add(e.entity);
              }
              final shown = _entity == null
                  ? all
                  : [
                      for (final e in all)
                        if (e.entity == _entity) e,
                    ];
              final more = all.length >= _limit && _limit < auditMax;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      ChoiceChip(
                        label: Text(s.auditFilterAll),
                        selected: _entity == null,
                        onSelected: (_) => setState(() => _entity = null),
                      ),
                      for (final e in entities)
                        ChoiceChip(
                          label: Text(entityLabel(s, e)),
                          selected: _entity == e,
                          onSelected: (_) => setState(() => _entity = e),
                        ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  RowsCard(
                    children: [
                      for (final e in shown)
                        _EntryRow(
                          entry: e,
                          open: _open.contains(e.id),
                          onTap: () => setState(() {
                            if (!_open.remove(e.id)) _open.add(e.id);
                          }),
                          when: _when(e.at, deps.toLocal, today),
                          what: _what(s, e, names),
                          who: _who(s, e),
                        ),
                    ],
                  ),
                  if (more) ...[
                    const SizedBox(height: 16),
                    OutlinedButton.icon(
                      onPressed: () => setState(() {
                        _limit = (_limit + auditPage).clamp(
                          auditPage,
                          auditMax,
                        );
                      }),
                      icon: const Icon(Icons.expand_more_rounded),
                      label: Text(s.auditLoadMore),
                    ),
                  ],
                ],
              );
            },
          ),
        ],
      ),
    );
  }

  static String _when(
    String at,
    DateTime Function(DateTime) toLocal,
    DateTime today,
  ) {
    final t = DateTime.tryParse(at);
    if (t == null) return at;
    return whenWords(toLocal(t), today: today);
  }

  /// "Tetapan: iqamah", "Pengguna: Aminah binti Yusof".
  static String _what(
    S s,
    AuditEntry e,
    Map<String, Map<String, String>> names,
  ) {
    final id = e.entityId;
    final label = entityLabel(s, e.entity);
    if (id == null) return label;
    if (e.entity == 'settings') {
      return '$label: ${id == 'appLock' ? s.auditKeyAppLock : settingLabelMs(id)}';
    }
    if (e.entity == 'islamic') {
      return '$label: ${id == 'islamic.fetch' ? s.auditActionIslamicFetch : readableKey(id)}';
    }
    final inside = names[e.entity]?[id] ?? _nameInside(e);
    // Content ids are opaque: without a name the kind label says enough.
    if (e.entity.startsWith('content:')) {
      return inside == null ? label : '$label: $inside';
    }
    return '$label: ${inside ?? id}';
  }

  /// A `name` the snapshot itself carries (a user or device the lists no
  /// longer have).
  static String? _nameInside(AuditEntry e) {
    for (final side in [e.after, e.before]) {
      if (side is! Map) continue;
      for (final k in const ['name', 'title', 'label', 'city']) {
        final v = side[k];
        if (v is String && v.isNotEmpty) return v;
      }
    }
    return null;
  }

  static String _who(S s, AuditEntry e) {
    final name = e.userName;
    if (name != null && name.isNotEmpty) return name;
    if (e.actor == 'system') return s.auditSystem;
    if (e.actor.startsWith('kiosk')) return s.platformKiosk;
    return e.actor;
  }
}

class _EntryRow extends StatelessWidget {
  const _EntryRow({
    required this.entry,
    required this.open,
    required this.onTap,
    required this.when,
    required this.what,
    required this.who,
  });

  final AuditEntry entry;
  final bool open;
  final VoidCallback onTap;
  final String when;
  final String what;
  final String who;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 12, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(what, style: text.titleSmall),
                      const SizedBox(height: 3),
                      Wrap(
                        spacing: 10,
                        runSpacing: 2,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(
                            who,
                            style: text.bodyMedium!.copyWith(
                              color: SurauColors.teal,
                            ),
                          ),
                          Text(
                            when,
                            style: text.bodyMedium!.copyWith(
                              color: SurauColors.muted,
                              fontFeatures: const [
                                FontFeature.tabularFigures(),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Icon(
                  open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
                  color: SurauColors.outline,
                ),
              ],
            ),
            if (open) ...[
              const SizedBox(height: 12),
              _Diff(
                entity: entry.entity,
                before: entry.before,
                after: entry.after,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Before and after as one table of keys: the union of both sides, the
/// keys whose value differs highlighted. Scalars that are not objects
/// (a creation's `null` before, or a bare value) are shown as text.
class _Diff extends StatelessWidget {
  const _Diff({
    required this.entity,
    required this.before,
    required this.after,
  });

  final String entity;
  final Object? before;
  final Object? after;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final b = before;
    final a = after;
    if (b == null && a == null) {
      return Text(
        s.auditNoDetail,
        style: text.bodyMedium!.copyWith(color: SurauColors.muted),
      );
    }
    final bMap = b is Map ? b : null;
    final aMap = a is Map ? a : null;
    if ((bMap == null && b != null) || (aMap == null && a != null)) {
      // Not a key/value shape: just the two texts.
      return _table(
        [
          AuditDiffRow(
            keyName: '',
            before: valueWords(s, b),
            after: valueWords(s, a),
            changed: jsonEncode(b) != jsonEncode(a),
          ),
        ],
        s,
        text,
      );
    }
    final keys = <String>[];
    for (final k in [...?bMap?.keys, ...?aMap?.keys]) {
      final key = k.toString();
      if (!keys.contains(key)) keys.add(key);
    }
    return _table(
      [
        for (final k in keys)
          AuditDiffRow(
            keyName: auditKeyLabel(s, entity, k),
            before: auditValueLabel(s, entity, k, bMap?[k]),
            after: auditValueLabel(s, entity, k, aMap?[k]),
            changed: jsonEncode(bMap?[k]) != jsonEncode(aMap?[k]),
          ),
      ],
      s,
      text,
    );
  }

  /// Three columns (key, before, after) where there is room; on a phone
  /// the key sits on its own line above the two values so long keys
  /// never wrap mid-word.
  Widget _table(List<AuditDiffRow> rows, S s, TextTheme text) {
    final head = text.labelMedium!.copyWith(color: SurauColors.muted);
    return LayoutBuilder(
      builder: (context, constraints) {
        final narrow = constraints.maxWidth < AuditDiffRow.wideFrom;
        return Container(
          decoration: BoxDecoration(
            color: SurauColors.paper,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
            border: Border.all(color: SurauColors.line),
          ),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Row(
                  children: [
                    if (!narrow) const Expanded(flex: 2, child: SizedBox()),
                    Expanded(flex: 3, child: Text(s.auditBefore, style: head)),
                    const SizedBox(width: 8),
                    Expanded(flex: 3, child: Text(s.auditAfter, style: head)),
                  ],
                ),
              ),
              for (final r in rows) ...[const SizedBox(height: 6), r],
            ],
          ),
        );
      },
    );
  }

  /// A value in a few words: lists joined, objects as JSON, null as
  /// "kosong".
  static String valueWords(S s, Object? v) {
    if (v == null) return s.auditEmptyValue;
    if (v is String) return v.isEmpty ? s.auditEmptyValue : v;
    if (v is bool) return v ? s.featureOn : s.featureOff;
    if (v is num) return v.toString();
    if (v is List) {
      return v.isEmpty
          ? s.auditEmptyValue
          : v.map((e) => valueWords(s, e)).join(', ');
    }
    return jsonEncode(v);
  }
}

/// One key of a diff: name, before, after; [changed] draws the row on the
/// kiosk's soft gold with the key in bold.
class AuditDiffRow extends StatelessWidget {
  const AuditDiffRow({
    super.key,
    required this.keyName,
    required this.before,
    required this.after,
    required this.changed,
  });

  final String keyName;
  final String before;
  final String after;
  final bool changed;

  /// Width from which the key gets its own column.
  static const double wideFrom = 460;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final value = text.bodyMedium!.copyWith(
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    final key = Text(
      keyName,
      style: text.bodyMedium!.copyWith(
        fontWeight: changed ? FontWeight.w700 : FontWeight.w500,
        color: changed ? SurauColors.ink : SurauColors.muted,
      ),
    );
    final values = [
      Expanded(
        flex: 3,
        child: Text(before, style: value.copyWith(color: SurauColors.muted)),
      ),
      const SizedBox(width: 8),
      Expanded(
        flex: 3,
        child: Text(
          after,
          style: value.copyWith(
            color: changed ? SurauColors.ink : SurauColors.text,
            fontWeight: changed ? FontWeight.w600 : FontWeight.w400,
          ),
        ),
      ),
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final narrow = constraints.maxWidth < wideFrom - 24;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          decoration: BoxDecoration(
            color: changed ? SurauColors.goldSoft : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: narrow
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (keyName.isNotEmpty) ...[key, const SizedBox(height: 2)],
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: values,
                    ),
                  ],
                )
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(flex: 2, child: key),
                    ...values,
                  ],
                ),
        );
      },
    );
  }
}
