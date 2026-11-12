// Small pieces the people, log and device screens share so they read as
// one place: the Pengguna / Peranti / Skrin TV switch, a role chip, a
// state chip, a card of rows, an error line, the PIN field, a confirm
// dialog, the platform's name and icon, and an age in words.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/theme.dart';
import '../../features/common/roles.dart';
import '../../features/enrol/pin_policy.dart';
import '../../features/shell/permissions.dart';
import '../../l10n/generated/s.dart';

/// Which of the three people pages is open.
enum PeopleTab { users, devices, pairing }

/// The switch at the top of the users, devices and pairing pages; an entry
/// the person's roles do not allow is simply not there.
class PeopleTabs extends ConsumerWidget {
  const PeopleTabs({super.key, required this.current});

  final PeopleTab current;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final roles = ref.watch(rolesProvider);
    final tabs = <PeopleTab>[
      if (canSee(roles, 'users:manage')) PeopleTab.users,
      if (canSee(roles, 'devices:manage')) ...[PeopleTab.devices, PeopleTab.pairing],
    ];
    if (tabs.length < 2) return const SizedBox.shrink();
    return SegmentedButton<PeopleTab>(
      segments: [
        for (final t in tabs)
          ButtonSegment(
            value: t,
            icon: Icon(switch (t) {
              PeopleTab.users => Icons.people_outline_rounded,
              PeopleTab.devices => Icons.devices_rounded,
              PeopleTab.pairing => Icons.tv_outlined,
            }),
            label: Text(switch (t) {
              PeopleTab.users => s.peopleTabUsers,
              PeopleTab.devices => s.peopleTabDevices,
              PeopleTab.pairing => s.peopleTabPairing,
            }),
          ),
      ],
      selected: {current},
      showSelectedIcon: false,
      style: ButtonStyle(
        minimumSize: const WidgetStatePropertyAll(Size(0, 48)),
        textStyle: WidgetStatePropertyAll(Theme.of(context).textTheme.labelMedium),
        side: const WidgetStatePropertyAll(BorderSide(color: SurauColors.line)),
        backgroundColor: WidgetStateProperty.resolveWith(
          (st) => st.contains(WidgetState.selected) ? SurauColors.tealSoft : SurauColors.card,
        ),
        foregroundColor: WidgetStateProperty.resolveWith(
          (st) => st.contains(WidgetState.selected) ? SurauColors.glass : SurauColors.teal,
        ),
      ),
      onSelectionChanged: (sel) {
        final t = sel.single;
        if (t == current) return;
        context.go(switch (t) {
          PeopleTab.users => AppRoutes.users,
          PeopleTab.devices => AppRoutes.devices,
          PeopleTab.pairing => AppRoutes.pairing,
        });
      },
    );
  }
}

/// A role in plain BM on a soft teal chip.
class RoleChip extends StatelessWidget {
  const RoleChip({super.key, required this.role, this.dim = false});

  final String role;
  final bool dim;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return StateChip(
      label: roleLabel(s, role),
      background: dim ? SurauColors.paperDeep : SurauColors.tealSoft,
      foreground: dim ? SurauColors.muted : SurauColors.teal,
    );
  }
}

/// A short state ("Tidak aktif", "PIN dikunci", "Dibatalkan") on a chip.
class StateChip extends StatelessWidget {
  const StateChip({
    super.key,
    required this.label,
    required this.background,
    required this.foreground,
  });

  final String label;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
      ),
      child: Text(label, style: text.labelMedium!.copyWith(color: foreground)),
    );
  }
}

/// The chips every list row wears: roles, then the person's state.
List<Widget> roleChips(List<String> roles, {bool dim = false}) => [
  for (final r in orderedRoles(roles)) RoleChip(role: r, dim: dim),
];

/// [roles] in display order (admin, treasurer, media, ajk), unknown last.
List<String> orderedRoles(Iterable<String> roles) {
  final set = roles.toSet();
  return [
    for (final r in roleOrder)
      if (set.remove(r)) r,
    ...set,
  ];
}

/// A card whose children are rows separated by hairlines.
class RowsCard extends StatelessWidget {
  const RowsCard({super.key, required this.children, this.header});

  final List<Widget> children;
  final Widget? header;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ?header,
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0 || header != null) const Divider(),
            children[i],
          ],
        ],
      ),
    );
  }
}

/// A small title above a card, like the kiosk's section labels.
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
      child: Text(
        text,
        style: Theme.of(context).textTheme.titleSmall!.copyWith(color: SurauColors.muted),
      ),
    );
  }
}

/// A refusal in a soft red box, the enrol screen's error line.
class ErrorLine extends StatelessWidget {
  const ErrorLine(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: SurauColors.dangerSoft,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Text(text, style: style.bodyMedium!.copyWith(color: SurauColors.dangerInk)),
    );
  }
}

/// A done message in a soft teal box: the counterpart of [ErrorLine].
class DoneLine extends StatelessWidget {
  const DoneLine(this.text, {super.key, this.detail});

  final String text;
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: SurauColors.tealSoft.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 2),
            child: Icon(Icons.check_circle_outline_rounded, color: SurauColors.teal, size: 22),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(text, style: style.bodyLarge!.copyWith(fontWeight: FontWeight.w600)),
                if (detail != null) ...[
                  const SizedBox(height: 2),
                  Text(detail!, style: style.bodyMedium!.copyWith(color: SurauColors.muted)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A 6-digit PIN field: numbers only, hidden, large tabular digits (the
/// enrol screen's).
class PinField extends StatelessWidget {
  const PinField({
    super.key,
    required this.controller,
    required this.label,
    this.autofocus = false,
    this.onChanged,
    this.errorText,
  });

  final TextEditingController controller;
  final String label;
  final bool autofocus;
  final void Function(String)? onChanged;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return TextField(
      controller: controller,
      autofocus: autofocus,
      obscureText: true,
      obscuringCharacter: '●',
      keyboardType: TextInputType.number,
      inputFormatters: [
        FilteringTextInputFormatter.digitsOnly,
        LengthLimitingTextInputFormatter(pinLength),
      ],
      autocorrect: false,
      enableSuggestions: false,
      textAlign: TextAlign.center,
      style: text.titleLarge!.copyWith(
        letterSpacing: 6,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
      decoration: InputDecoration(
        labelText: label,
        floatingLabelAlignment: FloatingLabelAlignment.center,
        errorText: errorText,
        errorMaxLines: 3,
      ),
      onChanged: onChanged,
    );
  }
}

/// "Title? body [Batal] [Confirm]"; true when confirmed. A destructive
/// confirm is drawn in red.
Future<bool> confirmDialog(
  BuildContext context, {
  required String title,
  required String body,
  required String confirm,
  bool destructive = false,
  Widget? extra,
}) async {
  final s = S.of(context);
  final out = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(body),
            if (extra != null) ...[const SizedBox(height: 16), extra],
          ],
        ),
      ),
      actionsPadding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(s.actionCancel),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          style: destructive
              ? FilledButton.styleFrom(
                  backgroundColor: SurauColors.danger,
                  foregroundColor: Colors.white,
                )
              : null,
          child: Text(confirm),
        ),
      ],
    ),
  );
  return out ?? false;
}

/// The box's `platform` in words.
String platformLabel(S s, String platform) => switch (platform) {
  'android' => s.platformAndroid,
  'ios-web' => s.platformIosWeb,
  'web' => s.platformWeb,
  'kiosk' => s.platformKiosk,
  _ => platform,
};

IconData platformIcon(String platform) => switch (platform) {
  'android' => Icons.phone_android_rounded,
  'ios-web' => Icons.tablet_mac_rounded,
  'web' => Icons.laptop_rounded,
  'kiosk' => Icons.tv_rounded,
  _ => Icons.devices_other_rounded,
};

/// "25 saat" or "3 minit".
String ageWords(S s, int seconds) =>
    seconds < 60 ? s.ageSeconds(seconds) : s.ageMinutes(seconds ~/ 60);

/// Shows [message] in the shell's snackbar.
void toast(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..clearSnackBars()
    ..showSnackBar(SnackBar(content: Text(message)));
}
