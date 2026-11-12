// `firstAzanSubuh.audioFile`: the MP3 files in the box's assets
// (`GET /api/assets?mime=audio/mpeg`) as a radio list, `Tiada fail`, and
// `Muat naik audio`. Picking a file is a browser feature here (the app has
// no file picker package), so the Android app says where to upload; the
// list and the choice work everywhere. Nothing plays yet: no audio package
// is available to the app.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart';
import '../../screens/widgets/pieces.dart';
import 'audio_file_pick.dart' as pick;

const String audioAssetListPath = '/api/assets?mime=audio/mpeg';

/// Null where the platform cannot pick a file. Overridden in tests.
final pickAudioProvider = Provider<Future<Uint8List?> Function()?>((ref) => pick.supported ? pick.pickAudioFile : null);

class AudioAssetPicker extends ConsumerStatefulWidget {
  const AudioAssetPicker({
    super.key,
    required this.path,
    required this.value,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String path;

  /// The asset id, or null for no file.
  final String? value;
  final void Function(Object? value) onChanged;
  final String? error;
  final bool readOnly;

  @override
  ConsumerState<AudioAssetPicker> createState() => _AudioAssetPickerState();
}

class _AudioAssetPickerState extends ConsumerState<AudioAssetPicker> {
  bool _busy = false;
  String? _uploadError;

  Future<void> _upload(Future<Uint8List?> Function() picker) async {
    final s = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() => _uploadError = null);
    final Uint8List? bytes;
    try {
      bytes = await picker();
    } catch (_) {
      if (mounted) setState(() => _uploadError = s.settingsAudioNotMp3);
      return;
    }
    if (bytes == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final meta = await gateway.uploadAsset(bytes, 'audio/mpeg');
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(audioAssetListPath));
      setState(() => _busy = false);
      widget.onChanged(meta.id);
      toast(context, s.settingsAudioUploaded);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _uploadError = writeErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final ro = widget.readOnly;
    // The list is an upload-side route: a read-only person is not asked for it.
    final read = ro ? null : ref.watch(boxJsonProvider(audioAssetListPath));
    final raw = read?.value?.value['assets'];
    final files = raw is List ? raw.cast<Map<String, dynamic>>() : const <Map<String, dynamic>>[];
    final picker = ref.watch(pickAudioProvider);
    final selectedMissing = widget.value != null && !files.any((a) => a['id'] == widget.value);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Row(
            rowKey: 'audio-none',
            title: s.settingsAudioNone,
            sub: s.settingsAudioNoneHint,
            selected: widget.value == null,
            onTap: ro ? null : () => widget.onChanged(null),
          ),
          for (final (i, a) in files.indexed) ...[
            const Divider(height: 1),
            _Row(
              rowKey: 'audio-${a['id']}',
              title: s.settingsAudioItem(files.length - i),
              sub: _size(a['bytes']),
              selected: a['id'] == widget.value,
              onTap: ro ? null : () => widget.onChanged(a['id']),
            ),
          ],
          if (selectedMissing) ...[
            const Divider(height: 1),
            _Row(
              rowKey: 'audio-selected',
              title: s.settingsAudioItem(1),
              sub: '${widget.value!.substring(0, 8)}...',
              selected: true,
              onTap: null,
            ),
          ],
          if (read != null && read.hasError && read.value == null) ...[
            const SizedBox(height: 8),
            Text(s.settingsAudioUnavailable, style: text.bodySmall),
          ],
          if (widget.error != null) ...[
            const SizedBox(height: 6),
            Text(widget.error!, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
          ],
          if (_uploadError != null) ...[
            const SizedBox(height: 8),
            ErrorLine(_uploadError!),
          ],
          if (!ro) ...[
            const SizedBox(height: 12),
            if (picker != null)
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  key: const ValueKey('audio-upload'),
                  onPressed: _busy ? null : () => _upload(picker),
                  icon: const Icon(Icons.upload_rounded, size: 20),
                  label: Text(_busy ? s.settingsAudioUploading : s.settingsAudioUpload),
                ),
              )
            else
              Text(s.settingsAudioWebOnly, style: text.bodySmall),
          ],
        ],
      ),
    );
  }

  static String _size(Object? bytes) {
    final n = bytes is num ? bytes.toDouble() : 0.0;
    final mb = n / (1024 * 1024);
    return mb >= 1 ? '${mb.toStringAsFixed(1)} MB' : '${(n / 1024).ceil()} KB';
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.rowKey,
    required this.title,
    required this.sub,
    required this.selected,
    required this.onTap,
  });

  final String rowKey;
  final String title;
  final String sub;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return InkWell(
      key: ValueKey(rowKey),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
        child: Row(
          children: [
            Container(
              width: 22,
              height: 22,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: SurauColors.card,
                border: Border.all(color: selected ? SurauColors.teal : SurauColors.outline, width: 2),
              ),
              alignment: Alignment.center,
              child: selected
                  ? Container(
                      width: 10,
                      height: 10,
                      decoration: const BoxDecoration(shape: BoxShape.circle, color: SurauColors.teal),
                    )
                  : null,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600)),
                  Text(sub, style: text.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
