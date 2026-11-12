// A publisher with no camera, for widget tests and goldens: it records
// every call and moves through the phases at once; [emit] plays any state
// (a retrying leg, a warning, a long session). Its preview is a still
// drawing of a surau hall so the goldens show a framed picture, not a
// black hole.

import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import 'publisher.dart';

class FakePublisher implements LivePublisher {
  FakePublisher({PublisherState initial = PublisherState.initial})
    : _state = initial;

  final _controller = StreamController<PublisherState>.broadcast();
  PublisherState _state;

  final List<PublisherConfig> prepared = [];
  final List<PublisherTargets> started = [];
  final List<String> startedYoutube = [];
  int stops = 0;
  int switches = 0;

  /// What [sessionRecordings] answers (a test sets it; Android names).
  List<String> recordedNames = const [];

  /// When true, [prepare] and [start] keep the given state (a test or
  /// golden set it with [emit]).
  bool frozen = false;

  @override
  Stream<PublisherState> get states => _controller.stream;

  @override
  PublisherState get current => _state;

  void emit(PublisherState s) {
    _state = s;
    _controller.add(s);
  }

  @override
  Future<void> prepare(PublisherConfig c) async {
    prepared.add(c);
    if (frozen) return;
    emit(
      _state.copyWith(
        phase: PublisherPhase.ready,
        recording: RecordingState(on: c.recording),
        portrait: c.portrait ?? false,
      ),
    );
  }

  @override
  Future<void> start(PublisherTargets t) async {
    started.add(t);
    if (frozen) return;
    emit(
      _state.copyWith(
        phase: PublisherPhase.live,
        outputs: PublisherOutputs(
          kiosk: t.outputs.kiosk ? OutputState.up : null,
          youtube: t.outputs.youtube ? OutputState.up : null,
        ),
      ),
    );
  }

  @override
  Future<void> startYoutube(String url) async {
    startedYoutube.add(url);
    if (frozen) return;
    emit(
      _state.copyWith(
        outputs: PublisherOutputs(
          kiosk: _state.outputs.kiosk,
          youtube: OutputState.up,
        ),
      ),
    );
  }

  @override
  Future<void> stop() async {
    stops++;
    if (frozen) return;
    emit(_state.copyWith(phase: PublisherPhase.stopped));
  }

  @override
  Future<List<String>> sessionRecordings() async => recordedNames;

  @override
  Future<void> switchCamera() async {
    switches++;
    emit(_state.copyWith(frontCamera: !_state.frontCamera));
  }

  @override
  void setMuted(bool muted) => emit(_state.copyWith(muted: muted));

  @override
  Widget preview(BuildContext context) => const FakeCameraPicture();

  Future<void> dispose() => _controller.close();
}

/// A calm still of the front of a surau hall: the mihrab arch, a lamp and
/// the carpet lines, drawn in the app's teal.
class FakeCameraPicture extends StatelessWidget {
  const FakeCameraPicture({super.key});

  @override
  Widget build(BuildContext context) =>
      CustomPaint(painter: _HallPainter(), child: const SizedBox.expand());
}

class _HallPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final rect = Offset.zero & size;
    canvas.drawRect(
      rect,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color(0xFF2F5E57), Color(0xFF1B403B), Color(0xFF0E2B27)],
        ).createShader(rect),
    );
    // Wall panel and the mihrab arch.
    final arch = Path()
      ..moveTo(w * 0.40, h * 0.78)
      ..lineTo(w * 0.40, h * 0.40)
      ..quadraticBezierTo(w * 0.40, h * 0.18, w * 0.50, h * 0.12)
      ..quadraticBezierTo(w * 0.60, h * 0.18, w * 0.60, h * 0.40)
      ..lineTo(w * 0.60, h * 0.78)
      ..close();
    canvas.drawPath(arch, Paint()..color = const Color(0xFF3F7A70));
    canvas.drawPath(
      arch,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = w * 0.006
        ..color = SurauColors.gold.withValues(alpha: 0.55),
    );
    // Lamp glow.
    canvas.drawCircle(
      Offset(w * 0.50, h * 0.30),
      h * 0.16,
      Paint()
        ..shader =
            RadialGradient(
              colors: [
                SurauColors.gold.withValues(alpha: 0.35),
                SurauColors.gold.withValues(alpha: 0),
              ],
            ).createShader(
              Rect.fromCircle(
                center: Offset(w * 0.50, h * 0.30),
                radius: h * 0.16,
              ),
            ),
    );
    // Speaker at the low table: head and shoulders.
    final body = Paint()..color = const Color(0xFF0A221F);
    canvas.drawCircle(Offset(w * 0.50, h * 0.52), h * 0.07, body);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: Offset(w * 0.50, h * 0.74),
          width: w * 0.20,
          height: h * 0.26,
        ),
        Radius.circular(h * 0.08),
      ),
      body,
    );
    // Carpet rows.
    final carpet = Paint()
      ..color = SurauColors.gold.withValues(alpha: 0.18)
      ..strokeWidth = 1.5;
    for (var i = 0; i < 4; i++) {
      final y = h * (0.82 + i * 0.05);
      canvas.drawLine(Offset(0, y), Offset(w, y), carpet);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
