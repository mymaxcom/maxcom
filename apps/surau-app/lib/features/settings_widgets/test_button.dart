// `Cuba sambungan`: asks the box to try an address (`POST
// /api/settings/test-source`) and shows the answer on one line. The box
// keeps nothing and reports only the status and the time; the route is for
// holders of `system:write`, so the button is absent for anyone else.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../shell/permissions.dart';

const String testSourcePath = '/api/settings/test-source';

class TestButton extends ConsumerStatefulWidget {
  const TestButton({super.key, required this.body, this.enabled = true});

  /// The request, for example `{kind: 'source', url: ...}`.
  final Map<String, Object?> body;
  final bool enabled;

  @override
  ConsumerState<TestButton> createState() => _TestButtonState();
}

enum _Run { idle, running, ok, bad }

class _TestButtonState extends ConsumerState<TestButton> {
  _Run _run = _Run.idle;
  String _line = '';

  Future<void> _go() async {
    final s = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _run = _Run.running;
      _line = s.settingsTestChecking;
    });
    try {
      final out = await gateway.post(testSourcePath, widget.body);
      if (!mounted) return;
      final ok = out['ok'] == true;
      final ms = (out['ms'] as num?)?.toInt() ?? 0;
      final status = (out['status'] as num?)?.toInt();
      setState(() {
        _run = ok ? _Run.ok : _Run.bad;
        _line = ok
            ? s.settingsTestOk(ms)
            : switch (out['error']) {
                'blocked_host' => s.settingsTestBlocked,
                'timeout' => s.settingsTestTimeout,
                'bad_url' => s.settingsTestBadUrl,
                _ => status == null ? s.settingsTestError : s.settingsTestStatus(status),
              };
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _run = _Run.bad;
        _line = s.settingsTestError;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!canSee(ref.watch(rolesProvider), 'system:write')) return const SizedBox.shrink();
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final color = switch (_run) {
      _Run.ok => const Color(0xFF1B6B3A),
      _Run.bad => SurauColors.danger,
      _ => SurauColors.muted,
    };
    return Wrap(
      spacing: 10,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        OutlinedButton.icon(
          key: const ValueKey('test-source'),
          onPressed: widget.enabled && _run != _Run.running ? _go : null,
          icon: const Icon(Icons.link_rounded, size: 20),
          label: Text(s.settingsTestConnection),
        ),
        if (_run != _Run.idle)
          Text(
            _line,
            key: const ValueKey('test-source-result'),
            style: text.bodySmall!.copyWith(color: color, fontWeight: FontWeight.w600),
          ),
      ],
    );
  }
}
