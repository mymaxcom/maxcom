// Lagi > Peranti ini > Imbas kod QR: a phone that already belongs to a surau scans
// a box QR. A probe proves the phone reaches the box (the TV's network check
// shows it); a setup, recovery or enrolment QR is refused with the "leave first"
// explanation, because one phone belongs to one surau.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart';
import '../setup/setup_providers.dart';
import 'enrol_screen.dart' show defaultScanner;
import 'join_errors.dart';
import 'scan_router.dart';

class ScanScreen extends ConsumerStatefulWidget {
  const ScanScreen({super.key});

  @override
  ConsumerState<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends ConsumerState<ScanScreen> {
  ScanOutcome? _outcome;
  bool _busy = false;
  bool _asking = false; // the camera keeps scanning behind the question
  final _paste = TextEditingController();

  @override
  void dispose() {
    _paste.dispose();
    super.dispose();
  }

  Future<void> _onCode(String text) async {
    if (_busy || _asking) return;
    setState(() => _busy = true);
    final router = ScanRouter(
      enrolled: ref.read(enrolledBoxProvider) != null,
      go: (path, {extra}) => context.go(path, extra: extra),
      flow: ref.read(setupFlowProvider),
    );
    var outcome = await router.route(text);
    if (!mounted) return;
    if (outcome is ScanProbeAsk) {
      final ask = outcome;
      setState(() {
        _busy = false; // the spinner must not run behind the question
        _asking = true;
      });
      final yes = await confirmDialog(
        context,
        title: S.of(context).probeAskTitle,
        body: S.of(context).probeAskBody(ask.host),
        confirm: S.of(context).probeAskConfirm,
      );
      if (!mounted) return;
      setState(() {
        _asking = false;
        _busy = yes;
      });
      if (!yes) return;
      outcome = await ask.confirm();
      if (!mounted) return;
    }
    setState(() {
      _busy = false;
      _outcome = outcome;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final deps = ref.watch(appDepsProvider);
    final surau = ref.watch(surauInfoProvider)?.name ?? s.productName;
    final o = _outcome;
    return ShellPage(
      title: s.scanEntry,
      body: SurauTheme.page(
        children: [
          Text(s.scanEntryHint, style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 8),
          Text(s.scanOnlyTvQr, key: const ValueKey('scan-only-tv'), style: text.bodyMedium),
          const SizedBox(height: 16),
          if (deps.cameraAvailable)
            SizedBox(
              height: 320,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                child: (deps.scannerBuilder ?? defaultScanner)(context, _onCode, () {}),
              ),
            )
          else ...[
            TextField(
              key: const ValueKey('scan-paste'),
              controller: _paste,
              decoration: InputDecoration(labelText: s.enrolPasteLabel),
              onSubmitted: _onCode,
            ),
            const SizedBox(height: 12),
            FilledButton(onPressed: () => _onCode(_paste.text), child: Text(s.actionContinue)),
          ],
          const SizedBox(height: 20),
          if (_busy) const Center(child: CircularProgressIndicator()),
          if (o is ScanProbeOk) DoneLine(s.probeOk),
          if (o is ScanUnknown) ErrorLine(s.scanUnknown),
          if (o is ScanFailed)
            JoinErrorView(
              error: o.error,
              currentSurau: surau,
              onLeave: () => context.go(AppRoutes.thisDevice),
              onRetry: () => setState(() => _outcome = null),
              onScanAnother: () => setState(() => _outcome = null),
            ),
        ],
      ),
    );
  }
}
