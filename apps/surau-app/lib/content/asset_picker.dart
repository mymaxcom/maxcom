// Pictures in forms: the image field the content editors and the logo
// setting use (pick a photo, shrink it on the device, upload it raw with
// its Content-Type, then the adjust screen in the slot's real shape; the
// field keeps the plain asset id or the adjusted image object), the
// thumbnail showing the adjusted look, and the background picker the
// settings form draws for the `images` setting. The picker and the resize
// are providers so tests can hand the editor a photo without a gallery.

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../app/providers.dart';
import '../app/theme.dart';
import '../box/wire.dart' show ImageAnalysis, ImageBox;
import '../l10n/generated/s.dart';
import '../screens/widgets/box_read.dart';
import '../screens/widgets/pieces.dart';
import 'adjusted_picture.dart';
import 'image_adjust.dart';
import 'image_prep.dart';
import 'image_ref.dart';

export 'adjusted_picture.dart' show AssetPicture, assetBytesProvider;

typedef PickImageBytes = Future<Uint8List?> Function();
typedef PrepareImageFn = Future<PreparedImage> Function(Uint8List bytes);

/// The gallery on Android, the file chooser on the web; null when the
/// person cancels.
Future<Uint8List?> pickImageFromGallery() async {
  final picked = await ImagePicker().pickImage(source: ImageSource.gallery);
  if (picked == null) return null;
  return picked.readAsBytes();
}

/// Overridden in tests with a canned photo.
final pickImageProvider = Provider<PickImageBytes>(
  (ref) => pickImageFromGallery,
);

/// Overridden in tests to run the resize on the test thread.
final prepareImageProvider = Provider<PrepareImageFn>(
  (ref) =>
      (bytes) => prepareImage(bytes),
);

/// One image field: thumbnail in the slot's shape, `Pilih gambar` /
/// `Tukar gambar`, `Laraskan gambar`, `Buang gambar`, the preparing and
/// uploading states, and the error in BM. The picked photo goes to the
/// box at once (`POST /api/assets`), then the adjust screen opens; the
/// editor keeps only the value (id or adjusted object) until `Simpan`.
class ImageField extends ConsumerStatefulWidget {
  const ImageField({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    this.slot = ImageSlot.poster,
    this.required = false,
    this.readOnly = false,
    this.error,
    this.hint,
  });

  final String label;

  /// The plain asset id, the adjusted image object, or null for none.
  final Object? value;
  final void Function(Object? value) onChanged;

  /// The shape the picture is shown in (and adjusted for).
  final ImageSlot slot;
  final bool required;
  final bool readOnly;
  final String? error;
  final String? hint;

  @override
  ConsumerState<ImageField> createState() => _ImageFieldState();
}

enum _Stage { idle, preparing, uploading }

class _ImageFieldState extends ConsumerState<ImageField> {
  _Stage _stage = _Stage.idle;
  String? _error;

  Future<void> _pick() async {
    final s = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() => _error = null);
    final Uint8List? bytes;
    try {
      bytes = await ref.read(pickImageProvider)();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _stage = _Stage.idle;
        _error = s.imagePickFailed;
      });
      return;
    }
    if (bytes == null || !mounted) return;
    setState(() => _stage = _Stage.preparing);
    try {
      final prepared = await ref.read(prepareImageProvider)(bytes);
      if (!mounted) return;
      setState(() => _stage = _Stage.uploading);
      final meta = await gateway.uploadAsset(prepared.bytes, prepared.mime);
      if (!mounted) return;
      ref.invalidate(assetBytesProvider(meta.id));
      ref.invalidate(bgRemovedProvider(meta.id));
      setState(() => _stage = _Stage.idle);
      await _adjust(ImageRef(meta.id), prepared.bytes, fresh: true);
    } on ImagePrepError catch (e) {
      if (!mounted) return;
      setState(() {
        _stage = _Stage.idle;
        _error = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _stage = _Stage.idle;
        _error = writeErrorText(s, e);
      });
    }
  }

  /// `Laraskan gambar` on a picture already on the box.
  Future<void> _reEdit() async {
    final s = S.of(context);
    final current = ImageRef.parse(widget.value);
    if (current == null) return;
    setState(() {
      _error = null;
      _stage = _Stage.preparing;
    });
    Uint8List? bytes;
    try {
      bytes = await ref.read(assetBytesProvider(current.asset).future);
    } on Object {
      bytes = null; // the box could not be reached: the same message below
      ref.invalidate(assetBytesProvider(current.asset)); // ask again next time
    }
    if (!mounted) return;
    setState(() => _stage = _Stage.idle);
    if (bytes == null) {
      setState(() => _error = s.imagePickFailed);
      return;
    }
    await _adjust(current, bytes, fresh: false);
  }

  /// Opens the adjust screen. A fresh logo starts from the box's analysis
  /// (trimmed, the white background removed when it suggests so). A
  /// fresh picture is in the form before the screen opens, so `Batal`
  /// keeps it as uploaded.
  Future<void> _adjust(
    ImageRef start,
    Uint8List bytes, {
    required bool fresh,
  }) async {
    final s = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    ImageAnalysis? analysis;
    var initial = start;
    if (widget.slot == ImageSlot.logo) {
      setState(() => _stage = _Stage.preparing);
      try {
        analysis = ImageAnalysis.fromJson(
          await gateway.getFresh('/api/assets/${start.asset}/analyze'),
        );
      } on Object {
        analysis = null;
      }
      if (!mounted) return;
      setState(() => _stage = _Stage.idle);
      if (fresh && analysis != null) {
        initial = start.copyWith(
          crop: isFullBox(analysis.trim) ? null : analysis.trim,
          bg: analysis.suggested == 'remove' ? 'remove' : null,
        );
      }
    }
    if (fresh) widget.onChanged(start.toJson());
    final result = await showImageAdjust(
      context,
      bytes: bytes,
      initial: initial,
      slot: widget.slot,
      analysis: analysis,
    );
    if (!mounted) return;
    if (result != null) {
      widget.onChanged(result.toJson());
      if (!fresh) toast(context, s.imageAdjusted);
    }
    if (fresh) toast(context, s.imageUploaded);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final value = widget.value;
    final has = ImageRef.parse(value) != null;
    final busy = _stage != _Stage.idle;
    final error = _error ?? widget.error;
    final logo = widget.slot == ImageSlot.logo;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          widget.required
              ? widget.label
              : '${widget.label} (${s.contentOptional.toLowerCase()})',
          style: text.titleSmall,
        ),
        const SizedBox(height: 10),
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            if (has)
              AssetPicture(
                key: const ValueKey('image-thumb'),
                value: value,
                slot: widget.slot,
                size: 88,
                maxWidth: logo ? 176 : null,
                background: logo ? SurauColors.glass : null,
              )
            else
              Container(
                width: 88,
                height: 88,
                decoration: BoxDecoration(
                  color: SurauColors.paperDeep,
                  borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
                  border: Border.all(color: SurauColors.line),
                ),
                child: const Icon(
                  Icons.add_photo_alternate_outlined,
                  color: SurauColors.outline,
                  size: 34,
                ),
              ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (busy) ...[
                    Row(
                      children: [
                        const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2.5),
                        ),
                        const SizedBox(width: 10),
                        Text(
                          _stage == _Stage.preparing
                              ? s.imagePreparing
                              : s.imageUploading,
                          style: text.bodyMedium,
                        ),
                      ],
                    ),
                  ] else if (widget.readOnly) ...[
                    Text(
                      has ? s.imageUploaded : s.imageNone,
                      style: text.bodyMedium!.copyWith(
                        color: SurauColors.muted,
                      ),
                    ),
                  ] else ...[
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        OutlinedButton.icon(
                          key: const ValueKey('image-pick'),
                          onPressed: _pick,
                          icon: const Icon(Icons.photo_library_outlined),
                          label: Text(has ? s.imageChange : s.imagePick),
                        ),
                        if (has)
                          OutlinedButton.icon(
                            key: const ValueKey('image-adjust'),
                            onPressed: _reEdit,
                            icon: const Icon(Icons.crop_rounded),
                            label: Text(s.imageAdjust),
                          ),
                        if (has)
                          TextButton.icon(
                            key: const ValueKey('image-remove'),
                            onPressed: () => widget.onChanged(null),
                            icon: const Icon(Icons.close_rounded),
                            label: Text(s.imageRemove),
                          ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      widget.hint ?? s.contentAssetHint,
                      style: text.bodySmall,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
        if (error != null) ...[const SizedBox(height: 10), ErrorLine(error)],
      ],
    );
  }
}

// ---- backgrounds ----

/// The kiosk's built-in background names (apps/kiosk-display).
const List<String> builtInBackgrounds = ['default-1', 'default-2'];

/// What the box answers with: the pictures it holds, newest first.
const String _assetListPath = '/api/assets';

final RegExp _assetId = RegExp(r'^[0-9a-f]{64}$');

/// Burns a rotation and a crop into a new JPEG; overridden in tests to run
/// on the test thread.
typedef BakeImageFn = Future<PreparedImage> Function(
  Uint8List bytes, {
  int rotate,
  ImageBox? crop,
});

final bakeImageProvider = Provider<BakeImageFn>(
  (ref) =>
      (bytes, {int rotate = 0, ImageBox? crop}) =>
          bakeAdjustment(bytes, rotate: rotate, crop: crop),
);

/// The `images` setting of the `backgrounds` feature: the built-in images
/// to tick, the pictures uploaded to the box as thumbnails (tapped in the
/// order they should rotate on the TV), `Muat naik gambar latar`, and any
/// old `/uploads/<file>` names already in the list with a remove button.
class BackgroundPicker extends ConsumerStatefulWidget {
  const BackgroundPicker({
    super.key,
    required this.value,
    required this.onChanged,
    this.readOnly = false,
    this.error,
  });

  final List<String> value;
  final void Function(List<String> images) onChanged;
  final bool readOnly;
  final String? error;

  @override
  ConsumerState<BackgroundPicker> createState() => _BackgroundPickerState();
}

class _BackgroundPickerState extends ConsumerState<BackgroundPicker> {
  _Stage _stage = _Stage.idle;
  String? _error;

  void _toggle(String id, bool on) {
    final next = [...widget.value];
    if (on) {
      if (!next.contains(id)) next.add(id);
    } else {
      next.remove(id);
    }
    widget.onChanged(next);
  }

  /// Gallery, resize, upload, then the adjust screen in the TV's shape. A
  /// setting holds only a plain id, so a turn or crop is burnt into a new
  /// picture which is uploaded in its place. The picture is ticked at the
  /// end of the rotation; `Batal` keeps it as uploaded.
  Future<void> _upload() async {
    final s = S.of(context);
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() => _error = null);
    final Uint8List? bytes;
    try {
      bytes = await ref.read(pickImageProvider)();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _stage = _Stage.idle;
        _error = s.imagePickFailed;
      });
      return;
    }
    if (bytes == null || !mounted) return;
    setState(() => _stage = _Stage.preparing);
    try {
      final prepared = await ref.read(prepareImageProvider)(bytes);
      if (!mounted) return;
      setState(() => _stage = _Stage.uploading);
      final meta = await gateway.uploadAsset(prepared.bytes, prepared.mime);
      if (!mounted) return;
      ref.invalidate(assetBytesProvider(meta.id));
      setState(() => _stage = _Stage.idle);
      var id = meta.id;
      final result = await showImageAdjust(
        context,
        bytes: prepared.bytes,
        initial: ImageRef(meta.id),
        slot: ImageSlot.background,
      );
      if (!mounted) return;
      if (result != null && (!isFullBox(result.crop) || result.rotate != 0)) {
        setState(() => _stage = _Stage.uploading);
        final baked = await ref.read(bakeImageProvider)(
          prepared.bytes,
          rotate: result.rotate,
          crop: result.crop,
        );
        if (!mounted) return;
        final again = await gateway.uploadAsset(baked.bytes, baked.mime);
        if (!mounted) return;
        ref.invalidate(assetBytesProvider(again.id));
        id = again.id;
      }
      ref.invalidate(boxJsonProvider(_assetListPath));
      setState(() => _stage = _Stage.idle);
      _toggle(id, true);
      toast(context, s.settingsBackgroundUploaded);
    } on ImagePrepError catch (e) {
      if (!mounted) return;
      setState(() {
        _stage = _Stage.idle;
        _error = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _stage = _Stage.idle;
        _error = writeErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final value = widget.value;
    final readOnly = widget.readOnly;
    final busy = _stage != _Stage.idle;

    // A read-only person is refused the list (it is an upload-side route):
    // they see the pictures already ticked and nothing else.
    final listed = <String>[];
    var loading = false;
    var unavailable = false;
    if (!readOnly) {
      final read = ref.watch(boxJsonProvider(_assetListPath));
      final body = read.value?.value;
      if (body != null) {
        final assets = body['assets'];
        if (assets is List) {
          for (final a in assets) {
            final id = a is Map ? a['id'] : null;
            if (id is String && _assetId.hasMatch(id) && !listed.contains(id)) {
              listed.add(id);
            }
          }
        }
      } else if (read.isLoading) {
        loading = true;
      } else {
        unavailable = true;
      }
    }
    final tiles = [
      ...listed,
      for (final v in value)
        if (_assetId.hasMatch(v) && !listed.contains(v)) v,
    ];
    final legacy = [
      for (final v in value)
        if (!builtInBackgrounds.contains(v) && !_assetId.hasMatch(v)) v,
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionLabel(s.settingsBackgroundsBuiltIn),
        Card(
          child: Column(
            children: [
              for (var i = 0; i < builtInBackgrounds.length; i++) ...[
                if (i > 0) const Divider(),
                CheckboxListTile(
                  key: ValueKey('background-${builtInBackgrounds[i]}'),
                  value: value.contains(builtInBackgrounds[i]),
                  onChanged: readOnly
                      ? null
                      : (on) => _toggle(builtInBackgrounds[i], on ?? false),
                  controlAffinity: ListTileControlAffinity.trailing,
                  secondary: _Swatch(index: i),
                  title: Text(s.settingsBuiltInImage(i + 1)),
                  subtitle: Text(builtInBackgrounds[i]),
                  contentPadding: const EdgeInsets.fromLTRB(16, 6, 12, 6),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 10),
        Text(
          value.isEmpty
              ? s.settingsBackgroundsEmpty
              : s.settingsBackgroundsHint,
          style: text.bodySmall,
        ),
        const SizedBox(height: 20),
        SectionLabel(s.settingsBackgroundsUploaded),
        if (loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: LinearProgressIndicator(minHeight: 2),
          ),
        if (unavailable)
          Padding(
            key: const ValueKey('background-list-unavailable'),
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Text(
              s.settingsBackgroundsOffline,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        if (tiles.isEmpty && !loading && !unavailable)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              s.settingsBackgroundsNone,
              style: text.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          )
        else if (tiles.isNotEmpty) ...[
          LayoutBuilder(
            builder: (context, box) {
              const gap = 12.0;
              final cols = box.maxWidth < 420
                  ? 2
                  : (box.maxWidth < 760 ? 3 : 4);
              final w = (box.maxWidth - gap * (cols - 1)) / cols;
              return Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  for (var i = 0; i < tiles.length; i++)
                    SizedBox(
                      width: w,
                      child: _BackgroundTile(
                        key: ValueKey('background-upload-${tiles[i]}'),
                        id: tiles[i],
                        label: s.settingsBackgroundTile(i + 1),
                        order: value.contains(tiles[i])
                            ? value.indexOf(tiles[i]) + 1
                            : null,
                        onTap: readOnly
                            ? null
                            : () =>
                                  _toggle(tiles[i], !value.contains(tiles[i])),
                      ),
                    ),
                ],
              );
            },
          ),
          if (!readOnly) ...[
            const SizedBox(height: 10),
            Text(s.settingsBackgroundsOrder, style: text.bodySmall),
          ],
        ],
        if (legacy.isNotEmpty) ...[
          const SizedBox(height: 12),
          Card(
            child: Column(
              children: [
                for (var i = 0; i < legacy.length; i++) ...[
                  if (i > 0) const Divider(),
                  ListTile(
                    leading: const Icon(Icons.image_outlined),
                    title: Text(legacy[i].replaceFirst('/uploads/', '')),
                    trailing: readOnly
                        ? null
                        : IconButton(
                            tooltip: s.settingsBackgroundRemove(legacy[i]),
                            icon: const Icon(Icons.close_rounded),
                            onPressed: () => _toggle(legacy[i], false),
                          ),
                  ),
                ],
              ],
            ),
          ),
        ],
        if (!readOnly) ...[
          const SizedBox(height: 16),
          if (busy)
            Row(
              children: [
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                ),
                const SizedBox(width: 10),
                Text(
                  _stage == _Stage.preparing
                      ? s.imagePreparing
                      : s.imageUploading,
                  style: text.bodyMedium,
                ),
              ],
            )
          else
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: OutlinedButton.icon(
                key: const ValueKey('background-upload'),
                onPressed: _upload,
                icon: const Icon(Icons.add_photo_alternate_outlined),
                label: Text(s.settingsBackgroundsUpload),
              ),
            ),
        ],
        if (_error != null) ...[const SizedBox(height: 12), ErrorLine(_error!)],
        if (widget.error != null) ...[
          const SizedBox(height: 12),
          ErrorLine(widget.error!),
        ],
      ],
    );
  }
}

/// One uploaded picture: its thumbnail in the TV's shape, loaded through
/// the pinned client, a ring and the turn number when ticked.
class _BackgroundTile extends ConsumerWidget {
  const _BackgroundTile({
    super.key,
    required this.id,
    required this.label,
    required this.order,
    required this.onTap,
  });

  final String id;
  final String label;

  /// 1-based place in the rotation, null when not ticked.
  final int? order;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bytes = ref.watch(assetBytesProvider(id)).value;
    final picked = order != null;
    final radius = BorderRadius.circular(SurauTheme.radiusControl);
    return Semantics(
      button: onTap != null,
      selected: picked,
      label: label,
      excludeSemantics: true,
      onTap: onTap,
      child: InkWell(
        onTap: onTap,
        borderRadius: radius,
        child: AspectRatio(
          aspectRatio: 16 / 9,
          child: Stack(
            fit: StackFit.expand,
            children: [
              DecoratedBox(
                position: DecorationPosition.foreground,
                decoration: BoxDecoration(
                  borderRadius: radius,
                  border: Border.all(
                    color: picked ? SurauColors.teal : SurauColors.line,
                    width: picked ? 3 : 1,
                  ),
                ),
                child: ClipRRect(
                  borderRadius: radius,
                  child: bytes == null
                      ? const ColoredBox(
                          color: SurauColors.paperDeep,
                          child: Icon(
                            Icons.image_outlined,
                            color: SurauColors.outline,
                            size: 30,
                          ),
                        )
                      : Image.memory(
                          bytes,
                          fit: BoxFit.cover,
                          gaplessPlayback: true,
                          frameBuilder: (_, child, frame, _) => frame == null
                              ? const ColoredBox(color: SurauColors.paperDeep)
                              : child,
                          errorBuilder: (_, _, _) => const ColoredBox(
                            color: SurauColors.paperDeep,
                            child: Icon(
                              Icons.broken_image_outlined,
                              color: SurauColors.outline,
                              size: 30,
                            ),
                          ),
                        ),
                ),
              ),
              if (picked)
                Positioned(
                  top: 8,
                  left: 8,
                  child: Container(
                    key: ValueKey('background-order-$id'),
                    width: 28,
                    height: 28,
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(
                      color: SurauColors.teal,
                      shape: BoxShape.circle,
                    ),
                    child: Text(
                      '$order',
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w700,
                        fontSize: 14,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A small tile that stands for a built-in image (the kiosk's deep teal
/// night and its warm dawn), drawn rather than fetched.
class _Swatch extends StatelessWidget {
  const _Swatch({required this.index});

  final int index;

  @override
  Widget build(BuildContext context) {
    final colours = index == 0
        ? const [Color(0xFF06302B), Color(0xFF0B5C55), Color(0xFF9ECFC5)]
        : const [Color(0xFF2A1F3D), Color(0xFFB8673A), Color(0xFFF0C97A)];
    return Container(
      width: 64,
      height: 44,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(SurauTheme.radiusChip),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: colours,
        ),
      ),
    );
  }
}
