// Skrin TV: approving a new kiosk display. The box lists who is waiting
// (the address that asked and how long ago, never the code itself), so
// the admin can tell the surau's TV from a stranger before typing the
// six digits the TV shows. The answer names the screen and repeats the
// requester's address and the code's age.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/providers.dart';
import '../app/shell.dart';
import '../app/theme.dart';
import '../features/setup/setup_providers.dart';
import '../l10n/generated/s.dart';
import '../sync/sync_providers.dart' show syncViewProvider;
import 'devices_screen.dart' show devicesPath;
import 'widgets/box_read.dart';
import 'widgets/pieces.dart';

const String pendingPath = '/api/kiosk/pair/pending';

class PairingScreen extends ConsumerWidget {
  const PairingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    // Away from the surau network (the app is talking to the cloud) a display cannot be paired: the pending list
    // and the approval need the box on the surau Wi-Fi.
    final away = ref.watch(syncViewProvider).value?.via == 'cloud';
    return ShellPage(
      title: s.navPeople,
      body: SurauTheme.page(
        children: [
          const PeopleTabs(current: PeopleTab.pairing),
          const SizedBox(height: 20),
          Text(s.pairingTitle, style: text.titleLarge),
          const SizedBox(height: 6),
          Text(s.pairingIntro, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 24),
          if (away)
            Card(
              key: const ValueKey('pairing-needs-lan'),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.devicesNeedLan, style: text.titleSmall),
                    const SizedBox(height: 4),
                    Text(s.devicesNeedLanBody, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
                  ],
                ),
              ),
            )
          else ...[
            SectionLabel(s.pairingPendingTitle),
            const _PendingList(),
            const SizedBox(height: 24),
            const _ApproveForm(),
          ],
        ],
      ),
    );
  }
}

class _PendingList extends StatelessWidget {
  const _PendingList();

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return BoxReadView(
      path: pendingPath,
      builder: (context, body) {
        final rows = (body['pairings'] as List? ?? const []).cast<Map<String, dynamic>>();
        if (rows.isEmpty) {
          return Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
              child: Text(
                s.pairingPendingNone,
                style: text.bodyLarge!.copyWith(color: SurauColors.muted),
              ),
            ),
          );
        }
        return RowsCard(
          children: [
            for (final r in rows)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
                child: Row(
                  children: [
                    const Icon(Icons.tv_outlined, color: SurauColors.teal, size: 26),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            s.pairingPendingRow(
                              (r['requesterIp'] as String?) ?? s.pairingUnknownIp,
                              ageWords(s, (r['codeAgeSeconds'] as num? ?? 0).toInt()),
                            ),
                            style: text.titleSmall,
                          ),
                          const SizedBox(height: 2),
                          Text(s.pairingStrangerHint, style: text.bodySmall),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}

class _ApproveForm extends ConsumerStatefulWidget {
  const _ApproveForm();

  @override
  ConsumerState<_ApproveForm> createState() => _ApproveFormState();
}

class _ApproveFormState extends ConsumerState<_ApproveForm> {
  final _code = TextEditingController();
  final _name = TextEditingController();
  String? _codeError;
  String? _error;
  bool _busy = false;
  (String name, String ip, int age)? _done;

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _approve() async {
    final s = S.of(context);
    final code = _code.text.trim();
    if (code.length != 6) {
      setState(() => _codeError = s.pairingCodeRequired);
      return;
    }
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    final name = _name.text.trim();
    setState(() {
      _busy = true;
      _codeError = null;
      _error = null;
      _done = null;
    });
    try {
      final out = await gateway.post('/api/kiosk/pair/approve', {
        'code': code,
        if (name.isNotEmpty) 'deviceName': name,
      });
      if (!mounted) return;
      setState(() {
        _busy = false;
        _done = (
          out['name'] as String? ?? name,
          out['requesterIp'] as String? ?? s.pairingUnknownIp,
          (out['codeAgeSeconds'] as num? ?? 0).toInt(),
        );
        _code.clear();
        _name.clear();
      });
      ref.invalidate(boxJsonProvider(pendingPath));
      ref.invalidate(boxJsonProvider(devicesPath));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = writeErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final done = _done;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (done != null) ...[
          DoneLine(
            s.pairingDone(done.$1),
            detail: s.pairingDoneDetail(done.$2, ageWords(s, done.$3)),
          ),
          if (ref.watch(boxInfoProvider).value != null) ...[
            const SizedBox(height: 8),
            Text(
              s.devicesPairedMirrors(done.$1, ref.watch(boxInfoProvider).value!.name),
              key: const ValueKey('pairing-mirrors'),
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ],
          const SizedBox(height: 20),
        ],
        TextField(
          key: const ValueKey('pair-code'),
          controller: _code,
          keyboardType: TextInputType.number,
          inputFormatters: [
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(6),
          ],
          autocorrect: false,
          enableSuggestions: false,
          textAlign: TextAlign.center,
          style: text.headlineMedium!.copyWith(
            letterSpacing: 8,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
          decoration: InputDecoration(
            labelText: s.pairingCodeLabel,
            floatingLabelAlignment: FloatingLabelAlignment.center,
            errorText: _codeError,
            errorMaxLines: 2,
          ),
          onChanged: (_) {
            if (_codeError != null) setState(() => _codeError = null);
          },
        ),
        const SizedBox(height: 16),
        TextField(
          key: const ValueKey('pair-name'),
          controller: _name,
          textCapitalization: TextCapitalization.sentences,
          textInputAction: TextInputAction.done,
          maxLength: 80,
          decoration: InputDecoration(
            labelText: s.pairingNameLabel,
            hintText: s.pairingNameHint,
            counterText: '',
          ),
          onSubmitted: (_) => _approve(),
        ),
        if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
        const SizedBox(height: 20),
        FilledButton.icon(
          onPressed: _busy ? null : _approve,
          icon: const Icon(Icons.check_rounded),
          label: Text(s.pairingApprove),
        ),
      ],
    );
  }
}
