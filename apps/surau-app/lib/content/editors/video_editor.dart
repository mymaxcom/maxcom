// Video: a title, where it comes from (a file from the phone, a YouTube link, or a clip of a lecture recording on
// the surau's YouTube), the days and dates it shows, its place in the rotation and `Bunyi` (silent unless switched on).
// An uploaded file is checked on the phone (H.264 MP4, 720p, 10 minutes, 300 MB), made smaller on Android when it is
// not within the limits, and sent to the box over the surau Wi-Fi; `Simpan` waits until the upload is done, so no
// half-sent video ever joins the rotation. Over the cloud only a YouTube video can be added or changed: an uploaded
// video's details are shown read-only (its file is on the box, the cloud has no copy).
//
// A YouTube video does not tell its length: the slot is the rough length the user gives (`Anggaran tempoh`, 1 to 10
// minutes, 5 by default); a recording clip's length is its end minus its start.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../features/common/error_text.dart';
import '../../features/labels.dart' show appLangOf;
import '../../features/shell/box_gateway.dart' show BoxGateway;
import '../../features/validate.dart' show SettingError;
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart';
import '../../screens/widgets/pieces.dart';
import '../kinds.dart';
import '../video_rules.dart';
import '../play_now.dart';
import '../video_services.dart';
import 'content_form.dart';

enum _Stage { idle, checking, compressing, uploading }

class VideoEditor extends ConsumerStatefulWidget {
  const VideoEditor({super.key, required this.initial, required this.itemId, this.readOnly = false});

  final Map<String, dynamic> initial;
  final String? itemId;
  final bool readOnly;

  static Map<String, dynamic> defaults(int nextOrder) => {
    'title': '',
    'source': 'upload',
    'days': ['umum'],
    'order': nextOrder,
  };

  @override
  ConsumerState<VideoEditor> createState() => _VideoEditorState();
}

class _VideoEditorState extends ConsumerState<VideoEditor> {
  late final ContentKindSpec _spec = contentKindByKey('video')!;
  late final Map<String, dynamic> _values = {
    for (final f in _spec.fields)
      if (widget.initial.containsKey(f.key)) f.key: widget.initial[f.key],
  };
  late final String _newItemId = newId();
  final Set<String> _touched = {};
  bool _submitted = false;
  bool _busy = false;
  String? _error;

  _Stage _stage = _Stage.idle;
  double _progress = 0;
  String? _pickedName;
  String? _fileError;
  VideoStorage? _storage;

  /// The file this editor sent to the box and no saved item holds yet: removed again when it is replaced or the editor
  /// closes without saving, so the box does not keep a file nothing uses.
  String? _orphanId;
  bool _saved = false;
  BoxGateway? _gateway;

  late final TextEditingController _link = TextEditingController(
    text: _values['youtubeId'] is String ? 'https://youtu.be/${_values['youtubeId']}' : '',
  );
  late final TextEditingController _start = TextEditingController(
    text: _values['startSec'] is num ? clockOf((_values['startSec'] as num).toInt()) : '',
  );
  late final TextEditingController _end = TextEditingController(
    text: _values['endSec'] is num ? clockOf((_values['endSec'] as num).toInt()) : '',
  );
  late final TextEditingController _estimate = TextEditingController(
    text: _estimateTextOf(
      _values['durationSec'] is num && _values['source'] == 'rakaman'
          ? (_values['durationSec'] as num) - (_values['startSec'] is num ? _values['startSec'] as num : 0)
          : _values['durationSec'],
    ),
  );
  String? _linkError;
  YoutubeInfo? _info;
  int _linkRun = 0;
  bool _fetchingInfo = false;

  String get _source => (_values['source'] as String?) ?? 'upload';

  /// The minutes shown for a saved length of [seconds] (5 when there is none).
  static String _estimateTextOf(Object? seconds) {
    if (seconds is! num || seconds <= 0) return '5';
    return (seconds / 60).round().clamp(1, 10).toString();
  }

  /// The rough length in minutes; null when what is typed is not a whole number from 1 to 10.
  int? get _estimateMinutes {
    final n = int.tryParse(_estimate.text.trim());
    return n != null && n >= 1 && n <= 10 ? n : null;
  }

  /// A YouTube video, or a recording clip with no end, needs the rough length; a clip with an end does not.
  bool get _needsEstimate => _source == 'youtube' || (_source == 'rakaman' && _values['endSec'] is! num);

  /// An uploaded video opened over the cloud: its details are read-only (the file is on the box, so a save from here
  /// would fail with `asset_missing`). A new item, or a YouTube one, stays editable.
  bool get _uploadedViaCloud => _viaCloud && widget.itemId != null && widget.initial['source'] == 'upload' && _source == 'upload';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadStorage());
    final id = _values['youtubeId'];
    if (id is String && _source != 'upload') unawaited(_fetchInfo(id, fill: false));
  }

  /// Asks the box to remove an uploaded file nobody keeps. A failure (or a 404) is ignored and never waited for.
  void _discardUpload(String? id, BoxGateway? g) {
    if (id == null || g == null) return;
    unawaited(
      g.delete('/api/assets/video/$id').then<void>((_) {}, onError: (Object _) {}),
    );
  }

  @override
  void dispose() {
    if (!_saved) _discardUpload(_orphanId, _gateway);
    _link.dispose();
    _start.dispose();
    _end.dispose();
    _estimate.dispose();
    super.dispose();
  }

  void _set(String key, Object? value) => setState(() {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
    _touched.add(key);
    _error = null;
  });

  /// The item as it will be sent: only the fields of the chosen source, text trimmed, empty optional ones dropped.
  Map<String, dynamic> get _item {
    final keep = <String>{'title', 'source', 'days', 'from', 'to', 'order', 'sound'};
    // A box without `videoAfterPrayer` refuses the field: it is not sent there.
    if (ref.read(boxSupportsProvider('videoAfterPrayer'))) keep.add('afterPrayer');
    switch (_source) {
      case 'upload':
        keep.addAll(['assetId', 'durationSec']);
      case 'youtube':
        keep.add('youtubeId');
      case 'rakaman':
        keep.addAll(['youtubeId', 'startSec', 'endSec']);
    }
    final item = cleanItem(_spec, {for (final e in _values.entries) if (keep.contains(e.key)) e.key: e.value});
    // The length the slot is given (never the 10-minute default): a clip is its end minus its start; a YouTube video
    // (or a clip with no end) is the rough length the user gave.
    if (_source == 'youtube') {
      final m = _estimateMinutes;
      if (m != null) item['durationSec'] = m * 60;
    } else if (_source == 'rakaman') {
      final start = _values['startSec'] is num ? (_values['startSec'] as num).toInt() : 0;
      final end = _values['endSec'];
      if (end is num) {
        if (end > start) item['durationSec'] = (end - start).toInt();
      } else {
        final m = _estimateMinutes;
        if (m != null) item['durationSec'] = start + m * 60;
      }
    }
    return item;
  }

  bool get _viaCloud => ref.read(isCloudGatewayProvider);

  Future<void> _loadStorage() async {
    if (!mounted || widget.readOnly || _viaCloud) return;
    final g = ref.read(gatewayProvider);
    if (g == null) return;
    final st = await ref.read(videoServicesProvider).storage(g);
    if (mounted) setState(() => _storage = st);
  }

  void _changeSource(String source) {
    if (source == _source) return;
    setState(() {
      _values['source'] = source;
      _touched.add('source');
      _error = null;
      _fileError = null;
      _linkError = null;
      _values.remove('durationSec'); // an uploaded video's length is not a YouTube length
    });
    if (source == 'upload') unawaited(_loadStorage());
  }

  // ---- upload ----

  Future<void> _pickAndUpload() async {
    final s = S.of(context);
    final svc = ref.read(videoServicesProvider);
    final g = ref.read(gatewayProvider);
    if (g == null) return;
    _gateway = g;
    final picked = await svc.pick();
    if (picked == null || !mounted) return;
    // the file picked before is replaced: the box need not keep it
    _discardUpload(_orphanId, g);
    _orphanId = null;
    setState(() {
      _stage = _Stage.checking;
      _progress = 0;
      _fileError = null;
      _error = null;
      _pickedName = picked.name;
      _values.remove('assetId');
      _values.remove('durationSec');
    });
    var compressed = false;
    try {
      var video = picked;
      var facts = await inspectVideo(video);
      // A video that is too long cannot be mended on the phone: trim it in the Gallery first.
      if (facts != null && facts.durationSec > kVideoMaxSeconds + 1) {
        _fail(videoProblemText(s, VideoProblem.tooLong));
        return;
      }
      var problem = videoProblemOf(facts, video.length);
      if (problem != null) {
        if (!svc.canCompress) {
          _fail('${videoProblemText(s, problem)} ${s.videoCannotCompress}');
          return;
        }
        if (mounted) setState(() => _stage = _Stage.compressing);
        final smaller = await svc.compress(video, (p) {
          if (mounted) setState(() => _progress = p);
        });
        if (smaller == null) {
          _fail(videoProblemText(s, problem));
          return;
        }
        video = smaller;
        compressed = true;
        facts = await inspectVideo(video);
        problem = videoProblemOf(facts, video.length);
        if (problem != null) {
          _fail(videoProblemText(s, problem));
          return;
        }
      }
      final st = await svc.storage(g);
      if (st != null && mounted) setState(() => _storage = st);
      if (st != null && video.length > st.availableBytes) {
        _fail(s.errVideoNoSpace);
        return;
      }
      if (mounted) {
        setState(() {
          _stage = _Stage.uploading;
          _progress = 0;
        });
      }
      final up = await svc.upload(g, video, (p) {
        if (mounted) setState(() => _progress = p);
      });
      if (!mounted || _saved) {
        // the editor was closed while the file was going up
        _discardUpload(up.id, g);
        return;
      }
      _orphanId = up.id;
      setState(() {
        _values['assetId'] = up.id;
        final seconds = up.durationSec > 0 ? up.durationSec : (facts?.durationSec.round() ?? 0);
        if (seconds > 0) _values['durationSec'] = seconds;
        if ((_values['title'] as String? ?? '').trim().isEmpty) _values['title'] = _titleOfFile(picked.name);
        _touched.add('assetId');
        _stage = _Stage.idle;
      });
      unawaited(_loadStorage());
    } on Object catch (e) {
      if (!mounted) return;
      _fail(e is BoxError && e.code != null ? errorText(s, e) : (e is BoxError || e is BoxUnreachable ? s.errVideoUploadFailed : errorText(s, e)));
    } finally {
      // The compressed copy lives in the phone's cache, tens of megabytes each: gone once it is sent (or has failed).
      if (compressed) unawaited(svc.clearCompressed());
    }
  }

  void _fail(String text) {
    if (!mounted) return;
    setState(() {
      _stage = _Stage.idle;
      _fileError = text;
      _pickedName = null;
    });
  }

  static String _titleOfFile(String name) {
    final dot = name.lastIndexOf('.');
    final base = dot > 0 ? name.substring(0, dot) : name;
    final t = base.replaceAll(RegExp(r'[_]+'), ' ').trim();
    return t.length > 80 ? t.substring(0, 80) : t;
  }

  // ---- YouTube ----

  void _onLink(String text) {
    final s = S.of(context);
    final id = parseYoutubeId(text);
    setState(() {
      _info = null;
      if (text.trim().isEmpty) {
        _linkError = null;
        _values.remove('youtubeId');
      } else if (isYoutubeLiveLink(text)) {
        _linkError = s.videoYoutubeLive;
        _values.remove('youtubeId');
      } else if (id == null) {
        _linkError = s.videoYoutubeBad;
        _values.remove('youtubeId');
      } else {
        _linkError = null;
        _values['youtubeId'] = id;
      }
      _touched.add('youtubeId');
      _error = null;
    });
    if (id != null && !isYoutubeLiveLink(text)) unawaited(_fetchInfo(id, fill: true));
  }

  Future<void> _fetchInfo(String id, {required bool fill}) async {
    final run = ++_linkRun;
    setState(() => _fetchingInfo = true);
    final info = await ref.read(videoServicesProvider).oembed(id);
    if (!mounted || run != _linkRun) return;
    setState(() {
      _fetchingInfo = false;
      _info = info;
      if (fill && info != null && (_values['title'] as String? ?? '').trim().isEmpty) {
        _values['title'] = info.title.length > 80 ? info.title.substring(0, 80) : info.title;
      }
    });
  }

  void _onClip(String key, String text) {
    final secs = parseClock(text);
    _set(key, secs);
  }

  // ---- save and delete ----

  List<SettingError> _errors(S s) => [
    ...validateContent('video', _item, s: s).errors,
    if (_needsEstimate && _estimateMinutes == null) SettingError('estimate', s.videoEstimateBad),
  ];

  Future<void> _save() async {
    final s = S.of(context);
    final errors = _errors(s);
    if (errors.isNotEmpty || _stage != _Stage.idle) {
      setState(() => _submitted = true);
      return;
    }
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    final id = widget.itemId ?? _newItemId;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await gateway.put('${contentPath('video')}/$id', _item);
      _saved = true;
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(contentPath('video')));
      toast(context, s.contentSaved(_spec.label(appLangOf(context))));
      context.go(AppRoutes.contentFor('video'));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = contentWriteErrorText(s, e);
      });
    }
  }

  Future<void> _delete() async {
    final s = S.of(context);
    final id = widget.itemId;
    if (id == null) return;
    final ok = await confirmDialog(
      context,
      title: s.contentDeleteTitle(_spec.label(appLangOf(context)).toLowerCase()),
      body: s.contentDeleteBody,
      confirm: s.actionDelete,
      destructive: true,
    );
    if (!ok || !mounted) return;
    final gateway = ref.read(gatewayProvider);
    if (gateway == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await gateway.delete('${contentPath('video')}/$id');
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(contentPath('video')));
      toast(context, s.contentDeleted(_spec.label(appLangOf(context))));
      context.go(AppRoutes.contentFor('video'));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = contentWriteErrorText(s, e);
      });
    }
  }

  // ---- screen ----

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final lang = appLangOf(context);
    final cloudLocked = _uploadedViaCloud;
    final readOnly = widget.readOnly || _busy || cloudLocked;
    final errors = <String, String>{};
    for (final e in _errors(s)) {
      if (_submitted || _touched.contains(e.path)) errors.putIfAbsent(e.path, () => e.message);
    }
    final uploading = _stage != _Stage.idle;
    final canSave = _errors(s).isEmpty && !readOnly && !uploading;
    final cloud = _viaCloud;
    // Only a box that knows `afterPrayer` (health feature `videoAfterPrayer`) is offered the option.
    final afterPrayerOk = ref.watch(boxSupportsProvider('videoAfterPrayer'));

    Widget field(String key) => FieldEditor(
      spec: _spec.field(key),
      kind: 'video',
      value: _values[key],
      error: errors[key],
      hint: _spec.fieldHint(_spec.field(key), lang),
      readOnly: readOnly,
      onChanged: (v) => _set(key, v),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.readOnly)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
            child: Text(s.readOnlyHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          ),
        if (cloudLocked)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
            child: Text(s.videoCloudReadOnly, key: const ValueKey('video-cloud-readonly'), style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
          ),
        ChoiceChips(
          fieldKey: 'source',
          label: s.videoSourceLabel,
          choices: videoSources,
          labelOf: (c) => switch (c) {
            'upload' => s.videoSourceUpload,
            'youtube' => s.videoSourceYoutube,
            _ => s.videoSourceRakaman,
          },
          value: _source,
          readOnly: readOnly || uploading,
          onChanged: _changeSource,
        ),
        const SizedBox(height: 20),
        if (_source == 'upload') _uploadSection(context, s, text, cloud, readOnly) else _linkSection(context, s, text, errors, readOnly),
        const SizedBox(height: 20),
        field('title'),
        const SizedBox(height: 20),
        field('sound'),
        const SizedBox(height: 20),
        field('days'),
        const SizedBox(height: 20),
        field('from'),
        const SizedBox(height: 20),
        field('to'),
        const SizedBox(height: 20),
        if (afterPrayerOk) ...[
          ChoiceChips(
            fieldKey: 'afterPrayer',
            label: s.videoAfterPrayerLabel,
            hint: s.videoAfterPrayerHint,
            choices: const ['none', ...videoAfterPrayers],
            labelOf: (c) => switch (c) {
              'subuh' => s.hadisTvPrayerSubuh,
              'zohor' => s.videoAfterPrayerZohor,
              'asar' => s.hadisTvPrayerAsar,
              'maghrib' => s.hadisTvPrayerMaghrib,
              'isyak' => s.hadisTvPrayerIsyak,
              _ => s.videoAfterPrayerNone,
            },
            value: _values['afterPrayer'] is String ? _values['afterPrayer'] as String : 'none',
            readOnly: readOnly,
            onChanged: (v) => _set('afterPrayer', v == 'none' ? null : v),
          ),
          const SizedBox(height: 20),
        ],
        field('order'),
        const SizedBox(height: 20),
        OutlinedButton.icon(
          key: const ValueKey('video-preview'),
          onPressed: _canPreview ? () => showDialog<void>(context: context, builder: (_) => _PreviewDialog(item: _item, info: _info)) : null,
          icon: const Icon(Icons.tv_outlined),
          label: Text(s.videoPreview),
        ),
        if (widget.itemId != null && !widget.readOnly) PlayNowButton(itemId: widget.itemId!),
        const SizedBox(height: 20),
        if (_error != null) ...[ErrorLine(_error!), const SizedBox(height: 16)],
        if (uploading) ...[
          Text(s.videoWaitUpload, key: const ValueKey('video-wait'), style: text.bodySmall),
          const SizedBox(height: 8),
        ],
        if (!widget.readOnly) ...[
          if (!cloudLocked) ...[
            FilledButton.icon(
              key: const ValueKey('content-save'),
              onPressed: canSave ? _save : null,
              icon: const Icon(Icons.check_rounded),
              label: Text(s.settingsSave),
            ),
            const SizedBox(height: 8),
          ],
          TextButton(
            onPressed: _busy ? null : () => context.go(AppRoutes.contentFor('video')),
            child: Text(s.actionCancel),
          ),
          if (widget.itemId != null) ...[
            const SizedBox(height: 20),
            TextButton.icon(
              onPressed: _busy ? null : _delete,
              style: TextButton.styleFrom(foregroundColor: SurauColors.danger),
              icon: const Icon(Icons.delete_outline_rounded),
              label: Text(s.actionDelete),
            ),
          ],
        ],
      ],
    );
  }

  bool get _canPreview => _item['title'] != null || _values['assetId'] != null || _values['youtubeId'] != null;

  Widget _uploadSection(BuildContext context, S s, TextTheme text, bool cloud, bool readOnly) {
    if (cloud && !_uploadedViaCloud) {
      return _Panel(
        key: const ValueKey('video-cloud-note'),
        icon: Icons.wifi_rounded,
        child: Text(s.videoCloudNote, style: text.bodyMedium),
      );
    }
    final has = _values['assetId'] is String;
    final dur = _values['durationSec'];
    final st = _storage;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_stage != _Stage.idle)
          _Panel(
            key: const ValueKey('video-progress'),
            icon: Icons.upload_rounded,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (_pickedName != null) Text(_pickedName!, style: text.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                const SizedBox(height: 4),
                Text(switch (_stage) {
                  _Stage.compressing => s.videoCompressing((_progress * 100).round()),
                  _Stage.uploading => s.videoUploading((_progress * 100).round()),
                  _ => s.videoChecking,
                }),
                const SizedBox(height: 8),
                LinearProgressIndicator(value: _stage == _Stage.checking ? null : _progress),
              ],
            ),
          )
        else if (has)
          _Panel(
            key: const ValueKey('video-uploaded'),
            icon: Icons.check_circle_rounded,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.videoUploadedOk, style: text.titleSmall),
                if (dur is num) Text(clockOf(dur.toInt()), style: text.bodySmall),
              ],
            ),
          ),
        if (_fileError != null) ...[const SizedBox(height: 8), ErrorLine(_fileError!)],
        const SizedBox(height: 12),
        if (!readOnly)
          OutlinedButton.icon(
            key: const ValueKey('video-pick'),
            onPressed: _stage == _Stage.idle ? _pickAndUpload : null,
            icon: const Icon(Icons.video_library_outlined),
            label: Text(has ? s.videoPickAgain : s.videoPick),
          ),
        const SizedBox(height: 8),
        Text(s.videoLimitsNote, key: const ValueKey('video-limits'), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
        if (st != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              s.videoStorageLeft(sizeText(st.availableBytes)),
              key: const ValueKey('video-storage'),
              style: text.bodySmall!.copyWith(color: SurauColors.muted),
            ),
          ),
      ],
    );
  }

  Widget _linkSection(BuildContext context, S s, TextTheme text, Map<String, String> errors, bool readOnly) {
    final rakaman = _source == 'rakaman';
    final info = _info;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const ValueKey('field-youtubeLink'),
          controller: _link,
          readOnly: readOnly,
          keyboardType: TextInputType.url,
          textDirection: TextDirection.ltr,
          decoration: InputDecoration(
            labelText: s.videoYoutubeLink,
            hintText: s.videoYoutubeHint,
            errorText: _linkError ?? errors['youtubeId'],
            errorMaxLines: 4,
          ),
          onChanged: _onLink,
        ),
        if (_fetchingInfo) Padding(padding: const EdgeInsets.only(top: 8), child: Text(s.videoFetching, style: text.bodySmall)),
        if (info != null)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Row(
              key: const ValueKey('video-info'),
              children: [
                if (info.thumbnailUrl != null)
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: Image.network(
                      info.thumbnailUrl!,
                      width: 112,
                      height: 63,
                      fit: BoxFit.cover,
                      errorBuilder: (_, _, _) => const SizedBox(width: 112, height: 63, child: Icon(Icons.smart_display_outlined)),
                    ),
                  ),
                if (info.thumbnailUrl != null) const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(info.title, style: text.titleSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                      if (info.author != null) Text(info.author!, style: text.bodySmall),
                    ],
                  ),
                ),
              ],
            ),
          ),
        if (_needsEstimate) ...[
          const SizedBox(height: 16),
          TextField(
            key: const ValueKey('field-estimateMin'),
            controller: _estimate,
            readOnly: readOnly,
            keyboardType: TextInputType.number,
            textDirection: TextDirection.ltr,
            decoration: InputDecoration(
              labelText: s.videoEstimate,
              helperText: s.videoEstimateHint,
              helperMaxLines: 3,
              errorText: _estimateMinutes == null ? s.videoEstimateBad : null,
            ),
            onChanged: (_) => setState(() => _error = null),
          ),
        ],
        if (rakaman) ...[
          const SizedBox(height: 16),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextField(
                  key: const ValueKey('field-clipStart'),
                  controller: _start,
                  readOnly: readOnly,
                  keyboardType: TextInputType.datetime,
                  textDirection: TextDirection.ltr,
                  decoration: InputDecoration(labelText: s.videoClipStart, hintText: '0:00', errorText: errors['startSec']),
                  onChanged: (t) => _onClip('startSec', t),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  key: const ValueKey('field-clipEnd'),
                  controller: _end,
                  readOnly: readOnly,
                  keyboardType: TextInputType.datetime,
                  textDirection: TextDirection.ltr,
                  decoration: InputDecoration(labelText: s.videoClipEnd, hintText: '10:00', errorText: errors['endSec'], errorMaxLines: 3),
                  onChanged: (t) => _onClip('endSec', t),
                ),
              ),
            ],
          ),
        ],
        const SizedBox(height: 8),
        Text(rakaman ? s.videoRakamanNote : s.videoYoutubeNote, key: const ValueKey('video-link-note'), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
      ],
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({super.key, required this.icon, required this.child});

  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: SurauColors.paperDeep,
      borderRadius: BorderRadius.circular(SurauTheme.radiusCard),
      border: Border.all(color: SurauColors.line),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: SurauColors.teal),
        const SizedBox(width: 12),
        Expanded(child: child),
      ],
    ),
  );
}

/// `Pratonton`: a TV-shaped frame saying what the TV shows (the video full screen, the surau name and clock over it).
class _PreviewDialog extends StatelessWidget {
  const _PreviewDialog({required this.item, required this.info});

  final Map<String, dynamic> item;
  final YoutubeInfo? info;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final title = (item['title'] as String?) ?? '';
    final thumb = info?.thumbnailUrl;
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title.isEmpty ? s.videoPreview : title, key: const ValueKey('video-preview-title'), style: text.titleLarge, maxLines: 2, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 6),
            Text(s.videoPreviewHint, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            const SizedBox(height: 14),
            AspectRatio(
              aspectRatio: 16 / 9,
              child: Container(
                color: Colors.black,
                alignment: Alignment.center,
                child: thumb != null
                    ? Image.network(thumb, fit: BoxFit.cover, width: double.infinity, height: double.infinity, errorBuilder: (_, _, _) => const _PlayGlyph())
                    : const _PlayGlyph(),
              ),
            ),
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(s.actionClose)),
            ),
          ],
        ),
      ),
    );
  }
}

class _PlayGlyph extends StatelessWidget {
  const _PlayGlyph();

  @override
  Widget build(BuildContext context) => const Icon(Icons.play_circle_outline_rounded, color: Colors.white70, size: 64);
}
