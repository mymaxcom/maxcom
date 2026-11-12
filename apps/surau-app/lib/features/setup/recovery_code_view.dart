// The recovery code, shown once: big, to be written on paper. Android blocks
// screenshots while it is open (FLAG_SECURE); the web and iPad build cannot, so
// it says so in words. "Teruskan" waits for the tick that the code was written.

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../platform/secure_screen.dart';

class RecoveryCodeView extends StatefulWidget {
  const RecoveryCodeView({super.key, required this.code, required this.onContinue, this.title});

  /// `XXXX-XXXX-XXXX-XXXX`.
  final String code;
  final VoidCallback onContinue;

  /// Defaults to "Kod pemulihan anda".
  final String? title;

  @override
  State<RecoveryCodeView> createState() => _RecoveryCodeViewState();
}

class _RecoveryCodeViewState extends State<RecoveryCodeView> {
  bool _written = false;

  @override
  void initState() {
    super.initState();
    SecureScreen.enable();
  }

  @override
  void dispose() {
    SecureScreen.disable();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(widget.title ?? s.recoveryCodeTitle, style: text.titleLarge),
        const SizedBox(height: 6),
        Text(s.recoveryCodeOnce, style: text.titleSmall!.copyWith(color: SurauColors.danger)),
        const SizedBox(height: 16),
        Container(
          key: const ValueKey('recovery-code'),
          padding: const EdgeInsets.symmetric(vertical: 22, horizontal: 12),
          decoration: BoxDecoration(
            color: SurauColors.tealSoft.withValues(alpha: 0.55),
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
          ),
          child: Center(
            child: Text(
              widget.code,
              textAlign: TextAlign.center,
              style: text.headlineMedium!.copyWith(
                letterSpacing: 3,
                fontWeight: FontWeight.w700,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ),
        const SizedBox(height: 16),
        Text(s.recoveryCodePaper, style: text.bodyLarge),
        const SizedBox(height: 8),
        Text(s.recoveryCodeWhy, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        const SizedBox(height: 8),
        Text(s.recoveryCodeNoShare, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
        if (kIsWeb) ...[
          const SizedBox(height: 8),
          Text(
            s.recoveryCodeNoShotWeb,
            key: const ValueKey('recovery-code-web-warning'),
            style: text.bodyMedium!.copyWith(color: SurauColors.danger),
          ),
        ],
        const SizedBox(height: 16),
        CheckboxListTile(
          key: const ValueKey('recovery-code-written'),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          value: _written,
          onChanged: (v) => setState(() => _written = v ?? false),
          title: Text(s.recoveryCodeWritten),
        ),
        const SizedBox(height: 8),
        FilledButton(
          key: const ValueKey('recovery-code-continue'),
          onPressed: _written ? widget.onContinue : null,
          child: Text(s.actionContinue),
        ),
      ],
    );
  }
}
