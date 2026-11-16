// The controls of the Ubah suai editor for one screen: background, picture
// display and position, layer darkness, main colour, text colour, font, text
// size and content alignment. Every change goes up as (key, value): a value is
// always written as itself (a font, size or alignment equal to the theme's own
// is still an explicit choice), and only "Ikut tema" (a null value) clears the
// key on this screen, so it follows the all-screens value, else the theme.

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../features/registry.g.dart' show accentSwatches;
import '../../features/theme/theme_style.dart';
import '../../l10n/generated/s.dart';

typedef StyleChange = void Function(String key, Object? value);

final RegExp _hexRe = RegExp(r'^#[0-9A-Fa-f]{6}$');

/// The screens that show Arabic text: the Tulisan Arab controls belong to them (not to Kuliah or Poster).
const Set<String> arabControlScreens = {'ayat', 'hadis', 'zikir', 'arab-ayat', 'arab-hadis', 'arab-zikir'};

// Where an option reaches the TV (checked against the kiosk's CSS and screens); an option is offered only there.

/// Screens that ignore Saiz teks: the main prayer screen, the live frame and the poster draw no text the scale touches.
const Set<String> scaleInertScreens = {'biasa', 'live', 'poster'};

/// Screens that ignore Susunan kandungan (Jajaran): the prayer screens centre their one block, the live frame and the
/// poster fill the stage, and the takwim rows shrink to their text.
const Set<String> alignInertScreens = {
  'biasa', 'azan', 'masuk-waktu', 'iqamah', 'solat', 'jumaat', 'tiada-data', 'live', 'poster', 'takwim',
};

/// Screens that draw the text in two layers, so the mark colour (Warna baris) shows: not the ayat card nor the zikir page.
const Set<String> harakatScreens = {'hadis', 'arab-ayat', 'arab-hadis', 'arab-zikir'};

/// Screens that lay the translation beside the Arabic (Terjemahan Sisi); elsewhere it always sits below.
const Set<String> tarjamahSideScreens = {'arab-ayat', 'arab-hadis'};

/// Screens that show Quranic text, the only text Uthmani Hafs draws (hadis and zikir stay in Amiri).
const Set<String> quranScreens = {'ayat', 'arab-ayat'};

Color _colour(String hex) => Color(0xFF000000 | int.parse(hex.substring(1), radix: 16));

class ThemeControls extends StatelessWidget {
  const ThemeControls({
    super.key,
    required this.entry,
    required this.theme,
    required this.screen,
    required this.onChange,
    required this.onPickPicture,
    this.base,
    this.arabLooksOn = true,
    this.readOnly = false,
    this.busyPicture = false,
  });

  final ThemeStyleEntry entry;

  /// The theme being edited (its own layer darkness is what the slider shows when nothing is saved).
  final String theme;
  final String screen;
  final StyleChange onChange;
  final VoidCallback onPickPicture;

  /// The built-in theme an uploaded theme is made on (null for a built-in theme): the gold outline follows the base.
  final String? base;

  /// Whether the theme shows ayat, hadis and zikir in their Arabic-led looks (else a note says the Arabic screens are unused).
  final bool arabLooksOn;
  final bool readOnly;
  final bool busyPicture;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    // What the surau set (this screen over all screens); the theme's own values only fill in the layer darkness.
    final v = effectiveStyle(entry, screen);
    bool changed(String k) => isChanged(entry, screen, k);
    final hasPicture = v['bgImage'] is String;
    // The layer darkness the TV really wears: the surau's value, else the theme's own; the default look keeps a minimum
    // while a picture shows (its text sits straight on the picture).
    final minShade = theme == 'default' && hasPicture ? minDefaultShade : 0;
    final shade = ((v['shade'] as num?) ?? (themeDefaultsOf(theme).semua['shade'] as num?) ?? otherThemeShade).toInt().clamp(minShade, 80);
    final fonts = <(String, String)>[('jakarta', 'Plus Jakarta Sans'), ('amiri', 'Amiri')];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Section(
          label: s.themeBg,
          changed: changed('bgImage'),
          note: s.themeBgNote,
          child: Row(
            children: [
              _Choice(
                keyName: 'ctl-bg-theme',
                label: s.themeFollowTheme,
                selected: !hasPicture,
                onTap: readOnly ? null : () => onChange('bgImage', null),
              ),
              const SizedBox(width: 8),
              _Choice(
                keyName: 'ctl-bg-own',
                label: s.themeOwnPicture,
                selected: hasPicture,
                onTap: readOnly || busyPicture ? null : onPickPicture,
              ),
              if (hasPicture) ...[
                const SizedBox(width: 8),
                TextButton(
                  key: const ValueKey('ctl-bg-change'),
                  onPressed: readOnly || busyPicture ? null : onPickPicture,
                  child: Text(s.themeChange),
                ),
              ],
            ],
          ),
        ),
        if (hasPicture) ...[
          _Section(
            label: s.themeFit,
            changed: changed('bgFit'),
            child: _Choices(
              prefix: 'ctl-fit',
              value: v['bgFit'] as String? ?? 'penuh',
              options: [('penuh', s.themeFitFull), ('regang', s.themeFitStretch), ('sederhana', s.themeFitMedium), ('kecil', s.themeFitSmall)],
              onPick: readOnly ? null : (x) => onChange('bgFit', x),
            ),
          ),
          _Section(
            label: s.themePos,
            changed: changed('bgPos'),
            child: _Choices(
              prefix: 'ctl-pos',
              value: v['bgPos'] as String? ?? 'tengah',
              options: [('kiri', s.themeLeft), ('tengah', s.themeCentre), ('kanan', s.themeRight)],
              onPick: readOnly ? null : (x) => onChange('bgPos', x),
            ),
          ),
        ],
        _Section(
          label: s.themeShade,
          changed: changed('shade'),
          trailing: '$shade%',
          note: s.themeShadeNote,
          child: Row(
            children: [
              _Choice(
                keyName: 'ctl-shade-follow',
                label: s.themeFollowTheme,
                selected: !hasOwn(entry, screen, 'shade'),
                onTap: readOnly ? null : () => onChange('shade', null),
              ),
              Expanded(
                child: Slider(
                  key: const ValueKey('ctl-shade'),
                  value: shade.toDouble(),
                  min: minShade.toDouble(),
                  max: 80,
                  divisions: (80 - minShade) ~/ 5,
                  label: '$shade%',
                  onChanged: readOnly ? null : (x) => onChange('shade', x.round()),
                ),
              ),
            ],
          ),
        ),
        _Section(
          label: s.themeAccent,
          changed: changed('accent'),
          child: _ColourPick(
            prefix: 'ctl-accent',
            value: v['accent'] as String?,
            followLabel: s.themeFollowTheme,
            otherLabel: s.themeAccentOther,
            hexLabel: s.themeCustomColour,
            swatches: accentSwatches,
            onChanged: readOnly ? null : (x) => onChange('accent', x),
          ),
        ),
        _Section(
          label: s.themeText,
          changed: changed('text'),
          child: _ColourPick(
            prefix: 'ctl-text',
            value: v['text'] as String?,
            followLabel: s.themeTextAuto,
            otherLabel: s.themeTextPick,
            hexLabel: s.themeCustomColour,
            swatches: accentSwatches,
            onChanged: readOnly ? null : (x) => onChange('text', x),
          ),
        ),
        _Section(
          label: s.themeFont,
          changed: changed('font'),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _Choice(
                keyName: 'ctl-font-follow',
                label: s.themeFollowTheme,
                selected: !hasOwn(entry, screen, 'font'),
                onTap: readOnly ? null : () => onChange('font', null),
              ),
              for (final (id, name) in fonts)
                _Choice(
                  keyName: 'ctl-font-$id',
                  label: name,
                  selected: v['font'] == id,
                  onTap: readOnly ? null : () => onChange('font', id),
                ),
            ],
          ),
        ),
        // The text scale and the alignment are offered only on the screens where they change something.
        if (!scaleInertScreens.contains(screen))
          _Section(
            label: s.themeSize,
            changed: changed('scale'),
            note: s.themeSizeNote,
            child: _Choices(
              prefix: 'ctl-scale',
              value: v['scale'] as String?,
              follow: _Follow(label: s.themeFollowTheme, selected: !hasOwn(entry, screen, 'scale'), onPick: readOnly ? null : () => onChange('scale', null)),
              options: const [('S', 'S'), ('M', 'M'), ('L', 'L'), ('XL', 'XL')],
              onPick: readOnly ? null : (x) => onChange('scale', x),
            ),
          ),
        if (!alignInertScreens.contains(screen))
          _Section(
            label: s.themeAlign,
            changed: changed('align'),
            child: _Choices(
              prefix: 'ctl-align',
              value: v['align'] as String?,
              follow: _Follow(label: s.themeFollowTheme, selected: !hasOwn(entry, screen, 'align'), onPick: readOnly ? null : () => onChange('align', null)),
              options: [('kiri', s.themeLeft), ('tengah', s.themeCentre), ('kanan', s.themeRight)],
              onPick: readOnly ? null : (x) => onChange('align', x),
            ),
          ),
        // A thin gold outline on the large text: Default, Old School and Arabic Art, and an uploaded theme made on one of
        // them (on by the theme's default).
        if (goldOutlineThemes.contains(base ?? theme))
          _Section(
            label: s.themeGoldOutline,
            changed: changed('goldOutline'),
            child: _Choices(
              prefix: 'ctl-gold',
              value: v['goldOutline'] as String?,
              follow: _Follow(label: s.themeFollowTheme, selected: !hasOwn(entry, screen, 'goldOutline'), onPick: readOnly ? null : () => onChange('goldOutline', null)),
              options: [('on', s.themeGoldOn), ('off', s.themeGoldOff)],
              onPick: readOnly ? null : (x) => onChange('goldOutline', x),
            ),
          ),
        if (arabControlScreens.contains(screen)) ..._arabControls(context, s, v, changed),
      ],
    );
  }

  /// "Tulisan Arab": face, size, mark colour, line spacing, translation place. Every value is written as itself;
  /// "Ikut tema" clears the key on this screen.
  List<Widget> _arabControls(BuildContext context, S s, StyleMap v, bool Function(String) changed) {
    final text = Theme.of(context).textTheme;
    final isArab = screen.startsWith('arab-');
    // Uthmani Hafs draws Quranic text only: offered on the Quran screens (and kept visible where one is already chosen).
    final showHafs = quranScreens.contains(screen) || (v['arFont'] == 'hafs' && changed('arFont'));
    final arFonts = <(String, String)>[
      if (showHafs) ('hafs', s.themeArFontHafs),
      ('amiri-quran', s.themeArFontAmiriQuran),
      ('amiri', s.themeArFontAmiri),
    ];
    // The values in force, the theme's own included (Uthmani Hafs until the surau or the theme chooses another face).
    final allowed = harakatAllowed({...themeDefaultsOf(theme).semua, ...v});
    final arScale = ((v['arScale'] as num?) ?? 100).toInt().clamp(100, 160);
    final arLine = ((v['arLineHeight'] as num?) ?? 19).toInt().clamp(16, 24);
    Widget ends(String a, String b, Widget slider) => Row(
      children: [
        Text(a, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
        Expanded(child: slider),
        Text(b, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
      ],
    );
    return [
      const SizedBox(height: 4),
      Text(s.themeArabSection, key: const ValueKey('ctl-arab-title'), style: text.titleMedium),
      if (isArab && !arabLooksOn) ...[
        const SizedBox(height: 6),
        Text(s.themeArabLooksOff, key: const ValueKey('ctl-arab-looks-off'), style: text.bodySmall!.copyWith(color: SurauColors.muted)),
      ],
      const SizedBox(height: 10),
      _Section(
        label: s.themeArFont,
        changed: changed('arFont'),
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            _Choice(
              keyName: 'ctl-arfont-follow',
              label: s.themeFollowTheme,
              selected: !hasOwn(entry, screen, 'arFont'),
              onTap: readOnly ? null : () => onChange('arFont', null),
            ),
            for (final (id, name) in arFonts)
              ChoiceChip(
                key: ValueKey('ctl-arfont-$id'),
                selected: v['arFont'] == id,
                onSelected: readOnly ? null : (_) => onChange('arFont', id),
                label: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(name),
                    Text(s.themeArFontSample, textDirection: TextDirection.rtl, style: const TextStyle(fontSize: 20, height: 1.5)),
                  ],
                ),
              ),
          ],
        ),
      ),
      _Section(
        label: s.themeArSize,
        changed: changed('arScale'),
        trailing: '$arScale%',
        child: Row(
          children: [
            _Choice(
              keyName: 'ctl-arscale-follow',
              label: s.themeFollowTheme,
              selected: !hasOwn(entry, screen, 'arScale'),
              onTap: readOnly ? null : () => onChange('arScale', null),
            ),
            Expanded(
              child: ends(
                s.themeArSizeSmall,
                s.themeArSizeBig,
                Slider(
                  key: const ValueKey('ctl-arscale'),
                  value: arScale.toDouble(),
                  min: 100,
                  max: 160,
                  divisions: 6,
                  label: '$arScale%',
                  onChanged: readOnly ? null : (x) => onChange('arScale', x.round()),
                ),
              ),
            ),
          ],
        ),
      ),
      // The mark colour needs the two-layer text: not on the ayat card nor the zikir page.
      if (harakatScreens.contains(screen))
        _Section(
          label: s.themeHarakat,
          changed: changed('harakat'),
          note: allowed ? null : s.themeHarakatNote,
          child: _ColourPick(
            prefix: 'ctl-harakat',
            value: v['harakat'] as String?,
            followLabel: s.themeHarakatFollow,
            otherLabel: s.themeHarakatOwn,
            hexLabel: s.themeCustomColour,
            swatches: accentSwatches,
            // A stored colour stays (dormant) under Uthmani Hafs; the control is only switched off.
            onChanged: readOnly || !allowed ? null : (x) => onChange('harakat', x),
          ),
        ),
      _Section(
        label: s.themeArLine,
        changed: changed('arLineHeight'),
        trailing: (arLine / 10).toStringAsFixed(1),
        child: Row(
          children: [
            _Choice(
              keyName: 'ctl-arlh-follow',
              label: s.themeFollowTheme,
              selected: !hasOwn(entry, screen, 'arLineHeight'),
              onTap: readOnly ? null : () => onChange('arLineHeight', null),
            ),
            Expanded(
              child: ends(
                s.themeArLineTight,
                s.themeArLineWide,
                Slider(
                  key: const ValueKey('ctl-arlh'),
                  value: arLine.toDouble(),
                  min: 16,
                  max: 24,
                  divisions: 8,
                  label: (arLine / 10).toStringAsFixed(1),
                  onChanged: readOnly ? null : (x) => onChange('arLineHeight', x.round()),
                ),
              ),
            ),
          ],
        ),
      ),
      // The translation sits beside the Arabic only on the two Arabic Art screens; elsewhere it is always below.
      if (tarjamahSideScreens.contains(screen))
        _Section(
          label: s.themeTarjamah,
          changed: changed('tarjamah'),
          note: s.themeTarjamahNote,
          child: _Choices(
            prefix: 'ctl-tarjamah',
            value: v['tarjamah'] as String?,
            follow: _Follow(label: s.themeFollowTheme, selected: !hasOwn(entry, screen, 'tarjamah'), onPick: readOnly ? null : () => onChange('tarjamah', null)),
            options: [('bawah', s.themeTarjamahBelow), ('sisi', s.themeTarjamahBeside)],
            onPick: readOnly ? null : (x) => onChange('tarjamah', x),
          ),
        ),
    ];
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.label, required this.child, this.changed = false, this.trailing, this.note});

  final String label;
  final Widget child;
  final bool changed;
  final String? trailing;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(label, style: text.titleSmall),
              if (changed) ...[
                const SizedBox(width: 8),
                Container(
                  key: ValueKey('badge-$label'),
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(color: SurauColors.goldSoft, borderRadius: BorderRadius.circular(SurauTheme.radiusChip)),
                  child: Text(s.themeChangedBadge, style: text.labelSmall!.copyWith(color: SurauColors.ink)),
                ),
              ],
              const Spacer(),
              if (trailing != null) Text(trailing!, style: text.titleSmall),
            ],
          ),
          const SizedBox(height: 6),
          child,
          if (note != null) ...[
            const SizedBox(height: 4),
            Text(note!, style: text.bodySmall!.copyWith(color: SurauColors.muted)),
          ],
        ],
      ),
    );
  }
}

class _Choice extends StatelessWidget {
  const _Choice({required this.keyName, required this.label, required this.selected, required this.onTap});

  final String keyName;
  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => ChoiceChip(
    key: ValueKey(keyName),
    label: Text(label),
    selected: selected,
    onSelected: onTap == null ? null : (_) => onTap!(),
  );
}

/// The "Ikut tema" choice of a row: selected while this screen has no value of its own.
class _Follow {
  const _Follow({required this.label, required this.selected, required this.onPick});

  final String label;
  final bool selected;
  final VoidCallback? onPick;
}

class _Choices extends StatelessWidget {
  const _Choices({required this.prefix, required this.value, required this.options, required this.onPick, this.follow});

  final String prefix;

  /// The value in force on this screen (its own, else all screens'); null when nothing is set.
  final String? value;
  final List<(String, String)> options;
  final ValueChanged<String>? onPick;
  final _Follow? follow;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 8,
    runSpacing: 8,
    children: [
      if (follow != null) _Choice(keyName: '$prefix-follow', label: follow!.label, selected: follow!.selected, onTap: follow!.onPick),
      for (final (id, label) in options)
        _Choice(keyName: '$prefix-$id', label: label, selected: value == id, onTap: onPick == null ? null : () => onPick!(id)),
    ],
  );
}

/// "Follow the theme" (null), the swatches, or an own colour typed as #rrggbb.
class _ColourPick extends StatefulWidget {
  const _ColourPick({
    required this.prefix,
    required this.value,
    required this.followLabel,
    required this.otherLabel,
    required this.hexLabel,
    required this.swatches,
    required this.onChanged,
  });

  final String prefix;
  final String? value;
  final String followLabel;
  final String otherLabel;
  final String hexLabel;
  final List<String> swatches;
  final ValueChanged<String?>? onChanged;

  @override
  State<_ColourPick> createState() => _ColourPickState();
}

class _ColourPickState extends State<_ColourPick> {
  late final TextEditingController _hex = TextEditingController(text: widget.value ?? '');
  bool _other = false;

  bool get _isSwatch => widget.value != null && widget.swatches.contains(widget.value!.toLowerCase());

  @override
  void dispose() {
    _hex.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.value;
    final showHex = _other || (v != null && !_isSwatch);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            _Choice(
              keyName: '${widget.prefix}-follow',
              label: widget.followLabel,
              selected: v == null && !_other,
              onTap: widget.onChanged == null
                  ? null
                  : () {
                      setState(() => _other = false);
                      widget.onChanged!(null);
                    },
            ),
            for (final hex in widget.swatches)
              InkWell(
                key: ValueKey('${widget.prefix}-$hex'),
                customBorder: const CircleBorder(),
                onTap: widget.onChanged == null
                    ? null
                    : () {
                        setState(() => _other = false);
                        widget.onChanged!(hex);
                      },
                child: Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: _colour(hex),
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: v != null && v.toLowerCase() == hex ? SurauColors.teal : SurauColors.line,
                      width: v != null && v.toLowerCase() == hex ? 3 : 1,
                    ),
                  ),
                ),
              ),
            _Choice(
              keyName: '${widget.prefix}-other',
              label: widget.otherLabel,
              selected: showHex,
              onTap: widget.onChanged == null ? null : () => setState(() => _other = true),
            ),
          ],
        ),
        if (showHex) ...[
          const SizedBox(height: 8),
          SizedBox(
            width: 220,
            child: TextField(
              key: ValueKey('${widget.prefix}-hex'),
              controller: _hex,
              enabled: widget.onChanged != null,
              decoration: InputDecoration(labelText: widget.hexLabel, isDense: true),
              onChanged: (t) {
                if (_hexRe.hasMatch(t.trim())) widget.onChanged!(t.trim().toLowerCase());
              },
            ),
          ),
        ],
      ],
    );
  }
}
