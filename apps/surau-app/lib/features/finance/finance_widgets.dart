// Shared pieces of the Kewangan screens: the providers that read the
// finance data (all through `FinanceRepository`), money and date words,
// and the small widgets the screens repeat (hero, entry row, chips, money
// field, info box). Task 8b imports this file, so the public names stay.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../finance/finance_models.dart';
import '../../finance/finance_repository.dart';
import '../../finance/ledger.dart';
import '../../l10n/generated/s.dart';
import '../../store/local_store.dart';

// ---- providers ----

/// The summary, again after every local write and every sync change.
final financeSummaryProvider = StreamProvider.autoDispose<FinanceSummary>((
  ref,
) {
  final repo = ref.watch(financeRepositoryProvider);
  if (repo == null) return const Stream<FinanceSummary>.empty();
  return repo.watchSummary();
});

/// Unarchived funds in display order; read again whenever the summary moves.
final financeFundsProvider = FutureProvider.autoDispose<List<Fund>>((
  ref,
) async {
  ref.watch(financeSummaryProvider);
  final repo = ref.watch(financeRepositoryProvider);
  return repo == null ? const [] : repo.funds();
});

/// Unarchived perihal of one direction (`in` or `out`).
final financePerihalProvider = FutureProvider.autoDispose
    .family<List<Perihal>, String>((ref, direction) async {
      ref.watch(financeSummaryProvider);
      final repo = ref.watch(financeRepositoryProvider);
      return repo == null ? const [] : repo.perihal(direction);
    });

/// Every ledger row, newest first.
final financeEntriesProvider = FutureProvider.autoDispose<List<FinanceEntry>>((
  ref,
) async {
  ref.watch(financeSummaryProvider);
  final repo = ref.watch(financeRepositoryProvider);
  return repo == null ? const [] : repo.entries();
});

/// Funds and perihal by id, archived ones included, so an old row still
/// shows the name it was posted under.
class FinLookups {
  const FinLookups({
    this.funds = const {},
    this.perihal = const {},
    this.refs = const {},
  });

  final Map<String, Fund> funds;
  final Map<String, Perihal> perihal;

  /// Entry id -> the number shown for it (real or temporary).
  final Map<String, String> refs;

  String fundName(String id) => funds[id]?.name ?? '';
  String perihalLabel(String? id) => id == null ? '' : perihal[id]?.label ?? '';
}

final financeLookupsProvider = FutureProvider.autoDispose<FinLookups>((
  ref,
) async {
  ref.watch(financeSummaryProvider);
  final repo = ref.watch(financeRepositoryProvider);
  if (repo == null) return const FinLookups();
  return FinLookups(
    funds: {for (final f in await repo.funds(includeArchived: true)) f.id: f},
    perihal: {for (final p in await repo.perihal(null, true)) p.id: p},
    refs: {for (final e in await repo.entries()) e.id: e.refLabel},
  );
});

/// A person's or a device's name from the local copy, or null.
final financeNameProvider = FutureProvider.autoDispose
    .family<String?, ({String collection, String id})>((ref, key) async {
      final repo = ref.watch(financeRepositoryProvider);
      if (repo == null || key.id.isEmpty) return null;
      final doc = await repo.store.getDoc(key.collection, key.id);
      final name = doc?['name'];
      return name is String && name.isNotEmpty ? name : null;
    });

/// The active people a collection may be counted by, from the local copy.
final financeCounterCandidatesProvider =
    FutureProvider.autoDispose<List<({String id, String name})>>((ref) async {
      final repo = ref.watch(financeRepositoryProvider);
      if (repo == null) return const [];
      final out = <({String id, String name})>[];
      for (final d in await repo.store.list(Collections.users)) {
        final id = d['id'];
        final name = d['name'];
        if (id is! String || name is! String) continue;
        if (d['active'] == false) continue;
        out.add((id: id, name: name));
      }
      out.sort((a, b) => a.name.compareTo(b.name));
      return out;
    });

/// The `finance` feature settings the screens read, with the registry
/// defaults when the box has not answered yet.
class FinanceSettings {
  const FinanceSettings({
    this.penceramahFundId = '',
    this.bigAmountSen = 2000000,
  });

  final String penceramahFundId;
  final int bigAmountSen;
}

final financeSettingsProvider = Provider<FinanceSettings>((ref) {
  final all = ref.watch(settingsProvider).value?.value;
  final f = all?['finance'];
  if (f is! Map) return const FinanceSettings();
  final big = f['bigAmountSen'];
  final fund = f['penceramahFundId'];
  return FinanceSettings(
    penceramahFundId: fund is String ? fund : '',
    bigAmountSen: big is int && big > 0 ? big : 2000000,
  );
});

// ---- permissions ----

bool financeCanWrite(Set<String> roles) =>
    roles.any((r) => r == 'treasurer' || r == 'admin' || r == 'superadmin');

bool financeIsAdmin(Set<String> roles) =>
    roles.contains('admin') || roles.contains('superadmin');

// ---- words ----

/// `2026-11-07` -> `07/11/2026`; anything else is returned as it came.
String finDmy(String ymd) {
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(ymd);
  return m == null ? ymd : '${m[3]}/${m[2]}/${m[1]}';
}

/// `07/11/2026` -> `2026-11-07`, or null when it is not a real date.
String? finParseDmy(String text) {
  final m = RegExp(r'^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*$').firstMatch(text);
  if (m == null) return null;
  final d = int.parse(m[1]!);
  final mo = int.parse(m[2]!);
  final y = int.parse(m[3]!);
  final t = DateTime.utc(y, mo, d);
  if (t.year != y || t.month != mo || t.day != d) return null;
  return finYmd(t);
}

String finYmd(DateTime t) =>
    '${t.year.toString().padLeft(4, '0')}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}';

/// `+RM 1,284.30` / `-RM 18.00`.
String finSigned(int sen) => sen < 0 ? formatRm(sen) : '+${formatRm(sen)}';

String finMethodLabel(S s, String? method) => switch (method) {
  'tunai' => s.finMethodTunai,
  'bank' => s.finMethodBank,
  'duitnow' => s.finMethodDuitnow,
  'cek' => s.finMethodCek,
  _ => '',
};

/// The line that names an entry: the speaker for a penceramah payment, else
/// the note, the payee or the perihal.
String finEntryTitle(S s, FinanceEntry e, FinLookups lookups) {
  if (e.kind == 'adjust') {
    return s.finCorrectionOf(lookups.refs[e.correctsId] ?? '');
  }
  if (e.kind == 'opening') return s.finKindOpening;
  if (e.kind == 'out' && (e.penceramahName ?? '').isNotEmpty) {
    return e.penceramahName!;
  }
  if ((e.payee ?? '').isNotEmpty) return e.payee!;
  final label = lookups.perihalLabel(e.perihalId);
  if (label.isNotEmpty) return label;
  return (e.note ?? '').isNotEmpty ? e.note! : e.refLabel;
}

// ---- widgets ----

/// The content width from which a Kewangan page uses two columns: an iPad mini
/// held sideways, not one held upright.
const double finTwoColumnMinWidth = 860;

/// A scrolling page: one column on a phone or an upright iPad, in the order of
/// [narrow] (by default [left] then [right]); [left] and [right] side by side
/// where the width allows. With an empty [right] the wide page is one column
/// across the full width, for a table.
class FinTwoColumnPage extends StatelessWidget {
  const FinTwoColumnPage({
    super.key,
    this.top = const [],
    required this.left,
    this.right = const [],
    this.narrow,
    this.leftFlex = 1,
    this.rightFlex = 1,
  });

  final List<Widget> top;
  final List<Widget> left;
  final List<Widget> right;
  final List<Widget>? narrow;
  final int leftFlex;
  final int rightFlex;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < finTwoColumnMinWidth) {
          return SurauTheme.page(
            children: [
              ...top,
              ...(narrow ?? [...left, ...right]),
            ],
          );
        }
        Widget column(List<Widget> children) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        );
        return ListView(
          padding: SurauTheme.pagePadding,
          children: [
            ...top,
            if (right.isEmpty)
              ...left
            else
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(flex: leftFlex, child: column(left)),
                  const SizedBox(width: 18),
                  Expanded(flex: rightFlex, child: column(right)),
                ],
              ),
          ],
        );
      },
    );
  }
}

/// A label above a field, with an optional note on the right.
class FinField extends StatelessWidget {
  const FinField({
    super.key,
    required this.label,
    required this.child,
    this.trailing,
    this.help,
  });

  final String label;
  final Widget child;
  final String? trailing;
  final String? help;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: text.titleSmall!.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              if (trailing != null)
                Text(
                  trailing!,
                  style: text.bodySmall!.copyWith(color: SurauColors.muted),
                ),
            ],
          ),
          const SizedBox(height: 8),
          child,
          if (help != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                help!,
                style: text.bodySmall!.copyWith(color: SurauColors.muted),
              ),
            ),
        ],
      ),
    );
  }
}

enum FinTone { info, gold, danger, ok }

/// A boxed note with an icon: the mockup's `.info`.
class FinInfoBox extends StatelessWidget {
  const FinInfoBox({
    super.key,
    required this.text,
    this.icon = Icons.info_outline_rounded,
    this.tone = FinTone.info,
    this.bold,
  });

  final String text;
  final String? bold;
  final IconData icon;
  final FinTone tone;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.bodyMedium!;
    final (bg, fg) = switch (tone) {
      FinTone.info => (
        SurauColors.tealSoft.withValues(alpha: 0.55),
        SurauColors.text,
      ),
      FinTone.gold => (SurauColors.goldSoft, SurauColors.ink),
      FinTone.danger => (SurauColors.dangerSoft, SurauColors.dangerInk),
      FinTone.ok => (
        SurauColors.tealSoft.withValues(alpha: 0.55),
        SurauColors.teal,
      ),
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 22, color: fg),
          const SizedBox(width: 12),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  if (bold != null)
                    TextSpan(
                      text: '$bold ',
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  TextSpan(text: text),
                ],
              ),
              style: style.copyWith(color: fg),
            ),
          ),
        ],
      ),
    );
  }
}

/// The dark hero card: a title, a big figure and a line under it.
class FinHero extends StatelessWidget {
  const FinHero({
    super.key,
    required this.title,
    required this.value,
    required this.subtitle,
    this.io = const [],
  });

  final String title;
  final String value;
  final String subtitle;

  /// Up to two `(label, value)` figures along the bottom.
  final List<(String, String)> io;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
      decoration: BoxDecoration(
        color: SurauColors.glass,
        borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
        border: Border.all(color: SurauColors.goldHairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: text.labelLarge!.copyWith(
              color: Colors.white.withValues(alpha: 0.88),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            value,
            key: const Key('fin-hero-value'),
            style: text.headlineMedium!.copyWith(
              color: SurauColors.gold,
              fontWeight: FontWeight.w800,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 2),
          Text(
            subtitle,
            style: text.bodySmall!.copyWith(color: Colors.white70),
          ),
          if (io.isNotEmpty) ...[
            const SizedBox(height: 14),
            Row(
              children: [
                for (final (i, (label, amount)) in io.indexed) ...[
                  if (i > 0) const SizedBox(width: 10),
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.07),
                        borderRadius: BorderRadius.circular(
                          SurauTheme.radiusChip,
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            label,
                            style: text.bodySmall!.copyWith(
                              color: Colors.white70,
                            ),
                          ),
                          Text(
                            amount,
                            style: text.titleSmall!.copyWith(
                              color: Colors.white,
                              fontWeight: FontWeight.w700,
                              fontFeatures: const [
                                FontFeature.tabularFigures(),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// One ledger row: a coloured arrow, the title, `ref . fund . dd/mm`, the
/// signed amount, and the `Menunggu` / `Dibetulkan` tags.
class FinEntryTile extends StatelessWidget {
  const FinEntryTile({
    super.key,
    required this.entry,
    required this.lookups,
    this.corrected = false,
    this.onTap,
  });

  final FinanceEntry entry;
  final FinLookups lookups;
  final bool corrected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final e = entry;
    final (icon, color, tile) = switch (e.kind) {
      'in' => (Icons.south_rounded, SurauColors.teal, SurauColors.tealSoft),
      'out' => (
        Icons.north_rounded,
        SurauColors.danger,
        SurauColors.dangerSoft,
      ),
      'opening' => (
        Icons.flag_rounded,
        SurauColors.teal,
        SurauColors.paperDeep,
      ),
      _ => (
        Icons.swap_vert_rounded,
        const Color(0xFF7A5D00),
        SurauColors.goldSoft,
      ),
    };
    final amount = switch (e.kind) {
      'in' || 'opening' => finSigned(e.amountSen),
      'out' => formatRm(-e.amountSen),
      _ => switch (e.correctionKind) {
        'void' => s.finVoided,
        'fund' => s.finCorKindFund,
        _ => formatRm(e.amountSen),
      },
    };
    final sub = [
      e.refLabel,
      lookups.fundName(e.fundId),
      finDmy(e.entryDate).substring(0, 5),
      if (e.kind == 'out' && lookups.perihalLabel(e.perihalId).isNotEmpty)
        lookups.perihalLabel(e.perihalId),
    ].where((p) => p.isNotEmpty).join(' · ');
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: tile,
                borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
              ),
              child: Icon(icon, size: 22, color: color),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    finEntryTitle(s, e, lookups),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: text.bodyMedium!.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    sub,
                    style: text.bodySmall!.copyWith(color: SurauColors.muted),
                  ),
                  if (corrected)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: _Tag(
                        s.finTagCorrected,
                        const Color(0xFF7A5D00),
                        SurauColors.goldSoft,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  amount,
                  style: text.bodyMedium!.copyWith(
                    color: color,
                    fontWeight: FontWeight.w700,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
                if (e.pending)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(
                          Icons.schedule_rounded,
                          size: 13,
                          color: Color(0xFF8A5B00),
                        ),
                        const SizedBox(width: 3),
                        Text(
                          s.finTagPending,
                          style: text.labelSmall!.copyWith(
                            color: const Color(0xFF8A5B00),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.text, this.fg, this.bg);

  final String text;
  final Color fg;
  final Color bg;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
      ),
      child: Text(
        text,
        style: Theme.of(context).textTheme.labelSmall!.copyWith(color: fg),
      ),
    );
  }
}

/// A small pill (the `Di skrin TV` tag, `Dibatalkan`).
class FinPill extends StatelessWidget {
  const FinPill(this.text, {super.key, this.icon, this.danger = false});

  final String text;
  final IconData? icon;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final fg = danger ? SurauColors.dangerInk : SurauColors.teal;
    final bg = danger ? SurauColors.dangerSoft : SurauColors.tealSoft;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 12, color: fg),
            const SizedBox(width: 4),
          ],
          Text(
            text,
            style: Theme.of(context).textTheme.labelSmall!.copyWith(color: fg),
          ),
        ],
      ),
    );
  }
}

/// A single-choice row of chips. [disabled] values are shown greyed and
/// cannot be picked.
class FinChips<T> extends StatelessWidget {
  const FinChips({
    super.key,
    required this.items,
    required this.value,
    required this.onChanged,
    this.disabled = const {},
  });

  final List<(T, String)> items;
  final T? value;
  final ValueChanged<T> onChanged;
  final Set<T> disabled;

  @override
  Widget build(BuildContext context) {
    // The 48-point tap target of each chip already spaces the rows.
    return Wrap(
      spacing: 8,
      children: [
        for (final (v, label) in items)
          ChoiceChip(
            key: Key('fin-chip-$v'),
            label: Text(label),
            selected: v == value,
            onSelected: disabled.contains(v) ? null : (_) => onChanged(v),
          ),
      ],
    );
  }
}

/// An amount field in ringgit: `RM` prefix, digits and `.` `,` only, the
/// parsed figure ("RM 1,356.80") or the reason it is refused underneath.
class FinMoneyField extends StatelessWidget {
  const FinMoneyField({
    super.key,
    required this.controller,
    required this.onChanged,
    this.fieldKey,
    this.allowZero = false,
  });

  final TextEditingController controller;
  final VoidCallback onChanged;
  final Key? fieldKey;
  final bool allowZero;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final raw = controller.text;
    final sen = parseRm(raw);
    String? error;
    if (raw.trim().isNotEmpty) {
      if (sen == null) {
        error = s.finAmountInvalid;
      } else if (sen == 0 && !allowZero) {
        error = s.finAmountZero;
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: fieldKey,
          controller: controller,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9.,RMrm ]')),
          ],
          onChanged: (_) => onChanged(),
          style: text.titleLarge!.copyWith(
            fontWeight: FontWeight.w700,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
          decoration: const InputDecoration(prefixText: 'RM '),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: error != null
              ? Text(
                  error,
                  style: text.bodySmall!.copyWith(color: SurauColors.danger),
                )
              : sen != null
              ? Text(
                  formatRm(sen),
                  key: const Key('fin-amount-parsed'),
                  style: text.bodyMedium!.copyWith(
                    color: SurauColors.teal,
                    fontWeight: FontWeight.w700,
                  ),
                )
              : const SizedBox(height: 18),
        ),
      ],
    );
  }
}

/// Key/value rows, the mockup's `.kvt` (label muted on the left).
class FinKeyValues extends StatelessWidget {
  const FinKeyValues(this.rows, {super.key});

  final List<(String, String)> rows;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      children: [
        for (final (k, v) in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 110,
                  child: Text(
                    k,
                    style: text.bodySmall!.copyWith(color: SurauColors.muted),
                  ),
                ),
                Expanded(
                  child: Text(
                    v,
                    style: text.bodyMedium!.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// A person's name from their id (a counter or `createdBy`); the unknown
/// text when the local copy has no such user.
class FinUserName extends ConsumerWidget {
  const FinUserName(this.id, {super.key, this.style});

  final String id;
  final TextStyle? style;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref
        .watch(financeNameProvider((collection: Collections.users, id: id)))
        .value;
    return Text(name ?? S.of(context).finUnknownUser, style: style);
  }
}

/// Shows [text] as a small green/red snack, the way other screens answer a
/// save.
void finSnack(BuildContext context, String text) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));
}

/// The page after a save: "Disimpan di peranti ini", the number, the row,
/// and (while it waits) the "Belum di skrin TV" note.
class FinSavedView extends ConsumerWidget {
  const FinSavedView({
    super.key,
    required this.title,
    required this.entry,
    required this.againLabel,
    required this.onAgain,
  });

  final String title;
  final FinanceEntry entry;
  final String againLabel;
  final VoidCallback onAgain;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final lookups =
        ref.watch(financeLookupsProvider).value ?? const FinLookups();
    return ShellPage(
      title: title,
      body: SurauTheme.page(
        children: [
          Column(
            children: [
              const SizedBox(height: 12),
              const CircleAvatar(
                radius: 38,
                backgroundColor: SurauColors.tealSoft,
                child: Icon(
                  Icons.check_rounded,
                  size: 40,
                  color: SurauColors.teal,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                s.finSavedTitle,
                key: const Key('fin-saved-title'),
                style: text.headlineSmall!.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                s.finSavedRef(entry.refLabel),
                key: const Key('fin-saved-ref'),
                style: text.bodyLarge!.copyWith(color: SurauColors.muted),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Card(
            child: FinEntryTile(entry: entry, lookups: lookups),
          ),
          if (entry.pending) ...[
            const SizedBox(height: 12),
            FinInfoBox(
              key: const Key('fin-not-on-tv'),
              bold: s.finNotOnTv,
              text: s.finSavedWaiting,
              icon: Icons.schedule_rounded,
              tone: FinTone.gold,
            ),
          ],
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  key: const Key('fin-again'),
                  onPressed: onAgain,
                  icon: const Icon(Icons.add_rounded),
                  label: Text(againLabel),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  key: const Key('fin-to-home'),
                  onPressed: () => context.go(AppRoutes.finance),
                  child: Text(s.finToHome),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
