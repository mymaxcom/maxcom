// "Tetapan TV ini": the choices of one TV (name, template, language, the live broadcast on this TV, the content
// kinds it hides, its sounds). Every choice either follows the surau ("Ikut surau") or is this TV's own. A save sends
// the entry of this one TV (`PUT /api/settings/tvProfiles` with `{tvs: {<tvId>: {...}}}`); the box merges per TV, so
// no other TV's choices can be touched from here.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/shell.dart';
import '../../app/theme.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/pieces.dart' show ErrorLine, SectionLabel, toast;
import '../settings_repository.dart';
import '../theme/theme_providers.dart' show themeCards;
import 'screens_data.dart';
import 'tv_profile.dart';

class TvEditorScreen extends ConsumerStatefulWidget {
  const TvEditorScreen({super.key, required this.tvId});

  final String tvId;

  @override
  ConsumerState<TvEditorScreen> createState() => _TvEditorScreenState();
}

class _TvEditorScreenState extends ConsumerState<TvEditorScreen> {
  TvProfile? _orig;
  TvProfile _draft = const TvProfile();
  final _name = TextEditingController();
  String _nameFrom = '';
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  /// The settings arrived: the draft starts as the saved entry of this TV.
  void _load(Map<String, dynamic>? settings, String rowName) {
    if (_orig != null) return;
    final p = tvProfileOf(settings, widget.tvId);
    _orig = p;
    _draft = p;
    _nameFrom = p.name ?? rowName;
    _name.text = _nameFrom;
  }

  TvProfile _toSave() {
    final typed = _name.text.trim();
    // A name that was not touched keeps the entry as it was (no name set means the TV keeps its own name).
    final name = typed.isEmpty || typed == _nameFrom ? _draft.name : typed;
    return _draft.copyWith(name: name);
  }

  bool get _dirty => _orig != null && _toSave() != _orig;

  Future<void> _save() async {
    final repo = ref.read(settingsRepositoryProvider);
    if (repo == null || _saving) return;
    final profile = _toSave();
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await repo.save('tvProfiles', tvProfilePatch(widget.tvId, profile));
      if (!mounted) return;
      setState(() {
        _orig = profile;
        _draft = profile;
        _nameFrom = profile.name ?? _nameFrom;
        _saving = false;
      });
      toast(context, S.of(context).tvEdSaved);
    } on SettingsSaveError catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e.text(S.of(context));
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = S.of(context).errorRequestFailed;
      });
      assert(() {
        debugPrint('tv editor save: $e');
        return true;
      }());
    }
  }

  Future<void> _pickTemplate(Map<String, dynamic> settings) async {
    final s = S.of(context);
    final cards = themeCards(settings);
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
              child: Text(s.tvEdTemplatePickTitle, style: Theme.of(context).textTheme.titleLarge),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(s.tvEdTemplatePickHint, style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: SurauColors.muted)),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  ListTile(
                    key: const ValueKey('tv-template-follow'),
                    leading: Icon(_draft.templateId == null ? Icons.radio_button_checked_rounded : Icons.radio_button_unchecked_rounded),
                    title: Text(s.tvEdFollows),
                    onTap: () => Navigator.of(context).pop(''),
                  ),
                  for (final c in cards)
                    ListTile(
                      key: ValueKey('tv-template-${c.name}'),
                      leading: Icon(_draft.templateId == c.name ? Icons.radio_button_checked_rounded : Icons.radio_button_unchecked_rounded),
                      title: Text(c.title),
                      onTap: () => Navigator.of(context).pop(c.name),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    setState(() => _draft = _draft.copyWith(templateId: picked.isEmpty ? null : picked));
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final settingsRead = ref.watch(settingsProvider);
    final settings = settingsRead.value?.value;
    final rowsRead = ref.watch(screensDataProvider);
    final rowName = rowsRead.value?.byId(widget.tvId)?.name ?? '';
    // The name field starts as the TV's saved name, else the box's own name for it: wait for both answers.
    if (settings != null && !rowsRead.isLoading) _load(settings, rowName);
    final orig = _orig;
    final shownName = _name.text.trim().isEmpty ? rowName : _name.text.trim();

    if (orig == null) {
      return ShellPage(
        title: s.tvEdTitle,
        backTo: AppRoutes.screens,
        body: SurauTheme.page(
          children: [
            settingsRead.hasError
                ? ErrorLine(s.loadFailed)
                : const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: LinearProgressIndicator(minHeight: 2)),
          ],
        ),
      );
    }

    final liveSettings = settings!['liveOnKiosk'];
    final surauVolume = liveSettings is Map && liveSettings['volume'] is num ? (liveSettings['volume'] as num).toInt() : 70;
    final cards = themeCards(settings);
    final templateTitle = _draft.templateId == null
        ? s.tvEdFollows
        : (cards.where((c) => c.name == _draft.templateId).map((c) => c.title).firstOrNull ?? _draft.templateId!);
    final d = _draft;

    return ShellPage(
      title: s.tvEdTitle,
      backTo: AppRoutes.screens,
      body: SurauTheme.page(
        children: [
          Text(s.tvEdFor(shownName), key: const ValueKey('tv-ed-for'), style: text.bodyLarge!.copyWith(color: SurauColors.muted)),
          const SizedBox(height: 16),
          TextField(
            key: const ValueKey('tv-ed-name'),
            controller: _name,
            maxLength: 40,
            decoration: InputDecoration(labelText: s.tvEdName),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
          SectionLabel(s.tvEdLiveSection),
          _Group(
            children: [
              _ChoiceRow<bool>(
                key: const ValueKey('tv-ed-show'),
                label: s.tvEdShow,
                sub: d.show == null ? null : (d.show! ? s.tvEdShowOn : s.tvEdShowOff),
                value: d.show,
                changed: d.show != orig.show,
                options: [(true, s.tvEdShowYes), (false, s.tvEdShowNo)],
                onChanged: (v) => setState(() => _draft = d.copyWith(show: v)),
              ),
              _ChoiceRow<bool>(
                key: const ValueKey('tv-ed-sound'),
                label: s.tvEdSound,
                sub: d.audio == null ? null : (d.audio! ? s.tvEdSoundOn : s.tvEdSoundOff),
                value: d.audio,
                changed: d.audio != orig.audio,
                options: [(true, s.tvEdSoundYes), (false, s.tvEdSoundNo)],
                onChanged: (v) => setState(() => _draft = d.copyWith(audio: v)),
              ),
              _VolumeRow(
                key: const ValueKey('tv-ed-volume'),
                label: s.tvEdVolume,
                value: d.volume,
                follows: surauVolume,
                changed: d.volume != orig.volume,
                onChanged: (v) => setState(() => _draft = d.copyWith(volume: v)),
              ),
            ],
          ),
          const SizedBox(height: 16),
          SectionLabel(s.tvEdDisplay),
          _Group(
            children: [
              _ValueRow(
                key: const ValueKey('tv-ed-template'),
                label: s.tvEdTemplate,
                value: templateTitle,
                changed: d.templateId != orig.templateId,
                onTap: () => _pickTemplate(settings),
                onReset: d.templateId == null ? null : () => setState(() => _draft = d.copyWith(templateId: null)),
              ),
              _ChoiceRow<String>(
                key: const ValueKey('tv-ed-lang'),
                label: s.tvEdLang,
                value: d.lang,
                changed: d.lang != orig.lang,
                options: [
                  ('auto', s.tvEdLangAuto),
                  ('ms', s.tvEdLangMs),
                  ('en', s.tvEdLangEn),
                  ('ar', s.tvEdLangAr),
                ],
                onChanged: (v) => setState(() => _draft = d.copyWith(lang: v)),
              ),
            ],
          ),
          const SizedBox(height: 16),
          SectionLabel(s.tvEdContent),
          _Group(
            children: [
              _HideKindsRow(
                key: const ValueKey('tv-ed-hide'),
                label: s.tvEdHide,
                hint: s.tvEdHideHint,
                selected: d.hideKinds,
                changed: !_sameKinds(d.hideKinds, orig.hideKinds),
                onChanged: (v) => setState(() => _draft = d.copyWith(hideKinds: v)),
              ),
            ],
          ),
          const SizedBox(height: 16),
          SectionLabel(s.tvEdSounds),
          _Group(
            children: [
              _ChoiceRow<bool>(
                key: const ValueKey('tv-ed-beeps'),
                label: s.tvEdBeeps,
                sub: s.tvEdBeepsSub,
                value: d.beeps,
                changed: d.beeps != orig.beeps,
                options: [(true, s.tvEdOn), (false, s.tvEdOff)],
                onChanged: (v) => setState(() => _draft = d.copyWith(beeps: v)),
              ),
              _ChoiceRow<bool>(
                key: const ValueKey('tv-ed-azan'),
                label: s.tvEdAzan,
                sub: d.azan == false ? s.tvEdAzanOffSub : s.tvEdAzanSub,
                value: d.azan,
                changed: d.azan != orig.azan,
                options: [(true, s.tvEdOn), (false, s.tvEdOff)],
                onChanged: (v) => setState(() => _draft = d.copyWith(azan: v)),
              ),
              _ChoiceRow<bool>(
                key: const ValueKey('tv-ed-tilawah'),
                label: s.tvEdTilawah,
                sub: s.tvEdTilawahSub,
                value: d.tilawah,
                changed: d.tilawah != orig.tilawah,
                options: [(true, s.tvEdOn), (false, s.tvEdOff)],
                onChanged: (v) => setState(() => _draft = d.copyWith(tilawah: v)),
              ),
            ],
          ),
          const SizedBox(height: 20),
          if (_error != null) ...[ErrorLine(_error!), const SizedBox(height: 12)],
          FilledButton(
            key: const ValueKey('tv-ed-save'),
            onPressed: _dirty && !_saving ? _save : null,
            child: Text(s.actionSave),
          ),
        ],
      ),
    );
  }
}

bool _sameKinds(List<String> a, List<String> b) => a.length == b.length && a.toSet().containsAll(b);

/// A card of rows.
class _Group extends StatelessWidget {
  const _Group({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) const Divider(height: 1),
          Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 12), child: children[i]),
        ],
      ],
    ),
  );
}

/// The label of a row with its state: "Ikut surau" (grey) or "Diubah" (gold).
class _RowHead extends StatelessWidget {
  const _RowHead({required this.label, required this.sub, required this.changed, required this.follows, this.onReset});

  final String label;
  final String? sub;
  final bool changed;
  final bool follows;
  final VoidCallback? onReset;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: text.titleSmall),
              if (sub != null) Text(sub!, style: text.bodyMedium!.copyWith(color: SurauColors.muted)),
            ],
          ),
        ),
        const SizedBox(width: 8),
        if (changed)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(color: SurauColors.goldSoft, borderRadius: BorderRadius.circular(SurauTheme.radiusChip)),
            child: Text(s.tvEdChanged, style: text.labelSmall!.copyWith(color: SurauColors.ink)),
          )
        else if (follows)
          Text(s.tvEdFollows, style: text.labelSmall!.copyWith(color: SurauColors.muted)),
        if (onReset != null && !follows)
          TextButton(
            onPressed: onReset,
            style: TextButton.styleFrom(minimumSize: const Size(0, 36), padding: const EdgeInsets.symmetric(horizontal: 8)),
            child: Text(s.tvEdReset),
          ),
      ],
    );
  }
}

/// A choice between a few values, or "Ikut surau" (null).
class _ChoiceRow<T> extends StatelessWidget {
  const _ChoiceRow({
    super.key,
    required this.label,
    required this.value,
    required this.options,
    required this.onChanged,
    required this.changed,
    this.sub,
  });

  final String label;
  final String? sub;
  final T? value;
  final List<(T, String)> options;
  final void Function(T? v) onChanged;
  final bool changed;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _RowHead(label: label, sub: sub, changed: changed, follows: value == null, onReset: () => onChanged(null)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            ChoiceChip(
              key: ValueKey('${(key as ValueKey).value}-follow'),
              label: Text(s.tvEdFollows),
              selected: value == null,
              onSelected: (_) => onChanged(null),
            ),
            for (final o in options)
              ChoiceChip(
                key: ValueKey('${(key as ValueKey).value}-${o.$1}'),
                label: Text(o.$2),
                selected: value == o.$1,
                onSelected: (_) => onChanged(o.$1),
              ),
          ],
        ),
      ],
    );
  }
}

/// A row that opens a choice (the template).
class _ValueRow extends StatelessWidget {
  const _ValueRow({super.key, required this.label, required this.value, required this.changed, required this.onTap, required this.onReset});

  final String label;
  final String value;
  final bool changed;
  final VoidCallback onTap;
  final VoidCallback? onReset;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(child: _RowHead(label: label, sub: value, changed: changed, follows: onReset == null, onReset: onReset)),
          const Icon(Icons.chevron_right_rounded, color: SurauColors.outline),
        ],
      ),
    );
  }
}

class _VolumeRow extends StatelessWidget {
  const _VolumeRow({super.key, required this.label, required this.value, required this.follows, required this.changed, required this.onChanged});

  final String label;
  final int? value;

  /// The surau's own volume, shown while this TV follows it.
  final int follows;
  final bool changed;
  final void Function(int? v) onChanged;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final shown = value ?? follows;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _RowHead(label: label, sub: '$shown%', changed: changed, follows: value == null, onReset: () => onChanged(null)),
        Slider(
          key: const ValueKey('tv-ed-volume-slider'),
          value: shown.toDouble(),
          min: 0,
          max: 100,
          divisions: 20,
          label: '$shown%',
          onChanged: (v) => onChanged(v.round()),
        ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: ChoiceChip(
            key: const ValueKey('tv-ed-volume-follow'),
            label: Text(s.tvEdFollows),
            selected: value == null,
            onSelected: (_) => onChanged(null),
          ),
        ),
      ],
    );
  }
}

class _HideKindsRow extends StatelessWidget {
  const _HideKindsRow({super.key, required this.label, required this.hint, required this.selected, required this.changed, required this.onChanged});

  final String label;
  final String hint;
  final List<String> selected;
  final bool changed;
  final void Function(List<String> v) onChanged;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _RowHead(
          label: label,
          sub: selected.isEmpty ? s.tvEdHideNone : null,
          changed: changed,
          follows: selected.isEmpty,
          onReset: selected.isEmpty ? null : () => onChanged(const []),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (final k in tvHideKinds)
              FilterChip(
                key: ValueKey('tv-ed-hide-$k'),
                label: Text(tvKindLabel(s, k)),
                selected: selected.contains(k),
                avatar: selected.contains(k) ? const Icon(Icons.visibility_off_outlined, size: 18) : null,
                onSelected: (on) => onChanged([
                  for (final x in tvHideKinds)
                    if ((x == k) ? on : selected.contains(x)) x,
                ]),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Text(hint, style: text.bodySmall),
      ],
    );
  }
}

/// The name of a content kind a TV may hide.
String tvKindLabel(S s, String kind) => switch (kind) {
  'kuliah' => s.tvKindKuliah,
  'pengumuman' => s.tvKindPengumuman,
  'ticker' => s.tvKindTicker,
  'poster' => s.tvKindPoster,
  'video' => s.tvKindVideo,
  'programKhas' => s.tvKindProgramKhas,
  'takwim' => s.tvKindTakwim,
  'hadis' => s.tvKindHadis,
  'worldTime' => s.tvKindWorldTime,
  'tugasan' => s.tvKindTugasan,
  'zikir' => s.tvKindZikir,
  'tabung' => s.tvKindTabung,
  _ => kind,
};
