// Pengguna: every person of the surau, the ones who need something first.
//
//  - "Perlu tindakan": a locked PIN (Buka kunci), no phone 3 days after being
//    added (Kod QR), no phone number or a number shared with someone else
//    (Isi nombor), and the 90-day "Nyahaktifkan?" suggestion. A person with
//    two needs is ONE row naming both, with the action of the first.
//  - "Semua pengguna aktif (n)": name, ID under it, device count and the last
//    use in the server's words, role chips.
//  - "Dinyahaktifkan (n)", folded: Aktifkan semula and Padam.
//  - "Kod pemulihan" and "Apa setiap peranan boleh buat", folded.
//
// The flags come from the box's own clock (`peopleActivityProvider`); without
// it (an older box, the cloud, the box away) the list shows as before, with a
// locked PIN still taken from the list itself. A deleted person is in no
// section. A phone number is never shown on this page. The search box matches
// a name or an ID typed loosely (`u5`, `U-0005`) across every section.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/app_lang.dart';
import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_client.dart';
import '../box/setup_client.dart';
import '../features/common/error_text.dart';
import '../features/common/roles.dart';
import '../content/kinds.dart' show dateWords;
import '../features/common/ui_flags.dart';
import '../features/people/people_activity.dart';
import '../features/people/people_api.dart';
import '../features/people/people_words.dart';
import '../features/people/ref.dart';
import '../features/setup/recovery_code_view.dart';
import '../features/setup/setup_providers.dart';
import '../features/shell/permissions.dart';
import '../features/sync/live_only_dialog.dart';
import '../l10n/generated/s.dart';
import 'user_edit_screen.dart' show showUserPhoneSheet;
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String usersPath = '/api/users';

/// The per-phone flag of the Media hint's close button.
const String mediaLiveHintDismissedKey = 'users.mediaLiveHint.dismissed';

/// The people of the list; a deleted person (seen on a feed copy) is left out.
List<UserDto> parseUsers(Map<String, dynamic> body) => [
  for (final u in (body['users'] as List? ?? const []))
    if (UserDto.fromJson(u as Map<String, dynamic>) case final user when !user.deleted) user,
];

/// True while the box refuses this person's PIN (`pinLockedUntil` ahead).
bool isLocked(UserDto u, DateTime now) {
  final until = u.pinLockedUntil;
  if (until == null) return false;
  final t = DateTime.tryParse(until);
  return t != null && t.isAfter(now);
}

/// Whether [u] matches the search [query]: its name (case ignored) or its ID
/// typed loosely (`u5`, `U-0005`, `u-c1`, `5`).
bool userMatches(UserDto u, String query) {
  final q = query.trim();
  if (q.isEmpty) return true;
  if (u.name.toLowerCase().contains(q.toLowerCase())) return true;
  final typed = parseRef(q);
  final own = u.ref == null ? null : parseRef(u.ref!);
  if (typed == null || own == null) return false;
  if (typed.kind != null && typed.kind != 'user') return false;
  return typed.src == own.src && typed.no == own.no;
}

/// The needs the screen knows of, in the order a row names them.
const List<String> _needOrder = ['locked', 'no_device', 'phone', 'phone_duplicate'];

/// Two or three letters of [name] for the round mark of a row.
String initialsOf(String name) {
  final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  if (words.isEmpty) return '';
  String first(String w) => String.fromCharCodes(w.runes.take(1)).toUpperCase();
  if (words.length == 1) return first(words.first);
  return '${first(words.first)}${first(words[1])}';
}

class UsersScreen extends ConsumerStatefulWidget {
  const UsersScreen({super.key});

  @override
  ConsumerState<UsersScreen> createState() => _UsersScreenState();
}

class _UsersScreenState extends ConsumerState<UsersScreen> {
  final _search = TextEditingController();
  String _query = '';
  bool _deactivatedOpen = false;
  bool _recoveryOpen = false;
  bool _rolesOpen = false;
  final Set<String> _busy = {};

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _refresh() {
    ref.invalidate(boxJsonProvider(usersPath));
    ref.invalidate(peopleActivityProvider);
  }

  /// "Kod pemulihan baharu": the old code dies, the new one is shown once (screenshots blocked on Android).
  Future<void> _rotate() async {
    final s = S.of(context);
    final ok = await confirmDialog(
      context,
      title: s.rotateRecoveryTitle,
      body: s.rotateRecoveryBody,
      confirm: s.rotateRecoveryConfirm,
    );
    if (!ok || !mounted) return;
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    final String code;
    try {
      code = await SetupClient(gateway.client).rotateRecoveryCode(gateway);
    } on Object catch (e) {
      if (!mounted) return;
      toast(context, e is TooManyAttempts || (e is BoxError && e.status == 429) ? s.errorTooMany : writeErrorText(s, e));
      return;
    }
    if (!mounted) return;
    ref.invalidate(recoveryCodeSetProvider);
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (context) => Scaffold(
          appBar: AppBar(title: Text(s.rotateRecoveryTitle)),
          body: SurauTheme.page(
            children: [RecoveryCodeView(code: code, onContinue: () => Navigator.of(context).pop())],
          ),
        ),
      ),
    );
  }

  /// Runs one write for [u]; a live-only refusal shows its dialog, any other
  /// refusal its sentence. True when it went through.
  Future<bool> _write(UserDto u, Future<void> Function(PeopleApi api) run) async {
    if (_busy.contains(u.id)) return false;
    setState(() => _busy.add(u.id));
    try {
      await run(ref.read(peopleApiProvider));
      return true;
    } on Object catch (e) {
      if (!mounted) return false;
      if (await showLiveOnlyIf(context, e)) return false;
      if (mounted) toast(context, errorText(S.of(context), e));
      return false;
    } finally {
      if (mounted) setState(() => _busy.remove(u.id));
    }
  }

  Future<void> _unlock(UserDto u) async {
    final s = S.of(context);
    if (!await _write(u, (api) => api.unlockUser(u.id)) || !mounted) return;
    _refresh();
    toast(context, s.usersUnlocked(u.name));
  }

  Future<void> _activate(UserDto u) async {
    final s = S.of(context);
    if (!await _write(u, (api) => api.activateUser(u.id)) || !mounted) return;
    _refresh();
    toast(context, s.usersActivated(u.name));
  }

  Future<void> _delete(UserDto u) async {
    final s = S.of(context);
    final ok = await confirmDialog(
      context,
      title: s.userDeleteTitle(u.name),
      body: s.userDeleteBody(u.name, u.ref ?? s.idPending),
      confirm: s.devicesRevoke,
      destructive: true,
    );
    if (!ok || !mounted) return;
    if (!await _write(u, (api) => api.deleteUser(u.id, u.ref ?? u.id)) || !mounted) return;
    _refresh();
    toast(context, s.userDeleted(u.name));
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final manage = canSee(ref.watch(rolesProvider), 'users:manage');
    return ShellPage(
      title: s.navPeople,
      body: SurauTheme.page(
        children: [
          const PeopleTabs(current: PeopleTab.users),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () => context.go(AppRoutes.userNew),
            icon: const Icon(Icons.person_add_alt_1_rounded),
            label: Text(s.usersAdd),
          ),
          // A box upgraded from before recovery codes has none: nobody could get back in if every phone were lost.
          // Said at the top, outside the folded Kod pemulihan, so it is seen.
          if (manage && ref.watch(recoveryCodeSetProvider).value == false) ...[
            const SizedBox(height: 12),
            _Note(
              key: const ValueKey('users-no-recovery-warning'),
              icon: Icons.warning_amber_rounded,
              text: s.usersNoRecoveryWarning,
            ),
          ],
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('users-search'),
            controller: _search,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              hintText: s.searchNameOrId,
              prefixIcon: const Icon(Icons.search_rounded),
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      tooltip: s.usersHintDismiss,
                      icon: const Icon(Icons.close_rounded),
                      onPressed: () => setState(() {
                        _search.clear();
                        _query = '';
                      }),
                    ),
            ),
            onChanged: (v) => setState(() => _query = v),
          ),
          const SizedBox(height: 8),
          BoxReadView(path: usersPath, builder: (context, body) => _lists(context, parseUsers(body))),
          if (manage) ..._recovery(context),
          const SizedBox(height: 12),
          _Fold(
            foldKey: const ValueKey('users-roles-fold'),
            icon: Icons.info_outline_rounded,
            title: s.usersRolesFold,
            open: _rolesOpen,
            onToggle: () => setState(() => _rolesOpen = !_rolesOpen),
            children: [const _RolesHelp()],
          ),
        ],
      ),
    );
  }

  List<Widget> _recovery(BuildContext context) {
    final s = S.of(context);
    return [
      const SizedBox(height: 12),
      _Fold(
        foldKey: const ValueKey('users-recovery-fold'),
        icon: Icons.key_rounded,
        title: s.usersRecoveryFold,
        hint: s.usersRecoveryHint,
        open: _recoveryOpen,
        onToggle: () => setState(() => _recoveryOpen = !_recoveryOpen),
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 4, 16, 16),
            child: OutlinedButton.icon(
              key: const ValueKey('users-rotate-recovery'),
              onPressed: _rotate,
              icon: const Icon(Icons.key_rounded),
              label: Text(s.rotateRecoveryTitle),
            ),
          ),
        ],
      ),
    ];
  }

  Widget _lists(BuildContext context, List<UserDto> all) {
    final s = S.of(context);
    if (all.isEmpty) return _Empty(s.usersEmpty);
    final now = ref.watch(appDepsProvider).now();
    final activity = ref.watch(peopleActivityProvider).value;
    final users = [for (final u in all) if (userMatches(u, _query)) u];
    final active = [for (final u in users) if (u.active) u];
    final deactivated = [for (final u in users) if (!u.active) u];

    List<String> needsOf(UserDto u) {
      if (activity == null) return isLocked(u, now) ? const ['locked'] : const [];
      final a = activity.userOf(u.id);
      if (a == null) return const [];
      return [for (final n in _needOrder) if (a.needs.contains(n)) n];
    }

    final needRows = <Widget>[];
    for (final u in active) {
      final needs = needsOf(u);
      final a = activity?.userOf(u.id);
      if (needs.isNotEmpty) {
        needRows.add(_needRow(context, u, needs, activity, a));
      } else if (a != null && a.suggestDeactivate) {
        needRows.add(
          _PersonRow(
            key: ValueKey('users-suggest-${u.id}'),
            user: u,
            line: s.usersSuggestDeactivate(isolate(u.name)),
            onTap: () => context.go(AppRoutes.userFor(u.id)),
          ),
        );
      }
    }

    final mediaWithoutLive = all.any((u) => u.active && u.roles.contains('media') && !u.roles.contains('live'));
    final hintClosed = ref.watch(uiFlagProvider(mediaLiveHintDismissedKey)).value;
    final comma = Localizations.localeOf(context).languageCode == 'ar' ? '، ' : ', ';

    String? usage(UserDto u) {
      final a = activity?.userOf(u.id);
      if (activity == null || a == null) return null;
      final count = s.usersDeviceCount(a.deviceCount);
      final days = activity.lastActiveDays(a);
      if (a.deviceCount == 0 || days == null) return count;
      return '$count$comma${lastActiveWords(s, days)}';
    }

    final foldShown = _deactivatedOpen || (_query.trim().isNotEmpty && deactivated.isNotEmpty);
    final nothing = users.isEmpty;
    final noAdminPhone = activity?.noAdminPhone == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (noAdminPhone) ...[
          const SizedBox(height: 12),
          _Note(
            key: const ValueKey('users-no-admin-phone'),
            icon: Icons.warning_amber_rounded,
            text: s.peopleNoAdminPhone,
          ),
        ],
        if (needRows.isNotEmpty) ...[
          const SizedBox(height: 12),
          KeyedSubtree(
            key: const ValueKey('users-needs'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [SectionLabel(s.peopleNeedsAction), RowsCard(children: needRows)],
            ),
          ),
        ],
        if (mediaWithoutLive && hintClosed == false) ...[
          const SizedBox(height: 12),
          _Note(
            key: const ValueKey('users-media-live-hint'),
            icon: Icons.info_outline_rounded,
            text: s.usersMediaNoLiveHint,
            closeKey: const ValueKey('users-media-hint-close'),
            closeLabel: s.usersHintDismiss,
            onClose: () => setUiFlag(ref, mediaLiveHintDismissedKey, true),
          ),
        ],
        if (nothing)
          _Empty(s.settingsNoResults)
        else ...[
          const SizedBox(height: 16),
          KeyedSubtree(
            key: const ValueKey('users-active'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SectionLabel(s.usersAllActive(active.length)),
                if (active.isNotEmpty)
                  RowsCard(
                    children: [
                      for (final u in active)
                        _PersonRow(
                          key: ValueKey('users-row-${u.id}'),
                          user: u,
                          line: usage(u),
                          chips: [
                            ...roleChips(u.roles),
                            if (u.pinRequired)
                              StateChip(
                                label: s.usersPinPending,
                                background: SurauColors.goldSoft,
                                foreground: SurauColors.ink,
                              ),
                          ],
                          onTap: () => context.go(AppRoutes.userFor(u.id)),
                        ),
                    ],
                  ),
              ],
            ),
          ),
        ],
        if (deactivated.isNotEmpty) ...[
          const SizedBox(height: 12),
          _Fold(
            foldKey: const ValueKey('users-deactivated-fold'),
            icon: Icons.person_off_outlined,
            dim: true,
            title: s.usersDeactivatedFold(deactivated.length),
            hint: s.usersDeactivatedHint,
            open: foldShown,
            onToggle: () => setState(() => _deactivatedOpen = !foldShown),
            children: [
              for (final u in deactivated)
                _PersonRow(
                  key: ValueKey('users-off-${u.id}'),
                  user: u,
                  dim: true,
                  line: _deactivatedLine(s, ref.watch(appLangProvider), ref.watch(appDepsProvider).toLocal, u, activity),
                  chips: roleChips(u.roles, dim: true),
                  onTap: () => context.go(AppRoutes.userFor(u.id)),
                  below: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _SmallButton(
                        key: ValueKey('users-activate-${u.id}'),
                        label: s.usersActivate,
                        onPressed: _busy.contains(u.id) ? null : () => _activate(u),
                      ),
                      _SmallButton(
                        key: ValueKey('users-delete-${u.id}'),
                        label: s.devicesRevoke,
                        danger: true,
                        onPressed: _busy.contains(u.id) ? null : () => _delete(u),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ],
    );
  }

  Widget _needRow(BuildContext context, UserDto u, List<String> needs, PeopleActivityDto? activity, UserActivityDto? a) {
    final s = S.of(context);
    String words(String need) => switch (need) {
      'locked' => s.usersLocked,
      'no_device' => s.usersNoDeviceYet(_daysSinceAdded(activity, a)),
      'phone' => s.phoneNeeded,
      _ => s.phoneDuplicate,
    };
    final all = [for (final n in needs) words(n)];
    final line = all.length == 1
        ? all.single
        : s.needsBoth(all.sublist(0, all.length - 1).join(', '), all.last);
    final busy = _busy.contains(u.id);
    final Widget action = switch (needs.first) {
      'locked' => _SmallButton(
        key: ValueKey('users-unlock-${u.id}'),
        label: s.usersUnlock,
        onPressed: busy ? null : () => _unlock(u),
      ),
      'no_device' => _SmallButton(
        key: ValueKey('users-qr-${u.id}'),
        label: s.usersQrButton,
        onPressed: () => context.go(AppRoutes.userEnrolFor(u.id)),
      ),
      'phone' => _SmallButton(
        key: ValueKey('users-phone-${u.id}'),
        label: s.phoneFill,
        onPressed: () => _phone(u),
      ),
      _ => _SmallButton(
        key: ValueKey('users-phone-${u.id}'),
        label: s.phoneEdit,
        onPressed: () => _phone(u),
      ),
    };
    return _PersonRow(
      key: ValueKey('users-need-${u.id}'),
      user: u,
      line: line,
      action: action,
      onTap: () => context.go(AppRoutes.userFor(u.id)),
    );
  }

  Future<void> _phone(UserDto u) async {
    final saved = await showUserPhoneSheet(context, ref, u);
    if (saved && mounted) _refresh();
  }
}

/// Whole days since [a] was added, by the server's clock.
/// "Dinyahaktifkan 19 Okt 2026" and, when the box's clock is known,
/// "Dipadam automatik dalam 335 hari" (the 365-day rule of the box). Null when
/// the box did not say when.
String? _deactivatedLine(S s, AppLang lang, DateTime Function(DateTime) toLocal, UserDto u, PeopleActivityDto? activity) {
  final at = u.deactivatedAt;
  if (at == null) return null;
  final local = toLocal(at);
  final iso = '${local.year.toString().padLeft(4, '0')}-${local.month.toString().padLeft(2, '0')}-${local.day.toString().padLeft(2, '0')}';
  final on = s.usersDeactivatedOn(dateWords(iso, lang, weekday: false));
  if (activity == null) return on;
  final gone = activity.now.difference(at).inDays;
  final left = activity.deactivatedDays - (gone < 0 ? 0 : gone);
  return '$on\n${s.usersAutoDeleteIn(left < 0 ? 0 : left)}';
}

int _daysSinceAdded(PeopleActivityDto? activity, UserActivityDto? a) {
  final at = a?.createdAt;
  if (activity == null || at == null) return activity?.noDeviceDays ?? 3;
  final d = activity.now.difference(at).inDays;
  return d < 0 ? 0 : d;
}

/// One person: a round mark, the name (up to three lines, never cut by the
/// ID), the ID on its own line under it, an optional line of words and
/// chips; at the end an [action] (moved under the words when the row is
/// narrow, so a long name keeps its room) or a chevron; [below] under all.
class _PersonRow extends StatelessWidget {
  const _PersonRow({
    super.key,
    required this.user,
    required this.onTap,
    this.line,
    this.chips = const [],
    this.action,
    this.below,
    this.dim = false,
  });

  final UserDto user;
  final VoidCallback onTap;
  final String? line;
  final List<Widget> chips;
  final Widget? action;
  final Widget? below;
  final bool dim;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return InkWell(
      onTap: onTap,
      child: LayoutBuilder(
        builder: (context, box) {
          final narrow = box.maxWidth < 340;
          final words = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                user.name,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: text.titleSmall!.copyWith(color: dim ? SurauColors.muted : SurauColors.text),
              ),
              RefText(user.ref),
              if (line != null) ...[
                const SizedBox(height: 2),
                Text(line!, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
              ],
              if (chips.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(spacing: 6, runSpacing: 6, children: chips),
              ],
              if (action != null && narrow) ...[const SizedBox(height: 10), action!],
              if (below != null) ...[const SizedBox(height: 10), below!],
            ],
          );
          return Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 12, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Initials(name: user.name, dim: dim),
                const SizedBox(width: 12),
                Expanded(child: words),
                const SizedBox(width: 8),
                if (action != null && !narrow)
                  Padding(padding: const EdgeInsets.only(top: 2), child: action)
                else if (action == null)
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// The round mark with a person's initials.
class _Initials extends StatelessWidget {
  const _Initials({required this.name, this.dim = false});

  final String name;
  final bool dim;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: Container(
        width: 40,
        height: 40,
        alignment: AlignmentDirectional.center,
        decoration: BoxDecoration(
          color: dim ? SurauColors.paperDeep : SurauColors.tealSoft,
          shape: BoxShape.circle,
        ),
        child: Text(
          initialsOf(name),
          style: Theme.of(context).textTheme.labelLarge!.copyWith(
            color: dim ? SurauColors.muted : SurauColors.teal,
          ),
        ),
      ),
    );
  }
}

/// A compact outlined button for a row; [danger] draws it in red.
class _SmallButton extends StatelessWidget {
  const _SmallButton({super.key, required this.label, required this.onPressed, this.danger = false});

  final String label;
  final VoidCallback? onPressed;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final colour = danger ? SurauColors.danger : SurauColors.teal;
    return OutlinedButton(
      onPressed: onPressed,
      style: OutlinedButton.styleFrom(
        foregroundColor: colour,
        minimumSize: const Size(SurauTheme.minTapSize, 44),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        side: BorderSide(color: colour, width: 1.5),
        textStyle: Theme.of(context).textTheme.labelMedium,
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
      child: Text(label),
    );
  }
}

/// A card with a header row that folds [children] in and out.
class _Fold extends StatelessWidget {
  const _Fold({
    required this.foldKey,
    required this.icon,
    required this.title,
    required this.open,
    required this.onToggle,
    required this.children,
    this.hint,
    this.dim = false,
  });

  final Key foldKey;
  final IconData icon;
  final String title;
  final String? hint;
  final bool open;
  final bool dim;
  final VoidCallback onToggle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final header = InkWell(
      key: foldKey,
      onTap: onToggle,
      child: Semantics(
        button: true,
        expanded: open,
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 12, 14),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: dim ? SurauColors.paperDeep : SurauColors.tealSoft,
                  borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
                ),
                child: Icon(icon, size: 22, color: dim ? SurauColors.muted : SurauColors.teal),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: text.titleSmall),
                    if (hint != null)
                      Text(hint!, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  ],
                ),
              ),
              Icon(
                open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
                color: SurauColors.outline,
              ),
            ],
          ),
        ),
      ),
    );
    return RowsCard(header: header, children: open ? children : const []);
  }
}

/// A soft gold note, with a close button when [onClose] is given.
class _Note extends StatelessWidget {
  const _Note({
    super.key,
    required this.icon,
    required this.text,
    this.onClose,
    this.closeKey,
    this.closeLabel,
  });

  final IconData icon;
  final String text;
  final VoidCallback? onClose;
  final Key? closeKey;
  final String? closeLabel;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsetsDirectional.fromSTEB(14, 12, onClose == null ? 14 : 4, 12),
      decoration: BoxDecoration(
        color: SurauColors.goldSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: SurauColors.ink),
          const SizedBox(width: 12),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(top: onClose == null ? 0 : 2),
              child: Text(text, style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: SurauColors.ink)),
            ),
          ),
          if (onClose != null)
            IconButton(
              key: closeKey,
              tooltip: closeLabel,
              onPressed: onClose,
              icon: const Icon(Icons.close_rounded, size: 20, color: SurauColors.ink),
            ),
        ],
      ),
    );
  }
}

/// What each role lets a person do, and the Media sentence.
class _RolesHelp extends StatelessWidget {
  const _RolesHelp();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    String hint(String role) => switch (role) {
      'admin' => s.roleAdminHint,
      'treasurer' => s.roleTreasurerHint,
      'live' => s.roleLiveHint,
      'media' => s.roleMediaHint,
      _ => s.roleAjkHint,
    };
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(16, 4, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final r in roleOrder)
            if (r != 'superadmin')
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(roleLabel(s, r), style: text.titleSmall),
                    Text(hint(r), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  ],
                ),
              ),
          const SizedBox(height: 12),
          Text(s.usersMediaNoLiveHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        ],
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
