// The sheet behind "Kongsi pautan" (W6): the notice text of the surau (the
// box's, shared by every admin; else built on this device), the one big
// button that suits this device, and a few small ones.
//
//  - Big button: "Kongsi ke WhatsApp" when WhatsApp is installed (its own
//    chooser of chats and groups, with the picture), else "Kongsi" (the
//    system share sheet), on the web "Hantar dari telefon" (a QR).
//  - Small buttons: "Hantar dari telefon" (QR), "Salin teks", "Hantar kepada
//    diri sendiri" (only with a phone number of one's own) and "Lagi"
//    ("Tanpa gambar", and "Hantar kepada seorang" for a Pentadbir).
//  - The text is shown as a short preview; "Ubah teks" opens it for editing,
//    and the edit is saved to the box for every admin.
//
// The picture (1200 x 630) is on by default; any failure sends the text alone
// with a small note. Nothing here is logged; a phone number is drawn only in
// the confirm before WhatsApp opens, never in a list.

import 'dart:async';

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
import 'live_controller.dart' show liveBoxProvider;
import 'live_notice.dart';
import 'live_notice_box.dart';
import 'live_notice_card.dart';
import 'live_notice_share.dart';

/// Opens the sheet. [input] is the notice built on this device (the live this
/// phone started); the box's notice, when it has one, wins. With neither the
/// sheet does not open.
Future<void> showLiveNoticeSheet(
  BuildContext context,
  WidgetRef ref, {
  LiveNoticeInput? input,
}) async {
  if (input != null && !isLiveVideoId(input.videoId)) return;
  if (input == null && ref.read(liveBoxNoticeProvider).value == null) return;
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    builder: (_) => LiveNoticeSheet(input: input),
  );
}

class LiveNoticeSheet extends ConsumerStatefulWidget {
  const LiveNoticeSheet({super.key, this.input});

  final LiveNoticeInput? input;

  @override
  ConsumerState<LiveNoticeSheet> createState() => _LiveNoticeSheetState();
}

class _LiveNoticeSheetState extends ConsumerState<LiveNoticeSheet> {
  late final AppLang _lang;
  late final TextEditingController _text;
  String _original = '';
  String? _videoId;
  String? _title;
  BoxLiveNotice? _box;
  bool _editing = false;
  bool _more = false;
  bool _picture = true;
  bool _whatsApp = false;
  bool _busy = false;

  /// This user typed or reset the text since it was loaded (only then is it saved).
  bool _userEdited = false;

  /// The edited text the box held when it was last read (null: the original stands).
  String? _boxEdited;

  @override
  void initState() {
    super.initState();
    _lang = ref.read(appLangProvider);
    _text = TextEditingController();
    final input = widget.input;
    if (input != null) _useInput(input, null);
    unawaited(_load());
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _useInput(LiveNoticeInput input, String? edited) {
    final deps = ref.read(appDepsProvider);
    _videoId = input.videoId;
    _title = input.label ?? input.speaker;
    _original = liveNoticeText(input, _lang, deps.toLocal(deps.now())) ?? '';
    _text.text = edited ?? _original;
  }

  Future<void> _load() async {
    final platform = ref.read(liveNoticePlatformProvider);
    // The picture of an earlier share is deleted here (and before the next one
    // is written), never right after a share: the other app may still be reading it.
    unawaited(platform.cleanTemp());
    final wa = await platform.whatsAppInstalled();
    final box = await _readBox();
    if (!mounted) return;
    setState(() {
      _whatsApp = wa;
      _box = box;
      if (box != null) _adopt(box);
    });
  }

  /// The box's notice read fresh from the box (never the cached one).
  Future<BoxLiveNotice?> _readBox() async {
    ref.invalidate(liveBoxNoticeProvider);
    try {
      return await ref.read(liveBoxNoticeProvider.future);
    } on Object {
      return null;
    }
  }

  /// Shows what the box holds now: its text, or the original.
  void _adopt(BoxLiveNotice box) {
    final deps = ref.read(appDepsProvider);
    _useInput(
      box.toInput(surau: ref.read(surauInfoProvider)?.name, today: deps.toLocal(deps.now())),
      box.editedText,
    );
    _boxEdited = box.editedText;
    _userEdited = false;
  }

  /// Reads the box notice again; when its text changed since it was loaded,
  /// the new text is shown instead of this device's (nothing is written back).
  /// True when the person's own unsaved edit was replaced.
  Future<bool> _refreshFromBox() async {
    if (_box == null) return false;
    final box = await _readBox();
    if (box == null || !mounted) return false;
    final changed = box.editedText != _boxEdited;
    final lost = changed && _userEdited && _text.text != (box.editedText ?? _original);
    setState(() {
      _box = box;
      if (changed) _adopt(box);
    });
    return lost;
  }

  /// The text with the watch link back on its own line when it was removed.
  String _withLink() {
    final id = _videoId;
    if (id == null) return _text.text;
    final t = ensureLiveLink(_text.text, id);
    if (t != _text.text) _text.text = t;
    return t;
  }

  /// Saves the text to the box for every admin (null: the original again),
  /// only when this user changed it and it differs from what the box holds.
  Future<void> _save(String text) async {
    if (_box == null || !_userEdited) return;
    final String? want = text == _original ? null : text;
    if (want == _boxEdited) {
      _userEdited = false;
      return;
    }
    final ok = await saveLiveNoticeText(
      ref.read(gatewayProvider),
      want,
      onNotice: (n) {
        if (mounted) setState(() => _box = n);
      },
    );
    if (ok) {
      _boxEdited = want;
      _userEdited = false;
    }
  }

  Future<Uint8List?> _pictureBytes() async {
    if (!_picture) return null;
    final s = S.of(context);
    final id = _videoId;
    try {
      Uint8List? still;
      if (_box?.frame == true) still = await fetchBoxNoticeFrame(ref.read(gatewayProvider));
      if (still == null && id != null) {
        still = await ref.read(liveNoticeImageFetchProvider)(liveThumbnailUri(id));
      }
      final input = widget.input;
      final k = _box?.kuliah;
      final fields = liveCardFields(
        badge: s.liveNoticeCardBadge,
        surau: ref.read(surauInfoProvider)?.name,
        title: k?.title ?? input?.label,
        speaker: k?.speaker ?? input?.speaker,
      );
      final out = await ref.read(liveNoticeCardProvider)(fields: fields, background: still, rtl: _lang == AppLang.ar);
      if (out.isEmpty) throw StateError('empty');
      return out;
    } on Object {
      if (mounted) toast(context, s.liveNoticePictureFailed);
      return null;
    }
  }

  Future<void> _shareOut({required bool toWhatsApp}) async {
    if (_busy) return;
    final s = S.of(context);
    setState(() => _busy = true);
    final platform = ref.read(liveNoticePlatformProvider);
    String? message;
    try {
      // The text may have been changed by another admin meanwhile: look again
      // before anything is saved or sent; the new text is shown, not overwritten.
      if (await _refreshFromBox()) {
        if (mounted) toast(context, s.liveNoticeChangedMeanwhile);
        return;
      }
      if (!mounted) return;
      setState(() => _editing = false);
      final text = _withLink();
      unawaited(_save(text));
      final picture = await _pictureBytes();
      if (!mounted) return;
      final r = await platform.share(text, picture: picture, toWhatsApp: toWhatsApp);
      if (r.unavailable) {
        // No share sheet (a browser without navigator.share): WhatsApp's own
        // picker through wa.me, else the text is copied.
        var opened = false;
        try {
          opened = await openWhatsAppShare(text, open: ref.read(appDepsProvider).openUrl);
        } on Object {
          opened = false;
        }
        if (!opened) {
          await Clipboard.setData(ClipboardData(text: text));
          message = s.liveNoticeCopied;
        }
      } else if (picture != null && r.completed) {
        // A picture goes with its words as the caption; some apps drop them.
        await Clipboard.setData(ClipboardData(text: text));
        message = s.liveNoticeCopiedCaption;
      }
      // A cancelled share (completed false) leaves the sheet as it was: no error.
    } on ShareArgsError {
      message = s.liveNoticeShareFailed;
    } on ShareFailed {
      message = s.liveNoticeShareFailed;
    } finally {
      // No cleanTemp here: the picture stays until the sheet opens again or
      // the next one is written (the receiving app may still be reading it).
      if (mounted) setState(() => _busy = false);
    }
    if (message != null && mounted) toast(context, message);
  }

  Future<void> _qr() async {
    final id = _videoId;
    if (id == null) return;
    final text = _withLink();
    unawaited(_save(text));
    await showLiveNoticeQr(
      context,
      data: liveNoticeQrUrl(text, link: liveWatchLink(id), title: _title),
      title: _title,
    );
  }

  Future<void> _copy() async {
    final s = S.of(context);
    final text = _withLink();
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) toast(context, s.liveNoticeCopied);
  }

  Future<void> _toSelf(String phone) async {
    final s = S.of(context);
    final text = _withLink();
    var opened = false;
    try {
      opened = await openWhatsApp(whatsAppUri(phone, text), open: ref.read(appDepsProvider).openUrl);
    } on Object {
      opened = false;
    }
    if (!opened && mounted) toast(context, s.liveNoticeWhatsAppFailed);
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

  void _doneEditing() {
    final text = _withLink();
    setState(() => _editing = false);
    unawaited(_save(text));
  }

  /// Another admin edited the text while this sheet is open (the box's
  /// `noticeRev` changed): read it again and show the new text.
  Future<void> _onNoticeRev() async {
    if (_busy || _box == null) return;
    final lost = await _refreshFromBox();
    if (lost && mounted) toast(context, S.of(context).liveNoticeChangedMeanwhile);
  }

  /// The "Diubah oleh nama, masa" line while the box holds an edited text.
  String? _editedLine(S s) {
    final b = _box;
    final by = b?.editedBy;
    if (b == null || by == null || b.editedText == null || _boxEdited == null) return null;
    final at = b.editedAt;
    if (at == null) return null;
    final t = ref.read(appDepsProvider).toLocal(at);
    String two(int v) => v.toString().padLeft(2, '0');
    return s.liveNoticeEditedBy(by, '${two(t.hour)}:${two(t.minute)}');
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    ref.listen(liveBoxProvider.select((b) => b.noticeRev), (prev, next) {
      if (prev != next) unawaited(_onNoticeRev());
    });
    final editedLine = _editing ? null : _editedLine(s);
    final roles = ref.watch(rolesProvider);
    final platform = ref.watch(liveNoticePlatformProvider);
    final isWeb = platform.isWeb;
    final people = can(roles, 'users:manage')
        ? (ref.watch(liveNoticeRecipientsProvider).value ?? const <LiveNoticeRecipient>[])
        : const <LiveNoticeRecipient>[];
    final ownPhone = ref.watch(liveNoticeOwnPhoneProvider).value;
    final primaryLabel = isWeb ? s.liveNoticeFromPhone : (_whatsApp ? s.liveNoticeWhatsApp : s.liveNoticeShareGo);
    final primaryIcon = isWeb ? Icons.qr_code_2_rounded : (_whatsApp ? Icons.chat_rounded : Icons.share_rounded);
    final VoidCallback? primary = _busy ? null : (isWeb ? _qr : () => _shareOut(toWhatsApp: _whatsApp));
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsetsDirectional.fromSTEB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          key: const ValueKey('live-notice-sheet'),
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.liveNoticeTitle, style: text.titleLarge),
            const SizedBox(height: 12),
            if (_editing) ...[
              TextField(
                key: const ValueKey('live-notice-field'),
                controller: _text,
                minLines: 5,
                maxLines: 10,
                maxLength: shareTextMaxLength,
                keyboardType: TextInputType.multiline,
                textDirection: _lang == AppLang.ar ? TextDirection.rtl : TextDirection.ltr,
                onChanged: (_) => _userEdited = true,
                decoration: const InputDecoration(border: OutlineInputBorder()),
              ),
              Row(
                children: [
                  TextButton.icon(
                    key: const ValueKey('live-notice-reset'),
                    onPressed: () {
                      _userEdited = true;
                      setState(() => _text.text = _original);
                      unawaited(_save(_original));
                    },
                    icon: const Icon(Icons.restart_alt_rounded),
                    label: Text(s.liveNoticeReset),
                  ),
                  const Spacer(),
                  TextButton(
                    key: const ValueKey('live-notice-edit-done'),
                    onPressed: _doneEditing,
                    child: Text(s.liveNoticeEditDone),
                  ),
                ],
              ),
            ] else ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.04),
                  borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                  border: Border.all(color: SurauColors.outline),
                ),
                child: Text(
                  _text.text,
                  key: const ValueKey('live-notice-preview'),
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  textDirection: _lang == AppLang.ar ? TextDirection.rtl : TextDirection.ltr,
                  style: text.bodyMedium,
                ),
              ),
              if (editedLine != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    editedLine,
                    key: const ValueKey('live-notice-edited-by'),
                    style: text.bodySmall!.copyWith(color: SurauColors.muted),
                  ),
                ),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton(
                  key: const ValueKey('live-notice-edit'),
                  onPressed: () => setState(() => _editing = true),
                  child: Text(s.liveNoticeEditText),
                ),
              ),
            ],
            const SizedBox(height: 8),
            FilledButton.icon(
              key: const ValueKey('live-notice-primary'),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
              onPressed: primary,
              icon: Icon(primaryIcon),
              label: Text(primaryLabel),
            ),
            const SizedBox(height: 4),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 4,
              children: [
                if (!isWeb)
                  TextButton(
                    key: const ValueKey('live-notice-qr-go'),
                    onPressed: _qr,
                    child: Text(s.liveNoticeFromPhone),
                  )
                else
                  TextButton(
                    key: const ValueKey('live-notice-share-go'),
                    onPressed: _busy ? null : () => _shareOut(toWhatsApp: false),
                    child: Text(s.liveNoticeShareGo),
                  ),
                TextButton(
                  key: const ValueKey('live-notice-copy'),
                  onPressed: _copy,
                  child: Text(s.liveNoticeCopy),
                ),
                if (ownPhone != null)
                  TextButton(
                    key: const ValueKey('live-notice-to-self'),
                    onPressed: () => _toSelf(ownPhone),
                    child: Text(s.liveNoticeToSelf),
                  ),
                TextButton(
                  key: const ValueKey('live-notice-more'),
                  onPressed: () => setState(() => _more = !_more),
                  child: Text(s.liveNoticeMore),
                ),
              ],
            ),
            if (_more) ...[
              SwitchListTile(
                key: const ValueKey('live-notice-picture-toggle'),
                contentPadding: EdgeInsets.zero,
                title: Text(s.liveNoticeNoPicture),
                value: !_picture,
                onChanged: (v) => setState(() => _picture = !v),
              ),
              if (people.isNotEmpty)
                OutlinedButton.icon(
                  key: const ValueKey('live-notice-to-one'),
                  onPressed: () => _toOne(people),
                  icon: const Icon(Icons.person_rounded),
                  label: Text(s.liveNoticeToOne),
                ),
            ],
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
