// The adjust screen every picture passes through after it is picked (and
// again from `Laraskan gambar`): the picture under a frame of the slot's
// real shape (a circle for a speaker, 16:9 for a poster, 2:3 for a book
// cover, the logo's own shape with draggable edges), moved and zoomed by
// finger, mouse or keyboard, rotated a quarter turn at a time, reset. The
// logo adds its background choice (remove the white, put on a light card,
// keep) with a before/after on the kiosk's dark colour, then a second step
// for the square icon with the app icon and browser icon drawn as they
// will be. Nothing is sent: `Simpan` hands back the ImageRef (the plain id
// when nothing was adjusted) and the field stores it until the form's own
// save.

import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/theme.dart';
import '../box/wire.dart' show ImageAnalysis;
import '../l10n/generated/s.dart';
import 'adjusted_picture.dart';
import 'image_bg.dart';
import 'image_ref.dart';

/// Opens the adjust screen over everything. Resolves to the adjusted
/// reference (a plain id when nothing is adjusted), or null on `Batal`.
Future<ImageRef?> showImageAdjust(
  BuildContext context, {
  required Uint8List bytes,
  required ImageRef initial,
  required ImageSlot slot,
  ImageAnalysis? analysis,
}) {
  return Navigator.of(context, rootNavigator: true).push<ImageRef>(
    MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => ImageAdjustScreen(bytes: bytes, initial: initial, slot: slot, analysis: analysis),
    ),
  );
}

/// Where the picture sits under the frame, shared by the editor and the
/// toolbar. The geometry is built the first time the editor has a size.
class CropController extends ChangeNotifier {
  CropController({required this.image, required this.aspect, this.contain = false, ImageBox? crop}) {
    _crop = crop;
  }

  Size image;
  final double? aspect;
  final bool contain;
  ImageBox? _crop;
  Rect? _area;
  CropGeometry? _geometry;

  CropGeometry? get geometry => _geometry;

  /// The crop box the frame shows now.
  ImageBox get value => _geometry?.crop ?? _crop ?? fullBox;

  /// Builds the geometry for [area] when the editor is first laid out or
  /// changes size (keeping the current crop); no notification, it is
  /// called from a build.
  void layoutSilently(Rect area) {
    if (_geometry != null && _area == area) return;
    final crop = _geometry?.crop ?? _crop;
    _area = area;
    _geometry = aspect == null
        ? freeGeometry(image: image, area: area, crop: crop)
        : CropGeometry.fit(image: image, frame: frameFor(area, aspect!), crop: crop, contain: contain);
  }

  void _set(CropGeometry g) {
    _geometry = g;
    notifyListeners();
  }

  void pan(Offset delta) {
    final g = _geometry;
    if (g != null) _set(g.pan(delta));
  }

  /// The picture at [scale] with its top-left at [offset], kept in bounds.
  void place(double scale, Offset offset) {
    final g = _geometry;
    if (g != null) _set(g.copyWith(scale: scale, offset: offset).clamped());
  }

  void zoomAt(double factor, Offset focal) {
    final g = _geometry;
    if (g != null) _set(g.zoomAt(factor, focal));
  }

  /// Zooms about the frame's centre.
  void zoom(double factor) {
    final g = _geometry;
    if (g != null) _set(g.zoomAt(factor, g.frame.center));
  }

  void setFrame(Rect frame) {
    final g = _geometry;
    final a = _area;
    if (g != null && a != null) _set(g.withFrame(frame, bounds: a));
  }

  /// A new picture size (after a rotation) with the crop to show.
  void setImage(Size size, ImageBox? crop) {
    image = size;
    _crop = crop;
    _geometry = null;
    _area = null;
    notifyListeners();
  }

  /// Back to the whole picture.
  void reset() => setImage(image, null);
}

class ImageAdjustScreen extends ConsumerStatefulWidget {
  const ImageAdjustScreen({
    super.key,
    required this.bytes,
    required this.initial,
    required this.slot,
    this.analysis,
  });

  final Uint8List bytes;
  final ImageRef initial;
  final ImageSlot slot;

  /// The box's analysis (logo only): decides what the background choices
  /// say and which is preselected.
  final ImageAnalysis? analysis;

  @override
  ConsumerState<ImageAdjustScreen> createState() => _ImageAdjustScreenState();
}

class _ImageAdjustScreenState extends ConsumerState<ImageAdjustScreen> {
  late ImageRef _ref = widget.initial;
  Size? _natural;
  late CropController _crop;
  CropController? _square;
  bool _squareTouched = false;

  /// True while the code (not the person) moves the square, a rotation.
  bool _squareMovedByCode = false;
  int _step = 0;

  bool get _isLogo => widget.slot == ImageSlot.logo;

  Size _rotated(int rotate) {
    final n = _natural ?? const Size(1, 1);
    return rotate % 180 == 0 ? n : Size(n.height, n.width);
  }

  @override
  void initState() {
    super.initState();
    final a = widget.analysis;
    _natural = pictureSize(widget.bytes) ?? (a == null ? null : Size(a.width.toDouble(), a.height.toDouble()));
    if (_natural == null) {
      decodeImageFromList(widget.bytes).then((im) {
        if (!mounted) return;
        setState(() {
          _natural = Size(im.width.toDouble(), im.height.toDouble());
          _crop.setImage(_rotated(_ref.rotate), _crop.value);
        });
        im.dispose();
      }, onError: (Object _) {});
    }
    _crop = CropController(
      image: _rotated(_ref.rotate),
      aspect: widget.slot.aspect,
      contain: widget.slot.contain,
      crop: _ref.crop,
    );
    if (_ref.square != null) _squareTouched = true;
  }

  @override
  void dispose() {
    _crop.dispose();
    _square?.dispose();
    super.dispose();
  }

  CropController get _active => _step == 1 ? (_square ?? _crop) : _crop;

  void _rotate() {
    final crop = _crop.value;
    final next = (_ref.rotate + 90) % 360;
    setState(() {
      _ref = _ref.copyWith(rotate: next);
      _crop.setImage(_rotated(next), rotateBoxCw(crop));
      final sq = _square;
      if (sq != null) {
        _squareMovedByCode = true;
        sq.setImage(_rotated(next), rotateBoxCw(sq.value));
        _squareMovedByCode = false;
      }
    });
  }

  void _reset() {
    setState(() {
      _ref = ImageRef(_ref.asset);
      _crop.setImage(_rotated(0), null);
      _square?.dispose();
      _square = null;
      _squareTouched = false;
      _step = 0;
    });
  }

  void _setBg(String? bg) => setState(() => _ref = _ref.copyWith(bg: bg));

  void _next() {
    final size = _rotated(_ref.rotate);
    var sq = _square;
    if (sq == null || !_squareTouched) {
      sq?.dispose();
      final start = _ref.square ?? centredSquare(_crop.value, size.width.round(), size.height.round());
      sq = CropController(image: size, aspect: 1, crop: start);
      sq.addListener(() {
        if (!_squareMovedByCode) _squareTouched = true;
      });
      _square = sq;
    }
    setState(() => _step = 1);
  }

  void _save() {
    final crop = _crop.value;
    final out = _ref.copyWith(
      crop: isFullBox(crop) ? null : crop,
      square: _isLogo ? _square?.value : null,
      bg: _ref.bg == 'keep' ? null : _ref.bg,
    );
    Navigator.of(context).pop(out);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final a = widget.analysis;
    final processed = _ref.bg == 'remove' || _ref.bg == 'card' ? ref.watch(bgRemovedProvider(_ref.asset)).value : null;
    final shown = processed ?? widget.bytes;

    return Scaffold(
      appBar: AppBar(
        title: Text(_isLogo ? s.imageAdjustLogo : s.imageAdjust),
        leading: IconButton(
          key: const ValueKey('adjust-cancel'),
          tooltip: s.actionCancel,
          icon: const Icon(Icons.close_rounded),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: LayoutBuilder(
        builder: (context, constraints) {
          final editorH = (constraints.maxHeight * 0.42).clamp(220.0, 520.0);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_isLogo)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 10, 20, 8),
                  child: Row(
                    children: [
                      Text(s.imageStep(_step + 1, 2), style: text.labelMedium!.copyWith(color: SurauColors.muted)),
                      const SizedBox(width: 10),
                      Text(_step == 0 ? s.imageStepCrop : s.imageStepSquare, style: text.titleSmall),
                    ],
                  ),
                ),
              SizedBox(
                height: editorH,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
                    child: CropEditor(
                      key: ValueKey('crop-editor-$_step'),
                      controller: _active,
                      bytes: shown,
                      rotate: _ref.rotate,
                      circle: widget.slot.circle,
                      onRotate: _rotate,
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                child: Wrap(
                  alignment: WrapAlignment.center,
                  spacing: 4,
                  children: [
                    IconButton.outlined(
                      key: const ValueKey('adjust-zoom-out'),
                      tooltip: s.imageZoomOut,
                      onPressed: () => _active.zoom(0.8),
                      icon: const Icon(Icons.zoom_out_rounded),
                    ),
                    IconButton.outlined(
                      key: const ValueKey('adjust-zoom-in'),
                      tooltip: s.imageZoomIn,
                      onPressed: () => _active.zoom(1.25),
                      icon: const Icon(Icons.zoom_in_rounded),
                    ),
                    IconButton.outlined(
                      key: const ValueKey('adjust-rotate'),
                      tooltip: s.imageRotate,
                      onPressed: _rotate,
                      icon: const Icon(Icons.rotate_90_degrees_cw_outlined),
                    ),
                    TextButton.icon(
                      key: const ValueKey('adjust-reset'),
                      onPressed: _reset,
                      icon: const Icon(Icons.restart_alt_rounded),
                      label: Text(s.imageReset),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(20, 6, 20, 12),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: SurauTheme.contentMaxWidth),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (_isLogo && _step == 0) _bgPanel(s, text, a),
                          if (_isLogo && _step == 1) _squarePanel(s, text),
                          const SizedBox(height: 10),
                          Text(
                            widget.slot.free && _step == 0 ? '${s.imageFrameHint} ${s.imageAdjustHint}' : s.imageAdjustHint,
                            style: text.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              const Divider(height: 1),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
                child: Row(
                  children: [
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: Text(s.actionCancel),
                    ),
                    const Spacer(),
                    if (_isLogo && _step == 1) ...[
                      OutlinedButton(
                        key: const ValueKey('adjust-back'),
                        onPressed: () => setState(() => _step = 0),
                        child: Text(s.imageStepBack),
                      ),
                      const SizedBox(width: 10),
                    ],
                    if (_isLogo && _step == 0)
                      FilledButton.icon(
                        key: const ValueKey('adjust-next'),
                        onPressed: _next,
                        icon: const Icon(Icons.arrow_forward_rounded),
                        label: Text(s.imageStepNext),
                      )
                    else
                      FilledButton.icon(
                        key: const ValueKey('adjust-save'),
                        onPressed: _save,
                        icon: const Icon(Icons.check_rounded),
                        label: Text(s.settingsSave),
                      ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  /// Logo step 1: the background choice and the before/after.
  Widget _bgPanel(S s, TextTheme text, ImageAnalysis? a) {
    final transparent = a?.transparent ?? false;
    final colour = a?.backgroundColour;
    final nearWhite = colour == null || _isNearWhite(colour);
    final current = _ref.bg ?? 'keep';
    Widget chip(String key, String value, String label) => ChoiceChip(
      key: ValueKey('bg-$key'),
      label: Text(label),
      selected: current == value,
      showCheckmark: true,
      checkmarkColor: SurauColors.glass,
      labelStyle: TextStyle(
        color: current == value ? SurauColors.glass : SurauColors.teal,
        fontWeight: FontWeight.w600,
      ),
      side: BorderSide(color: current == value ? SurauColors.teal : SurauColors.line),
      onSelected: (_) => _setBg(value == 'keep' ? null : value),
    );
    Widget before(double w) => AdjustedPicture(bytes: widget.bytes, ref: ImageRef(_ref.asset), slot: ImageSlot.logo, height: 44, maxWidth: w);
    Widget after(double w) =>
        AdjustedPicture(bytes: widget.bytes, ref: _ref.copyWith(crop: _crop.value), slot: ImageSlot.logo, height: 44, maxWidth: w);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s.imageBgTitle, style: text.titleSmall),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (!transparent) chip('remove', 'remove', nearWhite ? s.imageBgRemove : s.imageBgRemoveColour),
            chip('card', 'card', s.imageBgCard),
            chip('keep', 'keep', s.imageBgKeep),
          ],
        ),
        if (transparent) ...[
          const SizedBox(height: 6),
          Text(s.imageBgTransparent, style: text.bodySmall),
        ] else if (a != null && !a.plainBackground) ...[
          const SizedBox(height: 6),
          Text(s.imageBgNotPlain, style: text.bodySmall!.copyWith(color: SurauColors.ink)),
        ],
        const SizedBox(height: 14),
        AnimatedBuilder(
          animation: _crop,
          builder: (_, _) => Row(
            children: [
              Expanded(child: _GlassTile(label: s.imageBefore, builder: before)),
              const SizedBox(width: 12),
              Expanded(child: _GlassTile(label: s.imageAfter, builder: after)),
            ],
          ),
        ),
      ],
    );
  }

  /// Logo step 2: the icon previews.
  Widget _squarePanel(S s, TextTheme text) {
    final sq = _square;
    if (sq == null) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: sq,
      builder: (context, _) {
        final iconRef = _ref.copyWith(crop: sq.value, square: null);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(s.imageSquareHint, style: text.bodyMedium),
            const SizedBox(height: 14),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Column(
                  children: [
                    Container(
                      decoration: BoxDecoration(
                        color: SurauColors.card,
                        borderRadius: BorderRadius.circular(18),
                        border: Border.all(color: SurauColors.line),
                        boxShadow: const [BoxShadow(color: Color(0x1A000000), blurRadius: 8, offset: Offset(0, 3))],
                      ),
                      clipBehavior: Clip.antiAlias,
                      padding: const EdgeInsets.all(6),
                      child: AdjustedPicture(bytes: widget.bytes, ref: iconRef, slot: ImageSlot.logoSquare, width: 60, radius: 12),
                    ),
                    const SizedBox(height: 6),
                    Text(s.imageAppIcon, style: text.labelMedium),
                  ],
                ),
                const SizedBox(width: 24),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        height: 40,
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        decoration: BoxDecoration(
                          color: SurauColors.paperDeep,
                          borderRadius: const BorderRadius.vertical(top: Radius.circular(10)),
                          border: Border.all(color: SurauColors.line),
                        ),
                        child: Row(
                          children: [
                            AdjustedPicture(bytes: widget.bytes, ref: iconRef, slot: ImageSlot.logoSquare, width: 18, radius: 3),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                s.productName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: text.bodySmall!.copyWith(color: SurauColors.text),
                              ),
                            ),
                            const Icon(Icons.close_rounded, size: 14, color: SurauColors.outline),
                          ],
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(s.imageFavicon, style: text.labelMedium),
                    ],
                  ),
                ),
              ],
            ),
          ],
        );
      },
    );
  }

  static bool _isNearWhite(String hex) {
    if (hex.length != 7) return true;
    final r = int.tryParse(hex.substring(1, 3), radix: 16) ?? 255;
    final g = int.tryParse(hex.substring(3, 5), radix: 16) ?? 255;
    final b = int.tryParse(hex.substring(5, 7), radix: 16) ?? 255;
    return math.min(r, math.min(g, b)) >= 235;
  }
}

/// A caption and a picture on the kiosk's dark glass; [builder] gets the
/// width the picture may take.
class _GlassTile extends StatelessWidget {
  const _GlassTile({required this.label, required this.builder});

  final String label;
  final Widget Function(double maxWidth) builder;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      height: 92,
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      decoration: BoxDecoration(
        color: SurauColors.glass,
        borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
        border: Border.all(color: SurauColors.goldHairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: text.labelSmall!.copyWith(color: SurauColors.gold, letterSpacing: 1.2)),
          const SizedBox(height: 6),
          Expanded(
            child: LayoutBuilder(
              builder: (context, c) => Align(alignment: Alignment.centerLeft, child: builder(c.maxWidth)),
            ),
          ),
        ],
      ),
    );
  }
}

enum _Handle { left, top, right, bottom, topLeft, topRight, bottomLeft, bottomRight }

/// The picture under the frame: one finger or the mouse drags it, two
/// fingers or the wheel zoom it, the keyboard moves, zooms and rotates it;
/// a free frame has draggable edges and corners.
class CropEditor extends StatefulWidget {
  const CropEditor({
    super.key,
    required this.controller,
    required this.bytes,
    required this.rotate,
    required this.onRotate,
    this.circle = false,
  });

  final CropController controller;
  final Uint8List bytes;
  final int rotate;
  final VoidCallback onRotate;
  final bool circle;

  static const double pad = 20;

  @override
  State<CropEditor> createState() => _CropEditorState();
}

class _CropEditorState extends State<CropEditor> {
  final FocusNode _focus = FocusNode(debugLabel: 'crop-editor');
  double _startScale = 1;
  Offset _startOffset = Offset.zero;
  Offset _startFocal = Offset.zero;
  Rect _startFrame = Rect.zero;
  _Handle? _handle;

  @override
  void initState() {
    super.initState();
    _focus.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _focus.dispose();
    super.dispose();
  }

  _Handle? _handleAt(Offset p, Rect f) {
    const r = 22.0;
    bool near(Offset q) => (p - q).distance <= r;
    if (near(f.topLeft)) return _Handle.topLeft;
    if (near(f.topRight)) return _Handle.topRight;
    if (near(f.bottomLeft)) return _Handle.bottomLeft;
    if (near(f.bottomRight)) return _Handle.bottomRight;
    if (near(f.centerLeft)) return _Handle.left;
    if (near(f.centerRight)) return _Handle.right;
    if (near(f.topCenter)) return _Handle.top;
    if (near(f.bottomCenter)) return _Handle.bottom;
    return null;
  }

  void _onStart(ScaleStartDetails d) {
    final g = widget.controller.geometry;
    if (g == null) return;
    _focus.requestFocus();
    _startScale = g.scale;
    _startOffset = g.offset;
    _startFocal = d.localFocalPoint;
    _startFrame = g.frame;
    _handle = widget.controller.aspect == null && d.pointerCount == 1 ? _handleAt(d.localFocalPoint, g.frame) : null;
  }

  void _onUpdate(ScaleUpdateDetails d) {
    final c = widget.controller;
    final g = c.geometry;
    if (g == null) return;
    final h = _handle;
    if (h != null) {
      final delta = d.localFocalPoint - _startFocal;
      final f = _startFrame;
      var l = f.left;
      var t = f.top;
      var r = f.right;
      var b = f.bottom;
      if (h == _Handle.left || h == _Handle.topLeft || h == _Handle.bottomLeft) l += delta.dx;
      if (h == _Handle.right || h == _Handle.topRight || h == _Handle.bottomRight) r += delta.dx;
      if (h == _Handle.top || h == _Handle.topLeft || h == _Handle.topRight) t += delta.dy;
      if (h == _Handle.bottom || h == _Handle.bottomLeft || h == _Handle.bottomRight) b += delta.dy;
      c.setFrame(Rect.fromLTRB(math.min(l, r), math.min(t, b), math.max(l, r), math.max(t, b)));
      return;
    }
    // The picture point that was under the first touch stays under the
    // focal point as it moves and the fingers spread.
    final scale = (_startScale * d.scale).clamp(g.minScale, g.maxScale);
    final q = (_startFocal - _startOffset) / _startScale;
    c.place(scale, d.localFocalPoint - q * scale);
  }

  void _onSignal(PointerSignalEvent e) {
    if (e is PointerScrollEvent) {
      GestureBinding.instance.pointerSignalResolver.register(e, (PointerSignalEvent ev) {
        if (ev is! PointerScrollEvent) return;
        widget.controller.zoomAt(math.exp(-ev.scrollDelta.dy / 400), ev.localPosition);
      });
    }
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is KeyUpEvent) return KeyEventResult.ignored;
    final c = widget.controller;
    final step = HardwareKeyboard.instance.isShiftPressed ? 50.0 : 12.0;
    final key = e.logicalKey;
    if (key == LogicalKeyboardKey.arrowLeft) {
      c.pan(Offset(step, 0));
    } else if (key == LogicalKeyboardKey.arrowRight) {
      c.pan(Offset(-step, 0));
    } else if (key == LogicalKeyboardKey.arrowUp) {
      c.pan(Offset(0, step));
    } else if (key == LogicalKeyboardKey.arrowDown) {
      c.pan(Offset(0, -step));
    } else if (key == LogicalKeyboardKey.equal || key == LogicalKeyboardKey.add || key == LogicalKeyboardKey.numpadAdd) {
      c.zoom(1.2);
    } else if (key == LogicalKeyboardKey.minus || key == LogicalKeyboardKey.numpadSubtract) {
      c.zoom(1 / 1.2);
    } else if (key == LogicalKeyboardKey.keyR) {
      widget.onRotate();
    } else {
      return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final c = widget.controller;
    return Focus(
      focusNode: _focus,
      onKeyEvent: _onKey,
      child: Semantics(
        label: s.imageAdjust,
        hint: s.imageAdjustHint,
        child: AnimatedBuilder(
          animation: c,
          builder: (context, _) => LayoutBuilder(
            builder: (context, constraints) {
              final area = Rect.fromLTWH(
                CropEditor.pad,
                CropEditor.pad,
                math.max(1, constraints.maxWidth - CropEditor.pad * 2),
                math.max(1, constraints.maxHeight - CropEditor.pad * 2),
              );
              c.layoutSilently(area);
              final g = c.geometry!;
              final shown = g.shown;
              return Listener(
                onPointerSignal: _onSignal,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onScaleStart: _onStart,
                  onScaleUpdate: _onUpdate,
                  child: MouseRegion(
                    cursor: SystemMouseCursors.move,
                    child: Stack(
                      clipBehavior: Clip.hardEdge,
                      children: [
                        const Positioned.fill(child: ColoredBox(color: SurauColors.glass)),
                        Positioned(
                          left: shown.left,
                          top: shown.top,
                          width: shown.width,
                          height: shown.height,
                          child: RotatedBox(
                            quarterTurns: (widget.rotate ~/ 90) % 4,
                            child: Image.memory(
                              widget.bytes,
                              key: const ValueKey('crop-image'),
                              fit: BoxFit.fill,
                              gaplessPlayback: true,
                              filterQuality: FilterQuality.medium,
                              errorBuilder: (_, _, _) => const SizedBox.shrink(),
                            ),
                          ),
                        ),
                        Positioned.fill(
                          child: IgnorePointer(
                            child: CustomPaint(
                              painter: _FramePainter(
                                frame: g.frame,
                                circle: widget.circle,
                                handles: c.aspect == null,
                                focused: _focus.hasFocus,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

/// Dims everything outside the frame, draws the frame (a circle when the
/// slot is one) with the thirds, and the handles of a free frame.
class _FramePainter extends CustomPainter {
  const _FramePainter({required this.frame, required this.circle, required this.handles, required this.focused});

  final Rect frame;
  final bool circle;
  final bool handles;
  final bool focused;

  @override
  void paint(Canvas canvas, Size size) {
    final hole = Path();
    if (circle) {
      hole.addOval(frame);
    } else {
      hole.addRect(frame);
    }
    final outside = Path.combine(PathOperation.difference, Path()..addRect(Offset.zero & size), hole);
    canvas.drawPath(outside, Paint()..color = const Color(0xB3000000));
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = focused ? 3 : 2
      ..color = SurauColors.gold;
    canvas.drawPath(hole, stroke);
    if (!circle) {
      final thin = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = const Color(0x55FFFFFF);
      for (var i = 1; i < 3; i++) {
        final x = frame.left + frame.width * i / 3;
        final y = frame.top + frame.height * i / 3;
        canvas.drawLine(Offset(x, frame.top), Offset(x, frame.bottom), thin);
        canvas.drawLine(Offset(frame.left, y), Offset(frame.right, y), thin);
      }
    }
    if (handles) {
      final fill = Paint()..color = SurauColors.gold;
      for (final p in [
        frame.topLeft,
        frame.topRight,
        frame.bottomLeft,
        frame.bottomRight,
        frame.centerLeft,
        frame.centerRight,
        frame.topCenter,
        frame.bottomCenter,
      ]) {
        canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromCenter(center: p, width: 14, height: 14), const Radius.circular(3)),
          fill,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_FramePainter old) =>
      old.frame != frame || old.circle != circle || old.handles != handles || old.focused != focused;
}
