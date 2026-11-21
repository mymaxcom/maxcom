// Tambah pengguna in three steps (`/users/new`): from a name to a phone that
// is in.
//
// 1. The person: name, phone number (optional, E.164 by `normalisePhone`),
//    what they will do (AJK ticked), and one folded line for the device name
//    and how long the code is good for (30 minutes here; the plain Daftar
//    peranti page keeps 10). "Simpan dan buat kod QR" creates the person, then
//    the code. When the code cannot be made (through the cloud, `box_only`,
//    no connection, an older box) the person stays saved and the flow ends on
//    the list with `addSavedNoQr`.
// 2. Hand over: the QR (176 px, so the buttons fit on a phone), the countdown
//    and the 12-character check value; "WhatsApp kepada {name}" (that one
//    number only), "Kongsi" (the phone's share sheet) and "Salin kod" (the
//    text the manual field accepts). Both share buttons are preceded by one
//    confirm naming the person ("Hantar kepada {name} sahaja", "Teruskan").
//    No share of any kind when the box made no `sharePayload` (it has no
//    numbered local name: the QR would carry a LAN address), nor for a person
//    who will hold Pentadbir while the app lock is off (in person only).
//    The bottom bar, pinned under the page, says "Menunggu {name} mendaftar"
//    beside "Tamatkan kod ini"; it polls `GET /api/enrol/recent` every 3
//    seconds while the code is alive (10 after 5 minutes).
// 3. Done: the device that used the code, with "Bukan telefon {name}? Padam
//    peranti ini" and the reuse warning when another phone tried the used code.
//
// Leaving step 2 by the back button keeps the code alive (the Peranti tab
// lists it with "Tamatkan kod"). The phone number is never logged, put in an
// error or shown anywhere but here and on the person's page.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/app_lang.dart';
import '../app/providers.dart';
import '../app/router.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../box/box_client.dart';
import '../features/common/error_text.dart';
import '../features/common/ltr.dart';
import '../features/common/roles.dart';
import '../features/common/time_words.dart';
import '../features/finance/share.dart' as share;
import '../features/people/people_api.dart';
import '../features/people/people_words.dart';
import '../features/people/phone.dart';
import '../features/people/ref.dart';
import '../features/sync/live_only_dialog.dart';
import '../sync/live_only.dart' show Uncertain;
import '../l10n/generated/s.dart';
import 'enrol_qr_screen.dart' show EnrolQrCard;
import 'users_screen.dart' show usersPath;
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

/// How step 2 hands the code over; a test replaces it.
class UserAddShare {
  const UserAddShare({
    this.shareText = _shareText,
    this.openWhatsApp = _openWhatsApp,
    this.openWhatsAppText = _openWhatsAppText,
  });

  final Future<share.ShareResult> Function(String text) shareText;
  final Future<bool> Function(Uri waUri) openWhatsApp;

  /// WhatsApp's own picker with the text and no recipient (a person with no
  /// phone number).
  final Future<bool> Function(String text) openWhatsAppText;

  static Future<share.ShareResult> _shareText(String text) => share.shareText(text);
  static Future<bool> _openWhatsApp(Uri uri) => share.openWhatsApp(uri);
  static Future<bool> _openWhatsAppText(String text) => share.openWhatsAppShare(text);
}

final userAddShareProvider = Provider<UserAddShare>((ref) => const UserAddShare());

/// The roles of step 1, in the order the mockup lists them.
const List<String> _addRoles = ['ajk', 'treasurer', 'media', 'live', 'admin'];

/// Polls at 3 seconds for the first 5 minutes, then at 10.
const Duration _pollFast = Duration(seconds: 3);
const Duration _pollSlow = Duration(seconds: 10);
const int _fastPolls = 100;

enum _Step { form, handOver, ended, done }

class UserAddFlow extends ConsumerStatefulWidget {
  const UserAddFlow({super.key});

  @override
  ConsumerState<UserAddFlow> createState() => _UserAddFlowState();
}

class _UserAddFlowState extends ConsumerState<UserAddFlow> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _device = TextEditingController();
  final Set<String> _roles = {'ajk'};
  bool _deviceTouched = false;
  bool _deviceOpen = false;
  int _ttl = 30;

  String? _nameError;
  String? _phoneError;
  String? _roleError;
  String? _deviceError;
  String? _error;
  bool _busy = false;

  _Step _step = _Step.form;

  /// The saved person (after step 1).
  UserDto? _user;
  String _e164 = '';

  InvitationDto? _inv;
  Timer? _ticker;
  String _countdown = '';
  bool _expired = false;

  Timer? _poll;
  int _polls = 0;
  RecentCodeDto? _used;

  @override
  void dispose() {
    _ticker?.cancel();
    _poll?.cancel();
    _name.dispose();
    _phone.dispose();
    _device.dispose();
    super.dispose();
  }

  // ---- step 1 ----

  String _defaultDevice(S s) {
    final name = cleanedName(_name.text);
    final out = s.addDefaultDevice(name.isEmpty ? '' : name).trim();
    return out.length > 80 ? out.substring(0, 80).trim() : out;
  }

  String _deviceName(S s) => _deviceTouched ? cleanedName(_device.text) : _defaultDevice(s);

  Future<void> _save() async {
    if (_busy) return;
    final s = S.of(context);
    final rawPhone = _phone.text.trim();
    final e164 = rawPhone.isEmpty ? null : normalisePhone(rawPhone);
    // The phone number is optional: empty is accepted, a typed one must be valid.
    final device = _deviceName(s);
    setState(() {
      _nameError = nameProblem(s, _name.text);
      _phoneError = rawPhone.isNotEmpty && e164 == null ? s.phoneInvalid : null;
      _roleError = _roles.isEmpty ? s.userRoleRequired : null;
      _deviceError = nameIsValid(device) ? null : s.nameInvalid;
      if (_deviceError != null) _deviceOpen = true;
      _error = null;
    });
    if (_nameError != null || _phoneError != null || _roleError != null || _deviceError != null) return;
    setState(() => _busy = true);
    final api = ref.read(peopleApiProvider);
    final phone164 = e164;
    UserDto? created;
    try {
      try {
        created = await api.createUser(
          name: _name.text,
          roles: orderedRoles(_roles),
          phone: phone164,
        );
      } on Uncertain {
        // The box may have saved the person: look, and go on when it did.
        // Without a phone number, look by the name and the time, so a second
        // tap does not add the same person twice.
        try {
          created = phone164 == null ? await api.findUserJustAdded(_name.text) : await api.findUserByPhone(phone164);
        } catch (_) {
          created = null;
        }
        if (created == null) rethrow;
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        if (e is BoxError && (e.code == 'phone_taken' || e.code == 'bad_phone' || e.code == 'phone_required')) {
          _phoneError = errorText(s, e);
        } else if (e is BoxError && e.code == 'bad_name') {
          _nameError = s.nameInvalid;
        } else {
          _error = errorText(s, e);
        }
      });
      await showLiveOnlyIf(context, e);
      return;
    }
    final user = created;
    ref.invalidate(boxJsonProvider(usersPath));
    if (!mounted) return;
    _user = user;
    _e164 = phone164 ?? '';
    // A surau person's code is made by the box on the surau Wi-Fi only.
    if (ref.read(isCloudGatewayProvider)) {
      _savedNoQr(user);
      return;
    }
    await _makeCode(device: device, savedNoQrOnFail: true);
  }

  void _savedNoQr(UserDto user) {
    final s = S.of(context);
    toast(context, s.addSavedNoQr(user.name));
    context.go(AppRoutes.users);
  }

  /// `beginEnrol` for the saved person. On the first try a failure ends the
  /// flow on the list (the person is saved); a later "Jana kod baharu" shows
  /// the error on the page.
  Future<void> _makeCode({String? device, bool savedNoQrOnFail = false}) async {
    final s = S.of(context);
    final user = _user!;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final inv = await ref.read(peopleApiProvider).beginEnrol(
        userId: user.id,
        deviceName: device ?? _deviceName(s),
        ttlMinutes: _ttl,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _inv = inv;
        _used = null;
        _expired = false;
        _countdown = '';
        _step = _Step.handOver;
      });
      _startTicking();
      _startPolling();
    } catch (e) {
      if (!mounted) return;
      if (savedNoQrOnFail) {
        _savedNoQr(user);
        return;
      }
      setState(() {
        _busy = false;
        _error = errorText(s, e);
      });
      await showLiveOnlyIf(context, e);
    }
  }

  // ---- step 2: countdown and polling ----

  void _startTicking() {
    _ticker?.cancel();
    _tick();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
  }

  void _tick() {
    final inv = _inv;
    if (inv == null || !mounted) return;
    final left = inv.expiresAt.difference(ref.read(appDepsProvider).now());
    final expired = left <= Duration.zero;
    final secs = expired ? 0 : left.inSeconds;
    final shown = '${(secs ~/ 60).toString().padLeft(2, '0')}:${(secs % 60).toString().padLeft(2, '0')}';
    if (shown == _countdown && expired == _expired) return;
    if (expired) {
      _ticker?.cancel();
      _poll?.cancel();
    }
    setState(() {
      _countdown = shown;
      _expired = expired;
    });
  }

  void _startPolling() {
    _poll?.cancel();
    _polls = 0;
    _schedulePoll();
  }

  void _schedulePoll() {
    _poll?.cancel();
    _poll = Timer(_polls < _fastPolls ? _pollFast : _pollSlow, _pollOnce);
  }

  Future<void> _pollOnce() async {
    final inv = _inv;
    if (!mounted || inv == null || _expired || _step != _Step.handOver) return;
    _polls++;
    List<RecentCodeDto> rows;
    try {
      rows = await ref.read(peopleApiProvider).recentCodes();
    } on PeopleNeedsUpdate {
      return; // an older box: no device is reported, the code still works
    } catch (_) {
      rows = const [];
    }
    if (!mounted || _inv?.id != inv.id || _step != _Step.handOver) return;
    final row = rows.where((r) => r.id == inv.id).firstOrNull;
    if (row != null && row.cancelledAt == null && row.device != null) {
      _ticker?.cancel();
      setState(() {
        _used = row;
        _step = _Step.done;
      });
      return;
    }
    _schedulePoll();
  }

  Future<void> _endCode() async {
    final s = S.of(context);
    final inv = _inv;
    final user = _user;
    if (inv == null || user == null || _busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(peopleApiProvider).cancelCode(id: inv.id, userId: user.id);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      toast(context, errorText(s, e));
      await showLiveOnlyIf(context, e);
      return;
    }
    if (!mounted) return;
    _ticker?.cancel();
    _poll?.cancel();
    setState(() {
      _busy = false;
      _inv = null;
      _step = _Step.ended;
    });
    toast(context, s.devicesCodeEnded);
  }

  // ---- step 2: hand over ----

  /// No share at all without the reduced text, and none for a future
  /// Pentadbir while the app lock is off.
  bool get _shareAllowed {
    if (_inv?.sharePayload == null) return false;
    if (_roles.contains('admin') && !ref.read(appLockProvider)) return false;
    return true;
  }

  String _shareMessage(S s) {
    final surau = ref.read(surauInfoProvider)?.name ?? 'MAXCOM';
    return '${s.addShareText(_user!.name, surau, _ttl)}\n${_inv!.sharePayload}';
  }

  Future<bool> _confirmOne({required bool whatsApp}) {
    final s = S.of(context);
    final name = _user!.name;
    return confirmDialog(
      context,
      title: s.addShareConfirmTitle(name),
      body: s.addShareConfirmBody(name),
      confirm: s.shareContinue,
      extra: whatsApp && _e164.isNotEmpty
          ? Text(
              s.waOpensTo(ltr(formatPhone(_e164))),
              key: const ValueKey('add-wa-opens-to'),
              style: Theme.of(context).textTheme.bodyMedium!.copyWith(fontWeight: FontWeight.w600),
            )
          : null,
    );
  }

  Future<void> _whatsApp() async {
    final s = S.of(context);
    if (!_shareAllowed || !await _confirmOne(whatsApp: true) || !mounted) return;
    var opened = false;
    try {
      final out = ref.read(userAddShareProvider);
      // With no phone number WhatsApp opens its own picker with the text.
      opened = _e164.isEmpty
          ? await out.openWhatsAppText(_shareMessage(s))
          : await out.openWhatsApp(whatsAppUri(_e164, _shareMessage(s)));
    } catch (_) {
      opened = false;
    }
    if (!opened && mounted) toast(context, s.waUnavailable);
  }

  Future<void> _share() async {
    final s = S.of(context);
    if (!_shareAllowed || !await _confirmOne(whatsApp: false) || !mounted) return;
    final text = _shareMessage(s);
    var unavailable = false;
    try {
      unavailable = (await ref.read(userAddShareProvider).shareText(text)).unavailable;
    } catch (_) {
      unavailable = true;
    }
    if (!unavailable || !mounted) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) toast(context, s.enrolQrCopied);
  }

  /// The text the enrolling phone's manual field accepts.
  Future<void> _copy() async {
    final s = S.of(context);
    final text = _inv?.sharePayload;
    if (text == null || !_shareAllowed) return;
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) toast(context, s.enrolQrCopied);
  }

  // ---- step 3 ----

  Future<void> _notTheirs() async {
    final s = S.of(context);
    final device = _used?.device;
    if (device == null || _busy) return;
    final ok = await confirmDialog(
      context,
      title: s.devicesRevokeTitle(device.name),
      body: s.deviceRemoveHint,
      confirm: s.devicesRevoke,
      destructive: true,
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(peopleApiProvider).revokeDevice(device.id);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      toast(context, errorText(s, e));
      await showLiveOnlyIf(context, e);
      return;
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _inv = null;
      _used = null;
      _step = _Step.ended;
    });
    toast(context, s.devicesRevokedToast(device.name));
  }

  void _another() {
    _ticker?.cancel();
    _poll?.cancel();
    setState(() {
      _name.clear();
      _phone.clear();
      _device.clear();
      _roles
        ..clear()
        ..add('ajk');
      _deviceTouched = false;
      _deviceOpen = false;
      _ttl = 30;
      _nameError = _phoneError = _roleError = _deviceError = _error = null;
      _user = null;
      _e164 = '';
      _inv = null;
      _used = null;
      _step = _Step.form;
    });
  }

  // ---- build ----

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final stepNo = switch (_step) {
      _Step.form => 1,
      _Step.handOver || _Step.ended => 2,
      _Step.done => 3,
    };
    final children = <Widget>[
      _StepMark(step: stepNo),
      const SizedBox(height: 6),
      Text(
        s.addStep(stepNo),
        key: const ValueKey('add-step'),
        style: Theme.of(context).textTheme.bodySmall!.copyWith(color: SurauColors.muted),
      ),
      const SizedBox(height: 14),
      ...switch (_step) {
        _Step.form => _form(context),
        _Step.handOver => _handOver(context),
        _Step.ended => _ended(context),
        _Step.done => _done(context),
      },
    ];
    final waiting = _step == _Step.handOver && !_expired && _inv != null;
    return ShellPage(
      title: s.usersAdd,
      body: Column(
        children: [
          Expanded(child: SurauTheme.page(children: children)),
          if (waiting) _WaitingBar(name: _user!.name, busy: _busy, onEnd: _endCode),
        ],
      ),
    );
  }

  List<Widget> _form(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final device = _deviceName(s);
    return [
      TextField(
        key: const ValueKey('add-name'),
        controller: _name,
        autofocus: true,
        textCapitalization: TextCapitalization.words,
        textInputAction: TextInputAction.next,
        maxLength: 80,
        decoration: InputDecoration(
          labelText: s.userNameLabel,
          helperText: s.addNameHint,
          helperMaxLines: 2,
          errorText: _nameError,
          counterText: '',
        ),
        onChanged: (_) => setState(() => _nameError = null),
      ),
      const SizedBox(height: 14),
      TextField(
        key: const ValueKey('add-phone'),
        controller: _phone,
        keyboardType: TextInputType.phone,
        textInputAction: TextInputAction.done,
        textDirection: TextDirection.ltr,
        maxLength: 24,
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+ ()\-.٠-٩۰-۹]'))],
        decoration: InputDecoration(
          labelText: s.phoneLabelOptional,
          hintText: s.phoneHint,
          helperText: s.phoneWhatsAppHint,
          helperMaxLines: 3,
          errorText: _phoneError,
          errorMaxLines: 3,
          counterText: '',
        ),
        onChanged: (_) {
          if (_phoneError != null) setState(() => _phoneError = null);
        },
      ),
      const SizedBox(height: 22),
      Text(s.addWhatRole, style: text.titleSmall),
      const SizedBox(height: 8),
      Card(
        child: Column(
          children: [
            for (var i = 0; i < _addRoles.length; i++) ...[
              if (i > 0) const Divider(),
              CheckboxListTile(
                key: ValueKey('add-role-${_addRoles[i]}'),
                value: _roles.contains(_addRoles[i]),
                onChanged: _busy
                    ? null
                    : (v) => setState(() {
                        if (v ?? false) {
                          _roles.add(_addRoles[i]);
                        } else {
                          _roles.remove(_addRoles[i]);
                        }
                        if (_roles.isNotEmpty) _roleError = null;
                      }),
                controlAffinity: ListTileControlAffinity.leading,
                title: Text(roleLabel(s, _addRoles[i])),
                subtitle: Text(_roleHint(s, _addRoles[i])),
                contentPadding: const EdgeInsetsDirectional.fromSTEB(12, 4, 16, 4),
              ),
            ],
          ],
        ),
      ),
      if (_roleError != null) ...[const SizedBox(height: 8), ErrorLine(_roleError!)],
      const SizedBox(height: 14),
      _DeviceFold(
        open: _deviceOpen,
        summary: s.addDeviceSummary(isolate(device), _ttl),
        onOpen: () => setState(() {
          _deviceOpen = true;
          if (!_deviceTouched) _device.text = _defaultDevice(s);
          _deviceTouched = true;
        }),
        field: TextField(
          key: const ValueKey('add-device-name'),
          controller: _device,
          textCapitalization: TextCapitalization.sentences,
          maxLength: 80,
          decoration: InputDecoration(
            labelText: s.deviceNameLabel,
            helperText: s.deviceNameHint,
            helperMaxLines: 2,
            errorText: _deviceError,
            counterText: '',
          ),
          onChanged: (_) => setState(() => _deviceError = null),
        ),
        ttl: _TtlChoice(
          value: _ttl,
          onChanged: _busy ? null : (m) => setState(() => _ttl = m),
        ),
      ),
      if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
      const SizedBox(height: 20),
      FilledButton.icon(
        key: const ValueKey('add-save'),
        onPressed: _busy ? null : _save,
        icon: const Icon(Icons.qr_code_2_rounded),
        label: Text(s.addSaveAndQr),
      ),
    ];
  }

  static String _roleHint(S s, String role) => switch (role) {
    'admin' => s.addRoleAdmin,
    'treasurer' => s.addRoleBendahari,
    'media' => s.addRoleMedia,
    'live' => s.addRoleLive,
    _ => s.addRoleAjk,
  };

  List<Widget> _handOver(BuildContext context) {
    final s = S.of(context);
    final inv = _inv!;
    final user = _user!;
    final lockOn = ref.watch(appLockProvider);
    final adminTarget = _roles.contains('admin');
    final String? shareNote = inv.sharePayload == null
        ? s.addShareUnavailable
        : (adminTarget && !lockOn ? s.addShareAdminInPerson : null);
    return [
      EnrolQrCard(
        invitation: inv,
        countdown: _countdown,
        expired: _expired,
        title: s.addScanTitle(user.name),
        qrSize: 176,
      ),
      const SizedBox(height: 12),
      if (_expired) ...[
        ErrorLine(s.enrolQrExpired),
        const SizedBox(height: 10),
        FilledButton.icon(
          key: const ValueKey('add-new-code'),
          onPressed: _busy ? null : () => _makeCode(),
          icon: const Icon(Icons.refresh_rounded),
          label: Text(s.enrolQrNew),
        ),
      ] else if (shareNote != null)
        _Note(key: const ValueKey('add-share-note'), icon: Icons.qr_code_scanner_rounded, text: shareNote)
      else ...[
        FilledButton.icon(
          key: const ValueKey('add-wa'),
          onPressed: _busy ? null : _whatsApp,
          icon: const Icon(Icons.chat_rounded),
          label: Text(s.waTo(user.name), maxLines: 1, overflow: TextOverflow.ellipsis),
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                key: const ValueKey('add-share'),
                onPressed: _busy ? null : _share,
                icon: const Icon(Icons.share_rounded),
                label: Text(s.addShare),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                key: const ValueKey('add-copy'),
                onPressed: _busy ? null : _copy,
                icon: const Icon(Icons.copy_rounded),
                label: Text(s.enrolQrCopy),
              ),
            ),
          ],
        ),
      ],
      if (!lockOn) ...[
        const SizedBox(height: 12),
        _Note(
          key: const ValueKey('add-lock-off'),
          icon: Icons.lock_open_rounded,
          text: s.addLockOffHint,
          onTap: () => context.push(AppRoutes.settingsFor('appLock')),
        ),
      ],
      if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
    ];
  }

  List<Widget> _ended(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            children: [
              const Icon(Icons.qr_code_2_rounded, size: 40, color: SurauColors.muted),
              const SizedBox(height: 10),
              Text(
                s.devicesCodeEnded,
                key: const ValueKey('add-ended'),
                textAlign: TextAlign.center,
                style: text.bodyLarge,
              ),
            ],
          ),
        ),
      ),
      if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
      const SizedBox(height: 16),
      FilledButton.icon(
        key: const ValueKey('add-new-code'),
        onPressed: _busy ? null : () => _makeCode(),
        icon: const Icon(Icons.refresh_rounded),
        label: Text(s.enrolQrNew),
      ),
      const SizedBox(height: 8),
      TextButton(
        onPressed: () => context.go(AppRoutes.users),
        child: Text(s.addBackToList),
      ),
    ];
  }

  List<Widget> _done(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final user = _user!;
    final row = _used!;
    final device = row.device!;
    final lang = ref.watch(appLangProvider);
    final at = device.enrolledAt ?? row.usedAt;
    final when = at == null ? '' : timeOfDayWords(ref.read(appDepsProvider).toLocal(at), lang: lang);
    return [
      const SizedBox(height: 8),
      Center(
        child: Container(
          width: 64,
          height: 64,
          decoration: const BoxDecoration(color: SurauColors.successSoft, shape: BoxShape.circle),
          child: const Icon(Icons.check_rounded, size: 36, color: SurauColors.success),
        ),
      ),
      const SizedBox(height: 14),
      Text(
        s.addDoneTitle(user.name),
        key: const ValueKey('add-done'),
        textAlign: TextAlign.center,
        style: text.headlineSmall,
      ),
      const SizedBox(height: 4),
      Center(child: RefText(user.ref ?? row.userRef, style: const TextStyle(fontSize: 15))),
      const SizedBox(height: 8),
      Text(
        s.addDoneBody(rolesSentence(s, orderedRoles(_roles))),
        textAlign: TextAlign.center,
        style: text.bodyLarge,
      ),
      const SizedBox(height: 18),
      Card(
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 14, 16, 14),
          child: Row(
            children: [
              Icon(platformIcon(device.platform), color: SurauColors.teal),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      isolate(device.name),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: text.titleSmall,
                    ),
                    RefText(device.ref),
                    const SizedBox(height: 2),
                    Text(
                      s.addDoneDevice(platformLabel(s, device.platform), ltr(when)),
                      key: const ValueKey('add-done-device'),
                      style: text.bodySmall!.copyWith(color: SurauColors.muted),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      if (row.reuseAttempts > 0) ...[
        const SizedBox(height: 10),
        _Note(
          key: const ValueKey('add-reuse'),
          icon: Icons.warning_amber_rounded,
          text: s.addReuseWarning(row.reuseAttempts),
          warn: true,
        ),
      ],
      const SizedBox(height: 6),
      Align(
        alignment: AlignmentDirectional.centerStart,
        child: TextButton(
          key: const ValueKey('add-not-theirs'),
          onPressed: _busy ? null : _notTheirs,
          style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
          child: Text(s.addNotTheirs(user.name)),
        ),
      ),
      const SizedBox(height: 14),
      FilledButton.icon(
        key: const ValueKey('add-another'),
        onPressed: _another,
        icon: const Icon(Icons.person_add_alt_1_rounded),
        label: Text(s.addAnother),
      ),
      const SizedBox(height: 8),
      OutlinedButton(
        key: const ValueKey('add-back'),
        onPressed: () => context.go(AppRoutes.users),
        child: Text(s.addBackToList),
      ),
    ];
  }
}

/// Three short bars, the first [step] of them filled (mirrors in Arabic).
class _StepMark extends StatelessWidget {
  const _StepMark({required this.step});

  final int step;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: Row(
        children: [
          for (var i = 1; i <= 3; i++) ...[
            if (i > 1) const SizedBox(width: 6),
            Expanded(
              child: Container(
                height: 4,
                decoration: BoxDecoration(
                  color: i <= step ? SurauColors.teal : SurauColors.line,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// "Telefon Encik Rahman, kod sah 30 minit" with "Tukar nama peranti atau
/// tempoh"; opened: the device name and the validity.
class _DeviceFold extends StatelessWidget {
  const _DeviceFold({
    required this.open,
    required this.summary,
    required this.onOpen,
    required this.field,
    required this.ttl,
  });

  final bool open;
  final String summary;
  final VoidCallback onOpen;
  final Widget field;
  final Widget ttl;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 12, 12),
        child: open
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  field,
                  const SizedBox(height: 12),
                  Text(s.enrolTtlLabel, style: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 8),
                  ttl,
                ],
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.phone_android_rounded, color: SurauColors.muted, size: 20),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          summary,
                          key: const ValueKey('add-device-summary'),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: text.bodyMedium,
                        ),
                      ),
                    ],
                  ),
                  TextButton(
                    key: const ValueKey('add-change-device'),
                    onPressed: onOpen,
                    style: TextButton.styleFrom(padding: const EdgeInsetsDirectional.fromSTEB(30, 8, 8, 8)),
                    child: Text(s.addChangeDevice),
                  ),
                ],
              ),
      ),
    );
  }
}

class _TtlChoice extends StatelessWidget {
  const _TtlChoice({required this.value, required this.onChanged});

  final int value;
  final ValueChanged<int>? onChanged;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return SegmentedButton<int>(
      key: const ValueKey('add-ttl'),
      segments: [
        for (final m in const [10, 30, 60])
          ButtonSegment(value: m, label: Text(s.enrolTtlMinutes(m), key: ValueKey('add-ttl-$m'))),
      ],
      selected: {value},
      showSelectedIcon: false,
      style: ButtonStyle(
        minimumSize: const WidgetStatePropertyAll(Size(0, 48)),
        textStyle: WidgetStatePropertyAll(text.labelMedium),
        side: const WidgetStatePropertyAll(BorderSide(color: SurauColors.line)),
        backgroundColor: WidgetStateProperty.resolveWith(
          (st) => st.contains(WidgetState.selected) ? SurauColors.tealSoft : SurauColors.card,
        ),
        foregroundColor: WidgetStateProperty.resolveWith(
          (st) => st.contains(WidgetState.selected) ? SurauColors.glass : SurauColors.teal,
        ),
      ),
      onSelectionChanged: onChanged == null ? null : (sel) => onChanged!(sel.first),
    );
  }
}

/// A calm one-line note with an icon (gold when [warn]); tappable when
/// [onTap] is given.
class _Note extends StatelessWidget {
  const _Note({super.key, required this.icon, required this.text, this.onTap, this.warn = false});

  final IconData icon;
  final String text;
  final VoidCallback? onTap;
  final bool warn;

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme.bodyMedium!.copyWith(color: SurauColors.text);
    return Material(
      color: warn ? SurauColors.goldSoft : SurauColors.paperDeep,
      borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(12, 10, 12, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 20, color: warn ? SurauColors.ink : SurauColors.muted),
              const SizedBox(width: 10),
              Expanded(child: Text(text, style: style)),
              if (onTap != null) ...[
                const SizedBox(width: 6),
                const Icon(Icons.chevron_right_rounded, size: 20, color: SurauColors.muted),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Pinned under the page while the code is alive: "Menunggu {name}
/// mendaftar" beside "Tamatkan kod ini".
class _WaitingBar extends StatelessWidget {
  const _WaitingBar({required this.name, required this.busy, required this.onEnd});

  final String name;
  final bool busy;
  final VoidCallback onEnd;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Material(
      key: const ValueKey('add-bottom-bar'),
      color: SurauColors.card,
      child: DecoratedBox(
        decoration: const BoxDecoration(border: Border(top: BorderSide(color: SurauColors.line))),
        child: SafeArea(
          top: false,
          child: ContentColumn(
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(20, 10, 16, 10),
              child: Row(
                children: [
                  const Icon(Icons.sync_rounded, size: 18, color: SurauColors.teal),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      s.addWaiting(isolate(name)),
                      key: const ValueKey('add-waiting'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: text.bodyMedium!.copyWith(color: SurauColors.muted),
                    ),
                  ),
                  const SizedBox(width: 10),
                  OutlinedButton(
                    key: const ValueKey('add-end-code'),
                    onPressed: busy ? null : onEnd,
                    style: OutlinedButton.styleFrom(foregroundColor: SurauColors.danger),
                    child: Text(s.addEndCode),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
