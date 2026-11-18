// Plan 14 Task 26: `Daftar peranti MAXCOM`, the ops build's only way to enrol.
// Reached only through `if (kOpsBuild)` (the welcome-screen entry below).
//
// Step 1 audit (what a cloud-only enrolment needs of the box-shaped types):
// - EnrolledBox: `box` = cloud origin, `boxId` = the cloud's own id from
//   GET /api/box/info, `cloud` = the same origin, `caSha256` = null (the field
//   is nullable already), `userName` = '' (the unlock session supplies the
//   name; the shell prefers it). No new field is needed.
// - EnrolTrust / CA pin: not used. usesPublicTls(b) (box == cloud, host under
//   mymaxcom.my) makes TrustStore.clientFor return a system-trust client, so
//   the unlock path never asks for a CA. OpsEnrolFlow therefore takes no
//   EnrolTrust at all and never calls establish/commit.
// - No LAN origin and no QR payload: the box locator/offline paths key off
//   `cloud != box`; with both equal the app only ever speaks to the cloud
//   ("via" cloud). Nothing in enrol_flow.dart changes: OpsEnrolFlow is the
//   cloud twin, kept in lib/ops/enrol/.
// - Smallest hooks outside lib/ops: BoxClient.enrolComplete(client:) (sent only
//   when kOpsBuild) and one `if (kOpsBuild)` entry in EnrolScreen's capture view.
// - The unlock needs the user's PIN (a Pentadbir MAXCOM always has the lock),
//   so /api/auth/me can only be read after it. The router guard does that check after the unlock:
//   `opsRevokedProvider` -> OpsRoutes.unmarked -> [OpsUnmarkedNotice]; ops true needs nothing new,
//   `needsSurauProvider` already sends it to the Armada.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../box/trust.dart' show PinnedEnrolTrust;
import '../../features/enrol/enrol_flow.dart';
import '../ops_build.dart';
import 'ops_enrol_flow.dart';
import 'ops_enrol_texts.dart';

/// True only in the ops build; the public build has no such screen.
const bool opsWelcomeEntryAvailable = kOpsBuild;

OpsEnrolTexts _texts(BuildContext context) =>
    OpsEnrolTexts.of(Localizations.localeOf(context).languageCode);

/// The welcome-screen entry: a button that opens [OpsEnrolScreen]. Call sites
/// guard it with `if (kOpsBuild)`.
class OpsEnrolEntry extends StatelessWidget {
  const OpsEnrolEntry({super.key, required this.flow, required this.onEnrolled});

  /// The ordinary flow of the welcome screen; only its client builder, key,
  /// store and platform are reused.
  final EnrolFlow flow;
  final void Function(EnrolOutcome outcome) onEnrolled;

  @override
  Widget build(BuildContext context) {
    final t = _texts(context);
    return Padding(
      padding: const EdgeInsets.only(top: 24),
      child: Column(
        children: [
          OutlinedButton.icon(
            key: const ValueKey('ops-enrol-entry'),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => OpsEnrolScreen(
                  flow: OpsEnrolFlow(
                    // No CA exists before enrolment: the cloud is reached over
                    // public TLS (system trust), never the QR flow's pinned client.
                    clientFor: switch (flow.trust) {
                      final PinnedEnrolTrust t => t.publicCloudClient,
                      _ => flow.clientFor,
                    },
                    key: flow.key,
                    store: flow.store,
                    platform: flow.platform,
                  ),
                  onEnrolled: onEnrolled,
                ),
              ),
            ),
            icon: const Icon(Icons.terminal),
            label: Text(t.entry),
          ),
          const SizedBox(height: 8),
          Text(t.entryHint, textAlign: TextAlign.center),
        ],
      ),
    );
  }
}

class _CodeFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue old, TextEditingValue next) {
    final g = groupOpsCode(next.text);
    return TextEditingValue(
      text: g,
      selection: TextSelection.collapsed(offset: g.length),
    );
  }
}

class OpsEnrolScreen extends StatefulWidget {
  const OpsEnrolScreen({super.key, required this.flow, required this.onEnrolled});

  final OpsEnrolFlow flow;

  /// The person pressed Teruskan after a successful enrolment.
  final void Function(EnrolOutcome outcome) onEnrolled;

  @override
  State<OpsEnrolScreen> createState() => _OpsEnrolScreenState();
}

class _OpsEnrolScreenState extends State<OpsEnrolScreen> {
  final _code = TextEditingController();
  final _name = TextEditingController();
  bool _seeded = false;
  bool _busy = false;
  String? _error;
  EnrolOutcome? _done;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_seeded) {
      _seeded = true;
      _name.text = _texts(context).defaultDeviceName;
    }
  }

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  String _explain(OpsEnrolTexts t, Object e) {
    if (e is BoxError) {
      return switch (e.code) {
        'bad_enrol_code' ||
        'enrol_code_unknown' ||
        'enrol_code_expired' ||
        'enrol_code_used' => t.badCode,
        'ops_app_required' => t.appRequired,
        'ops_device_limit' => t.limit,
        _ => e.status == 429 ? t.tooMany : t.generic,
      };
    }
    if (e is TrustError) return t.tlsFailed;
    if (e is BoxUnreachable) return t.offline;
    if (e is OpsCodeInvalid) return t.badCode;
    if (e is EnrolAlreadyEnrolled) return t.already;
    if (e is OpsEnrolSaveFailed) return t.saveFailed;
    return t.generic;
  }

  Future<void> _submit(OpsEnrolTexts t) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final out = await widget.flow.run(
        _code.text,
        deviceName: _name.text.trim().isEmpty ? t.defaultDeviceName : _name.text,
      );
      if (mounted) setState(() => _done = out);
    } on Object catch (e) {
      if (mounted) setState(() => _error = _explain(t, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = _texts(context);
    final text = Theme.of(context).textTheme;
    final done = _done;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(t.appBarKicker, style: text.labelSmall),
            Text(done == null ? t.entry : t.doneBar),
          ],
        ),
      ),
      body: done != null
          ? _buildDone(t, text, done)
          : SurauTheme.page(
              children: [
                Text(t.whereTitle, style: text.titleMedium),
                const SizedBox(height: 4),
                Text(t.whereBody),
                const SizedBox(height: 12),
                Text('1. ${t.step1}'),
                Text('2. ${t.step2}'),
                Text('3. ${t.step3}'),
                const SizedBox(height: 16),
                TextField(
                  key: const ValueKey('ops-enrol-code'),
                  controller: _code,
                  autocorrect: false,
                  enableSuggestions: false,
                  textCapitalization: TextCapitalization.characters,
                  inputFormatters: [_CodeFormatter()],
                  onChanged: (_) => setState(() => _error = null),
                  decoration: InputDecoration(labelText: '${t.codeLabel} *', hintText: 'XXXX-XXXX-XXXX'),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(_error!, key: const ValueKey('ops-enrol-error'), style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ],
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('ops-enrol-name'),
                  controller: _name,
                  decoration: InputDecoration(labelText: t.deviceLabel, helperText: t.deviceHelp),
                ),
                const SizedBox(height: 18),
                FilledButton(
                  key: const ValueKey('ops-enrol-submit'),
                  onPressed: _busy || !isOpsCodeReady(_code.text) ? null : () => _submit(t),
                  child: Text(_busy ? t.working : t.submit),
                ),
                const SizedBox(height: 10),
                Text(t.tls, textAlign: TextAlign.center, style: text.bodySmall),
              ],
            ),
    );
  }

  Widget _buildDone(OpsEnrolTexts t, TextTheme text, EnrolOutcome out) => SurauTheme.page(
    children: [
      const SizedBox(height: 24),
      const Icon(Icons.check_circle, size: 64, color: SurauColors.teal),
      const SizedBox(height: 8),
      Text(t.doneTitle, textAlign: TextAlign.center, style: text.titleLarge),
      const SizedBox(height: 6),
      Text(t.doneBody, textAlign: TextAlign.center),
      const SizedBox(height: 12),
      Text(t.doneKey, textAlign: TextAlign.center, style: text.bodySmall),
      const SizedBox(height: 24),
      FilledButton(
        key: const ValueKey('ops-enrol-continue'),
        onPressed: () => widget.onEnrolled(out),
        child: Text(t.next),
      ),
    ],
  );
}

/// `Peranti ini bukan lagi peranti MAXCOM`: shown instead of any ops screen when the cloud says `ops: false`.
/// [onThisDevice], when given, adds the way to the device page (to forget the enrolment and enrol again).
class OpsUnmarkedNotice extends StatelessWidget {
  const OpsUnmarkedNotice({super.key, this.onThisDevice, this.onRetry});

  final VoidCallback? onThisDevice;

  /// Asks the cloud again (the Pentadbir MAXCOM may have marked the phone again).
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final t = _texts(context);
    return Scaffold(
      appBar: AppBar(title: Text(t.appBarKicker)),
      body: SurauTheme.page(
        children: [
          const SizedBox(height: 24),
          Text(t.unmarkedTitle, key: const ValueKey('ops-unmarked'), style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Text(t.unmarkedBody),
          if (onRetry != null) ...[
            const SizedBox(height: 20),
            OutlinedButton(key: const ValueKey('ops-unmarked-retry'), onPressed: onRetry, child: Text(t.unmarkedRetry)),
          ],
          if (onThisDevice != null) ...[
            const SizedBox(height: 20),
            FilledButton(key: const ValueKey('ops-unmarked-device'), onPressed: onThisDevice, child: Text(t.unmarkedDevice)),
          ],
        ],
      ),
    );
  }
}
