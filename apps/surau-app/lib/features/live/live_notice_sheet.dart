// The sheet behind "Kongsi pautan siaran" (Task L1): the notice text in the
// language of this phone, editable, with "Kembalikan teks asal", "Kongsi"
// through the phone's share sheet and, for a Pentadbir, "Hantar kepada
// seorang" (one person's WhatsApp). Nothing here is sent to the box or the
// cloud and nothing is logged; a phone number is drawn only in the confirm
// before WhatsApp opens (so the Pentadbir sees where it goes), never in a list.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/app_lang.dart';
import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import '../common/ltr.dart';
import '../finance/share.dart';
import '../shell/permissions.dart';
import '../people/phone.dart';
import 'live_notice.dart';

/// Opens the sheet for [input]. Does nothing when the link of [input] is not
/// a valid public watch link (the caller shows no button then either).
Future<void> showLiveNoticeSheet(
  BuildContext context,
  WidgetRef ref, {
  required LiveNoticeInput input,
}) async {
  if (!isLiveVideoId(input.videoId)) return;
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    builder: (_) => LiveNoticeSheet(input: input),
  );
}

class LiveNoticeSheet extends ConsumerStatefulWidget {
  const LiveNoticeSheet({super.key, required this.input});

  final LiveNoticeInput input;

  @override
  ConsumerState<LiveNoticeSheet> createState() => _LiveNoticeSheetState();
}

class _LiveNoticeSheetState extends ConsumerState<LiveNoticeSheet> {
  late final AppLang _lang;
  late final String _original;
  late final TextEditingController _text;

  @override
  void initState() {
    super.initState();
    _lang = ref.read(appLangProvider);
    final deps = ref.read(appDepsProvider);
    _original = liveNoticeText(widget.input, _lang, deps.toLocal(deps.now())) ?? '';
    _text = TextEditingController(text: _original);
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  /// The text with the watch link back on its own line when it was removed.
  String _withLink() {
    final t = ensureLiveLink(_text.text, widget.input.videoId);
    if (t != _text.text) _text.text = t;
    return t;
  }

  Future<void> _share() async {
    final s = S.of(context);
    final text = _withLink();
    String? message;
    try {
      final r = await shareText(text);
      if (r.unavailable) {
        await Clipboard.setData(ClipboardData(text: text));
        message = s.liveNoticeCopied;
      }
    } on ShareArgsError {
      message = s.liveNoticeShareFailed;
    } on ShareFailed {
      message = s.liveNoticeShareFailed;
    }
    if (message != null && mounted) toast(context, message);
  }

  Future<void> _toOne(List<LiveNoticeRecipient> people) async {
    final s = S.of(context);
    final picked = await showModalBottomSheet<LiveNoticeRecipient>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (_) => _RecipientPicker(people: people),
    );
    if (picked == null || !mounted) return;
    final text = _withLink();
    final phone = picked.phone ?? '';
    final Uri uri;
    try {
      uri = whatsAppUri(phone, text);
    } on ArgumentError {
      toast(context, s.liveNoticeWhatsAppFailed);
      return;
    }
    final go = await confirmDialog(
      context,
      title: s.liveNoticeToOne,
      body: s.waOpensTo(ltr(formatPhone(phone))),
      confirm: s.liveNoticeOpenGo,
    );
    if (!go || !mounted) return;
    var opened = false;
    try {
      opened = await openWhatsApp(uri, open: ref.read(appDepsProvider).openUrl);
    } on ShareArgsError {
      opened = false;
    }
    if (!opened && mounted) toast(context, s.liveNoticeWhatsAppFailed);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final roles = ref.watch(rolesProvider);
    final people = can(roles, 'users:manage')
        ? (ref.watch(liveNoticeRecipientsProvider).value ?? const <LiveNoticeRecipient>[])
        : const <LiveNoticeRecipient>[];
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsetsDirectional.fromSTEB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          key: const ValueKey('live-notice-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.liveNoticeTitle, style: text.titleLarge),
            const SizedBox(height: 4),
            Text(s.liveNoticeEditHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 14),
            TextField(
              key: const ValueKey('live-notice-field'),
              controller: _text,
              minLines: 6,
              maxLines: 12,
              maxLength: shareTextMaxLength,
              keyboardType: TextInputType.multiline,
              textDirection: _lang == AppLang.ar ? TextDirection.rtl : TextDirection.ltr,
              decoration: const InputDecoration(border: OutlineInputBorder()),
            ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton.icon(
                key: const ValueKey('live-notice-reset'),
                onPressed: () => setState(() => _text.text = _original),
                icon: const Icon(Icons.restart_alt_rounded),
                label: Text(s.liveNoticeReset),
              ),
            ),
            const SizedBox(height: 8),
            FilledButton.icon(
              key: const ValueKey('live-notice-share-go'),
              onPressed: _share,
              icon: const Icon(Icons.share_rounded),
              label: Text(s.liveNoticeShareGo),
            ),
            if (people.isNotEmpty) ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                key: const ValueKey('live-notice-to-one'),
                onPressed: () => _toOne(people),
                icon: const Icon(Icons.person_rounded),
                label: Text(s.liveNoticeToOne),
              ),
            ],
            const SizedBox(height: 4),
            TextButton(
              key: const ValueKey('live-notice-close'),
              onPressed: () => Navigator.of(context).pop(),
              child: Text(s.actionClose),
            ),
          ],
        ),
      ),
    );
  }
}

/// The searchable list of people with a phone number: name and ID, never the
/// number. A search matches the name, or the ID typed loosely (`u1`,
/// `U-0001`).
class _RecipientPicker extends StatefulWidget {
  const _RecipientPicker({required this.people});

  final List<LiveNoticeRecipient> people;

  @override
  State<_RecipientPicker> createState() => _RecipientPickerState();
}

String _loose(String v) => v.toLowerCase().replaceAll(RegExp(r'[\s_.-]+'), '');

/// An ID written loosely: `U-0001`, `u-0001`, `U 1` and `u1` all become `u1`.
String _looseId(String v) {
  final t = _loose(v);
  final m = RegExp(r'^([a-z]*)0*([0-9]+)$').firstMatch(t);
  return m == null ? t : '${m.group(1)}${m.group(2)}';
}

class _RecipientPickerState extends State<_RecipientPicker> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final q = _loose(_q);
    final qId = _looseId(_q);
    final shown = [
      for (final p in widget.people)
        if (q.isEmpty ||
            _loose(p.name).contains(q) ||
            (p.ref != null && (_loose(p.ref!).contains(q) || _looseId(p.ref!).contains(qId))))
          p,
    ];
    return SafeArea(
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(20, 0, 20, 12 + MediaQuery.viewInsetsOf(context).bottom),
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * 0.6,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(s.liveNoticePickTitle, style: text.titleLarge),
              const SizedBox(height: 10),
              TextField(
                key: const ValueKey('live-notice-pick-search'),
                onChanged: (v) => setState(() => _q = v),
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.search_rounded),
                  hintText: s.liveNoticePickSearch,
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              Expanded(
                child: shown.isEmpty
                    ? Center(child: Text(s.liveNoticePickEmpty, style: text.bodyMedium))
                    : ListView(
                        children: [
                          for (final p in shown)
                            ListTile(
                              key: ValueKey('live-notice-pick-${p.id}'),
                              contentPadding: EdgeInsets.zero,
                              leading: const Icon(Icons.person_outline_rounded),
                              title: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                              subtitle: p.ref == null ? null : LtrText(p.ref!),
                              onTap: () => Navigator.of(context).pop(p),
                            ),
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
