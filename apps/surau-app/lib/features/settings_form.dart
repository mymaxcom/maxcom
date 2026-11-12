// The one form every feature page draws, shaped by the registry defaults:
// a bool is a switch, a whole number a stepper inside its rule, an enum a
// row of choices (a menu when there are many), text a field, a null
// default an optional field, `images` the background picker, the `minutes`
// week table a 7 x 5 grid with `Salin ke semua hari`, and `minutesBefore`
// five fields in a row. Where the generated metadata names a widget for a
// field (slider, chips, named list, colour, audio file, template, preset)
// that widget is drawn instead, and system-scoped fields gather in a
// `Lanjutan` card at the bottom for those allowed to see them. Values stay
// plain JSON shapes; the page diffs them
// against the box's answer and validates the patch with the core-equal
// validator, so a refused value is red here before it is ever sent.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../app/theme.dart';
import '../content/adjusted_picture.dart';
import '../content/asset_picker.dart';
import '../content/image_ref.dart';
import '../l10n/generated/s.dart';
import '../screens/widgets/pieces.dart';
import 'data_sources.dart';
import 'labels_ms.dart';
import 'registry.g.dart';
import 'settings_widgets/audio_asset_picker.dart';
import 'settings_widgets/chips_field.dart';
import 'settings_widgets/colour_swatches.dart';
import 'settings_widgets/field_meta.dart';
import 'settings_widgets/lanjutan_card.dart';
import 'settings_widgets/named_dropdown.dart';
import 'settings_widgets/preset_text_field.dart';
import 'settings_widgets/reciter_dropdown.dart';
import 'settings_widgets/slider_field.dart';
import 'settings_widgets/surah_dropdown.dart';
import 'settings_widgets/template_field.dart';
import 'settings_widgets/test_button.dart';
import 'validate.dart';

const List<String> _days = ['ahad', 'isnin', 'selasa', 'rabu', 'khamis', 'jumaat', 'sabtu'];
const List<String> _prayers = ['subuh', 'zohor', 'asar', 'maghrib', 'isyak'];

/// A deep copy of a JSON shape, so edits never touch the original.
Object? copyJson(Object? v) {
  if (v is Map) return {for (final e in v.entries) e.key as String: copyJson(e.value)};
  if (v is List) return [for (final x in v) copyJson(x)];
  return v;
}

class SettingsForm extends StatelessWidget {
  const SettingsForm({
    super.key,
    required this.feature,
    required this.values,
    required this.errors,
    required this.onChanged,
    this.readOnly = false,
    this.lanjutanVisible = false,
    this.lanjutanKey,
  });

  final FeatureDef feature;

  /// The edited settings (without `enabled`), plain JSON shapes.
  final Map<String, dynamic> values;

  /// Core key path (`minutes.jumaat.subuh`) to the message to show.
  final Map<String, String> errors;

  /// Called with the top-level setting name and its whole new value.
  final void Function(String key, Object? value) onChanged;
  final bool readOnly;

  /// The person holds `system:read`: the Lanjutan card is drawn. Without it
  /// system-scoped fields are simply not on the page.
  final bool lanjutanVisible;

  /// Put on the Lanjutan card so the page can scroll to it (`?lj=1`).
  final Key? lanjutanKey;

  /// On a page that is all system values the card would say nothing new.
  bool get _systemPage => systemFeatures.contains(feature.key);

  @override
  Widget build(BuildContext context) {
    final sections = <Widget>[];
    var rows = <Widget>[];
    final lanjutan = <Widget>[];
    void flush() {
      if (rows.isEmpty) return;
      sections.add(RowsCard(children: rows));
      sections.add(const SizedBox(height: 20));
      rows = [];
    }

    // A preset message comes before the long week table, not under it.
    final entries = [
      ...feature.defaults.entries.where((e) => fieldMeta(feature.key, e.key)?.ui == 'presetText'),
      ...feature.defaults.entries.where((e) => fieldMeta(feature.key, e.key)?.ui != 'presetText'),
    ];
    for (final e in entries) {
      final key = e.key;
      final d = e.value;
      final v = values[key];
      // Phase B's stop flag is set by the fleet tools, never typed here.
      if (key == 'suspendedAt') continue;
      if (fieldMeta(feature.key, key)?.isSystem == true && !_systemPage) {
        if (lanjutanVisible) {
          lanjutan.add(_leafRow(context, path: key, name: key, d: d, v: v, onChanged: (nv) => onChanged(key, nv)));
        }
        continue;
      }
      // The verse range is one control, drawn at `ayatFrom`.
      if (key == 'ayatTo' && fieldMeta(feature.key, key)?.ui == 'ayatRange') continue;
      if (d is Map && _isWeekTable(d)) {
        flush();
        sections.add(SectionLabel(settingLabelMs(key)));
        sections.add(
          WeekTableEditor(
            name: key,
            value: (v is Map ? v : d).cast<String, dynamic>(),
            errors: errors,
            readOnly: readOnly,
            onChanged: (m) => onChanged(key, m),
          ),
        );
        sections.add(const SizedBox(height: 20));
      } else if (d is Map && _isPrayerRow(d)) {
        flush();
        sections.add(SectionLabel(settingLabelMs(key)));
        sections.add(
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
              child: PrayerRow(
                path: key,
                value: (v is Map ? v : d).cast<String, dynamic>(),
                errors: errors,
                readOnly: readOnly,
                onChanged: (m) => onChanged(key, m),
              ),
            ),
          ),
        );
        sections.add(const SizedBox(height: 20));
      } else if (d is List && key == 'images') {
        flush();
        sections.add(
          BackgroundPicker(
            value: v is List ? v.cast<String>() : const [],
            readOnly: readOnly,
            error: errors[key],
            onChanged: (list) => onChanged(key, list),
          ),
        );
        sections.add(const SizedBox(height: 20));
      } else if (d is String && key == 'logo') {
        // The surau logo (Maklumat surau): a picture field like the content
        // editors' in the logo's free shape, PNG or JPEG. The setting holds
        // the asset id or the adjusted image ('' for none); the box refuses
        // anything that is not a PNG or JPEG. `Paparkan nama surau juga`
        // sits under it with the header as the TV and the app draw it.
        flush();
        final s = S.of(context);
        final showName = values['showName'] is bool ? values['showName'] as bool : true;
        final hasLogo = ImageRef.parse(v) != null;
        sections.add(
          Card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 18),
                  child: ImageField(
                    key: const ValueKey('setting-logo'),
                    label: settingLabelMs(key),
                    value: v == '' ? null : v,
                    slot: ImageSlot.logo,
                    hint: s.logoHint,
                    readOnly: readOnly,
                    error: logoErrorText(s, errors[key]),
                    onChanged: (value) => onChanged(key, value ?? ''),
                  ),
                ),
                if (feature.defaults.containsKey('showName')) ...[
                  const Divider(),
                  SwitchListTile(
                    key: const ValueKey('setting-showName'),
                    value: showName,
                    onChanged: readOnly || !hasLogo ? null : (on) => onChanged('showName', on),
                    title: Text(settingLabelMs('showName')),
                    contentPadding: const EdgeInsets.fromLTRB(20, 6, 12, 6),
                  ),
                  if (hasLogo)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
                      child: LogoHeaderPreview(
                        logo: v,
                        name: values['name'] is String && (values['name'] as String).trim().isNotEmpty
                            ? (values['name'] as String).trim()
                            : '${feature.defaults['name'] ?? ''}',
                        showName: showName,
                      ),
                    ),
                ],
              ],
            ),
          ),
        );
        sections.add(const SizedBox(height: 20));
      } else if (key == 'showName' && feature.defaults.containsKey('logo')) {
        // Drawn with the logo above.
        continue;
      } else if (d is Map && isSourceKey(key)) {
        // A data source: one card with its name and https address. The
        // box rules the address (https, public host); its 400 lands under
        // the field through [errors].
        flush();
        sections.add(SectionLabel(settingLabelMs(key)));
        final sub = (v is Map ? v : d).cast<String, dynamic>();
        sections.add(
          RowsCard(
            children: [
              for (final x in d.entries)
                TextRow(
                  path: '$key.${x.key}',
                  label: sourceLeafLabelMs(x.key as String),
                  value: sub[x.key] is String ? sub[x.key] as String : '${x.value}',
                  maxLength: x.key == 'url' ? sourceUrlMaxLength : sourceNameMaxLength,
                  url: x.key == 'url',
                  hint: x.key == 'url' ? 'https://' : null,
                  error: errors['$key.${x.key}'],
                  readOnly: readOnly,
                  onChanged: (t) => onChanged(key, {...sub, x.key as String: t}),
                ),
              if (fieldMeta(feature.key, '$key.url')?.testable == true && !readOnly)
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 14),
                  child: TestButton(
                    body: {'kind': 'source', 'url': sub['url']},
                    enabled: errors['$key.url'] == null,
                  ),
                ),
            ],
          ),
        );
        sections.add(const SizedBox(height: 20));
      } else if (d is Map) {
        // A nested object the registry does not have today: its leaves as rows.
        flush();
        sections.add(SectionLabel(settingLabelMs(key)));
        final sub = (v is Map ? v : d).cast<String, dynamic>();
        sections.add(
          RowsCard(
            children: [
              for (final x in d.entries)
                _leafRow(
                  context,
                  path: '$key.${x.key}',
                  name: x.key as String,
                  d: x.value,
                  v: sub[x.key],
                  onChanged: (nv) => onChanged(key, {...sub, x.key as String: nv}),
                ),
            ],
          ),
        );
        sections.add(const SizedBox(height: 20));
      } else {
        rows.add(_leafRow(context, path: key, name: key, d: d, v: v, onChanged: (nv) => onChanged(key, nv)));
      }
    }
    flush();
    if (lanjutan.isNotEmpty) {
      final s = S.of(context);
      sections.add(
        KeyedSubtree(
          key: lanjutanKey,
          child: LanjutanCard(
            dimmed: feature.key == 'liveYoutube' && values['relayFrom'] == 'phone',
            dimNote: s.settingsLanjutanDimmed,
            children: lanjutan,
          ),
        ),
      );
      sections.add(const SizedBox(height: 20));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: sections);
  }

  /// The widget the metadata names for this field, or null to use the
  /// type-driven rows below.
  Widget? _metaRow(
    BuildContext context, {
    required String path,
    required String name,
    required String label,
    required String? error,
    required FieldMeta meta,
    required Object? d,
    required Object? v,
    required void Function(Object? value) onChanged,
  }) {
    final ro = readOnly || meta.readOnly;
    final help = settingHelpMs[name];
    switch (meta.ui) {
      case 'slider':
        return SliderField(
          path: path,
          label: label,
          value: v ?? d,
          meta: meta,
          help: help,
          error: error,
          readOnly: ro,
          onChanged: onChanged,
        );
      case 'chips':
        return ChipsField(
          path: path,
          name: name,
          label: label,
          value: v ?? d,
          meta: meta,
          help: help,
          error: error,
          readOnly: ro,
          onChanged: onChanged,
        );
      case 'segment':
        if (choiceHelpMs[name] != null) {
          return ChoiceCards(
            path: path,
            name: name,
            label: label,
            value: v is String ? v : '$d',
            meta: meta,
            error: error,
            readOnly: ro,
            onChanged: onChanged,
          );
        }
        return ChoiceField(
          path: path,
          name: name,
          label: label,
          value: v is String ? v : '$d',
          choices: [for (final c in meta.choices) '$c'],
          help: help,
          error: error,
          readOnly: ro,
          onChanged: onChanged,
        );
      case 'hijriMonth':
        return NamedDropdown(path: path, label: label, value: v ?? d, error: error, readOnly: ro, onChanged: onChanged);
      case 'surah':
        return SurahDropdown(
          path: path,
          label: label,
          value: v ?? d,
          error: error,
          readOnly: ro,
          onChanged: (nv) {
            onChanged(nv);
            // A shorter surah pulls the verses back inside it.
            final last = surahAyatCount(nv as int);
            final from = _intOf('ayatFrom');
            final to = _intOf('ayatTo');
            if (from > last) this.onChanged('ayatFrom', last);
            if (to > last) this.onChanged('ayatTo', last);
          },
        );
      case 'ayatRange':
        return AyatRange(
          surah: _intOf('surah'),
          from: _intOf('ayatFrom'),
          to: _intOf('ayatTo'),
          labelFrom: settingLabelMs('ayatFrom'),
          labelTo: settingLabelMs('ayatTo'),
          errorFrom: errors['ayatFrom'],
          errorTo: errors['ayatTo'],
          readOnly: ro,
          onFrom: (n) => this.onChanged('ayatFrom', n),
          onTo: (n) => this.onChanged('ayatTo', n),
        );
      case 'reciter':
        return ReciterDropdown(
          path: path,
          label: label,
          value: v is String ? v : '$d',
          meta: meta,
          error: error,
          readOnly: ro,
          onChanged: onChanged,
        );
      case 'colour':
        return ColourSwatches(
          path: path,
          label: label,
          value: v is String ? v : null,
          error: error,
          readOnly: ro,
          onChanged: onChanged,
        );
      case 'audioAsset':
        return AudioAssetPicker(path: path, value: v is String ? v : null, error: error, readOnly: ro, onChanged: onChanged);
      case 'template':
        return TemplateField(
          path: path,
          label: label,
          value: v is String ? v : '$d',
          meta: meta,
          title: name == 'titleTemplate',
          error: error,
          readOnly: ro,
          onChanged: onChanged,
        );
      case 'presetText':
        return PresetTextField(
          path: path,
          label: label,
          value: v is String ? v : '$d',
          meta: meta,
          error: error,
          readOnly: ro,
          onChanged: onChanged,
        );
      case 'phone':
      case 'email':
        final rule = ruleFor(name);
        return TextRow(
          path: path,
          label: label,
          value: v is String ? v : '$d',
          maxLength: rule != null && rule.type == SettingRuleType.text ? rule.max : maxText,
          hint: 'Contoh: ${_exampleFor(name)}',
          keyboardType: meta.ui == 'phone' ? TextInputType.phone : TextInputType.emailAddress,
          error: error,
          readOnly: ro,
          onChanged: (t) => onChanged(t),
        );
      default:
        return null;
    }
  }

  int _intOf(String key) {
    final v = values[key] ?? feature.defaults[key];
    return v is num ? v.toInt() : 1;
  }

  Widget _leafRow(
    BuildContext context, {
    required String path,
    required String name,
    required Object? d,
    required Object? v,
    required void Function(Object? value) onChanged,
  }) {
    final label = settingLabelMs(name);
    final error = errors[path];
    final meta = fieldMeta(feature.key, path);
    if (meta != null) {
      final row = _metaRow(
        context,
        path: path,
        name: name,
        label: label,
        error: error,
        meta: meta,
        d: d,
        v: v,
        onChanged: onChanged,
      );
      if (row != null) return row;
    }
    if (d is bool) {
      return SwitchListTile(
        key: ValueKey('setting-$path'),
        value: v is bool ? v : d,
        onChanged: readOnly ? null : onChanged,
        title: Text(label),
        contentPadding: const EdgeInsets.fromLTRB(20, 6, 12, 6),
      );
    }
    if (d is num) {
      final rule = ruleFor(name);
      if (rule != null && rule.type == SettingRuleType.intOf) {
        return ChoiceField(
          path: path,
          name: name,
          label: label,
          value: v is num ? '${v.toInt()}' : '${d.toInt()}',
          choices: rule.vals,
          error: error,
          readOnly: readOnly,
          onChanged: (t) => onChanged(int.parse(t)),
        );
      }
      final isInt = rule != null && rule.type == SettingRuleType.int;
      return IntStepper(
        path: path,
        label: label,
        value: v,
        min: isInt ? rule.min : 0,
        max: isInt ? rule.max : 1000000,
        error: error,
        readOnly: readOnly,
        onChanged: onChanged,
      );
    }
    if (d is String) {
      final rule = ruleFor(name);
      if (rule != null && rule.type == SettingRuleType.enumOf) {
        return ChoiceField(
          path: path,
          name: name,
          label: label,
          value: v is String ? v : d,
          choices: rule.vals,
          error: error,
          readOnly: readOnly,
          onChanged: onChanged,
        );
      }
      final max = rule != null && (rule.type == SettingRuleType.text) ? rule.max : maxText;
      return TextRow(
        path: path,
        label: label,
        value: v is String ? v : d,
        maxLength: max,
        hint: rule?.what == null ? null : 'Contoh: ${_exampleFor(name)}',
        error: error,
        readOnly: readOnly,
        onChanged: (t) => onChanged(t),
      );
    }
    if (d == null) {
      return TextRow(
        path: path,
        label: label,
        value: v is String ? v : '',
        maxLength: maxText,
        optional: true,
        error: error,
        readOnly: readOnly,
        onChanged: (t) => onChanged(t.isEmpty ? null : t),
      );
    }
    return ListTile(title: Text(label), subtitle: Text('$v'));
  }
}

/// The kiosk header as the TV and the app headers will draw it from the
/// unsaved values: the logo (adjusted look) at the header height with its
/// own shape and, when `Paparkan nama surau juga` is on, the name in gold
/// beside it, on the kiosk's glass.
class LogoHeaderPreview extends ConsumerWidget {
  const LogoHeaderPreview({super.key, required this.logo, required this.name, required this.showName});

  final Object? logo;
  final String name;
  final bool showName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final imageRef = ImageRef.parse(logo);
    final bytes = imageRef == null ? null : ref.watch(assetBytesProvider(imageRef.asset)).value;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s.logoHeaderPreview, style: text.bodySmall),
        const SizedBox(height: 8),
        Container(
          key: const ValueKey('logo-header-preview'),
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 14),
          decoration: BoxDecoration(
            color: SurauColors.glass,
            borderRadius: BorderRadius.circular(SurauTheme.radiusControl),
            border: Border.all(color: SurauColors.goldHairline),
          ),
          child: LayoutBuilder(
            builder: (context, constraints) => Row(
              children: [
                if (imageRef != null && bytes != null)
                  AdjustedPicture(
                    bytes: bytes,
                    ref: imageRef,
                    slot: ImageSlot.logo,
                    height: 44,
                    maxWidth: showName ? constraints.maxWidth * 0.55 : constraints.maxWidth,
                  )
                else
                  const SizedBox(width: 44, height: 44),
                if (showName) ...[
                  const SizedBox(width: 12),
                  Flexible(
                    child: Text(
                      name.toUpperCase(),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: text.titleSmall!.copyWith(color: SurauColors.gold, letterSpacing: 1.2),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// The box's refusal of a logo in BM: `logo must be a PNG or JPEG image`
/// and `logo refers to an asset that does not exist` (apps/box-server
/// app.ts) get the app's sentences; anything else is shown as given.
String? logoErrorText(S s, String? boxMessage) {
  if (boxMessage == null) return null;
  if (boxMessage.contains('must be a PNG or JPEG')) return s.logoNotImage;
  if (boxMessage.contains('does not exist')) return s.logoMissing;
  return boxMessage;
}

String _exampleFor(String name) => switch (name) {
  'zone' => 'SGR01',
  'reciter' => 'Husary_64kbps',
  'helpPhone' => '012-345 6789',
  'helpEmail' => 'nama@contoh.my',
  _ => '',
};

/// Core's limits for a data source (`ds.name` text 1..60, `ds.url` 300).
const int sourceNameMaxLength = 60;
const int sourceUrlMaxLength = 300;

bool _isWeekTable(Map<dynamic, dynamic> d) =>
    d.length == 7 && _days.every((day) => d[day] is Map);

bool _isPrayerRow(Map<dynamic, dynamic> d) =>
    d.isNotEmpty && d.keys.every((k) => _prayers.contains(k)) && d.values.every((x) => x is num);

// ---- numbers ----

/// What a number field shows for a value: the integer, or the raw text
/// the person typed when it could not be read as one.
String _numberText(Object? v) {
  if (v is num) return v == v.truncate() ? v.toInt().toString() : v.toString();
  if (v is String) return v;
  return '';
}

Object? _parseNumber(String text) {
  final t = text.trim();
  if (t.isEmpty) return '';
  return int.tryParse(t) ?? t;
}

/// A compact whole-number field: digits (and a minus) only, text kept in
/// step with [value] when the value changes from outside (copy to all
/// days, a save, a reset).
class NumberField extends StatefulWidget {
  const NumberField({
    super.key,
    required this.path,
    required this.value,
    required this.onChanged,
    this.readOnly = false,
    this.hasError = false,
    this.errorText,
    this.label,
    this.compact = false,
    this.textAlign = TextAlign.center,
  });

  final String path;
  final Object? value;
  final void Function(Object? value) onChanged;
  final bool readOnly;

  /// Red border without a message under the field (the grid shows the
  /// message once per day instead).
  final bool hasError;
  final String? errorText;
  final String? label;
  final bool compact;
  final TextAlign textAlign;

  @override
  State<NumberField> createState() => _NumberFieldState();
}

class _NumberFieldState extends State<NumberField> {
  late final TextEditingController _controller = TextEditingController(text: _numberText(widget.value));

  @override
  void didUpdateWidget(covariant NumberField old) {
    super.didUpdateWidget(old);
    if (_parseNumber(_controller.text) != widget.value) {
      _controller.text = _numberText(widget.value);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return TextField(
      key: ValueKey('setting-${widget.path}'),
      controller: _controller,
      enabled: !widget.readOnly,
      keyboardType: const TextInputType.numberWithOptions(signed: true),
      inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9-]'))],
      textAlign: widget.textAlign,
      style: text.titleMedium!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
      decoration: InputDecoration(
        labelText: widget.label,
        contentPadding: widget.compact
            ? const EdgeInsets.symmetric(horizontal: 6, vertical: 14)
            : const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
        errorText: widget.errorText,
        errorMaxLines: 3,
        error: widget.hasError && widget.errorText == null ? const SizedBox.shrink() : null,
        isDense: true,
      ),
      onChanged: (t) => widget.onChanged(_parseNumber(t)),
    );
  }
}

/// Label on the left, `[-] value [+]` on the right, stepping inside
/// [min]..[max]; typing is allowed and validated like any other value.
class IntStepper extends StatelessWidget {
  const IntStepper({
    super.key,
    required this.path,
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String path;
  final String label;
  final Object? value;
  final int min;
  final int max;
  final void Function(Object? value) onChanged;
  final String? error;
  final bool readOnly;

  int get _current {
    final v = value;
    if (v is num) return v.toInt();
    return min;
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final cur = _current;
    // Wide ranges (money in sen, up to 12 digits) need a field the full width
    // of the row, so the field drops under the label and the buttons.
    final wide = '$min'.length > 5 || '$max'.length > 5;
    final labels = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600)),
        Text('$min hingga $max', style: text.bodySmall),
      ],
    );
    final minus = IconButton.outlined(
      key: ValueKey('setting-$path-minus'),
      tooltip: s.settingsDecrease,
      onPressed: readOnly || cur <= min ? null : () => onChanged(cur - 1),
      icon: const Icon(Icons.remove_rounded),
    );
    final plus = IconButton.outlined(
      key: ValueKey('setting-$path-plus'),
      tooltip: s.settingsIncrease,
      onPressed: readOnly || cur >= max ? null : () => onChanged(cur + 1),
      icon: const Icon(Icons.add_rounded),
    );
    final field = NumberField(
      path: path,
      value: value,
      readOnly: readOnly,
      hasError: error != null,
      onChanged: onChanged,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (wide) ...[
            Row(
              children: [
                Expanded(child: labels),
                const SizedBox(width: 8),
                minus,
                plus,
              ],
            ),
            const SizedBox(height: 4),
            field,
          ] else
            Row(
              children: [
                Expanded(child: labels),
                const SizedBox(width: 8),
                minus,
                SizedBox(width: 84, child: field),
                plus,
              ],
            ),
          if (error != null) ...[
            const SizedBox(height: 6),
            Text(error!, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
          ],
        ],
      ),
    );
  }
}

// ---- choices and text ----

/// An enum setting: up to three choices side by side, a menu beyond that.
class ChoiceField extends StatelessWidget {
  const ChoiceField({
    super.key,
    required this.path,
    required this.name,
    required this.label,
    required this.value,
    required this.choices,
    required this.onChanged,
    this.error,
    this.help,
    this.readOnly = false,
  });

  final String path;
  final String name;
  final String label;
  final String value;
  final List<String> choices;
  final void Function(String value) onChanged;
  final String? error;
  final String? help;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final Widget control;
    if (choices.length <= 3) {
      control = SegmentedButton<String>(
        key: ValueKey('setting-$path'),
        segments: [
          for (final c in choices) ButtonSegment(value: c, label: Text(choiceLabelMs(name, c))),
        ],
        selected: {if (choices.contains(value)) value},
        emptySelectionAllowed: true,
        showSelectedIcon: false,
        style: ButtonStyle(
          minimumSize: const WidgetStatePropertyAll(Size(0, 48)),
          textStyle: WidgetStatePropertyAll(text.labelMedium),
          side: const WidgetStatePropertyAll(BorderSide(color: SurauColors.line)),
          backgroundColor: WidgetStateProperty.resolveWith(
            (st) => st.contains(WidgetState.selected) ? SurauColors.tealSoft : SurauColors.card,
          ),
          foregroundColor: WidgetStateProperty.resolveWith(
            (st) => st.contains(WidgetState.selected) ? SurauColors.glass : SurauColors.teal,
          ),
        ),
        onSelectionChanged: readOnly ? null : (sel) => onChanged(sel.first),
      );
    } else {
      control = DropdownMenu<String>(
        key: ValueKey('setting-$path'),
        initialSelection: value,
        enabled: !readOnly,
        expandedInsets: EdgeInsets.zero,
        dropdownMenuEntries: [
          for (final c in choices) DropdownMenuEntry(value: c, label: choiceLabelMs(name, c)),
        ],
        onSelected: (v) {
          if (v != null) onChanged(v);
        },
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: text.bodyLarge!.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 10),
          control,
          if (help != null) ...[
            const SizedBox(height: 8),
            Text(help!, style: text.bodySmall),
          ],
          if (error != null) ...[
            const SizedBox(height: 6),
            Text(error!, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
          ],
        ],
      ),
    );
  }
}

/// A text setting; optional ones say `Biarkan kosong untuk tetapan asal`.
class TextRow extends StatefulWidget {
  const TextRow({
    super.key,
    required this.path,
    required this.label,
    required this.value,
    required this.onChanged,
    this.maxLength = maxText,
    this.optional = false,
    this.hint,
    this.error,
    this.readOnly = false,
    this.url = false,
    this.keyboardType,
  });

  final String path;
  final String label;
  final String value;
  final void Function(String value) onChanged;

  /// A phone or email keyboard; [url] picks its own.
  final TextInputType? keyboardType;
  final int maxLength;
  final bool optional;
  final String? hint;
  final String? error;
  final bool readOnly;

  /// A web address: URL keyboard, no capitalisation or autocorrect, one
  /// line that scrolls.
  final bool url;

  @override
  State<TextRow> createState() => _TextRowState();
}

class _TextRowState extends State<TextRow> {
  late final TextEditingController _controller = TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(covariant TextRow old) {
    super.didUpdateWidget(old);
    if (_controller.text != widget.value) _controller.text = widget.value;
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
      child: TextField(
        key: ValueKey('setting-${widget.path}'),
        controller: _controller,
        enabled: !widget.readOnly,
        maxLength: widget.maxLength,
        maxLines: widget.maxLength > 120 && !widget.url ? null : 1,
        textCapitalization: widget.url ? TextCapitalization.none : TextCapitalization.sentences,
        keyboardType: widget.url ? TextInputType.url : widget.keyboardType,
        autocorrect: !widget.url,
        enableSuggestions: !widget.url,
        decoration: InputDecoration(
          labelText: widget.label,
          hintText: widget.hint,
          helperText: widget.optional ? s.settingsOptionalHint : null,
          errorText: widget.error,
          errorMaxLines: 3,
          counterText: '',
        ),
        onChanged: widget.onChanged,
      ),
    );
  }
}

// ---- prayer rows and the week table ----

/// Five number fields, Subuh to Isyak, for a `{subuh, zohor, ...}` map.
class PrayerRow extends StatelessWidget {
  const PrayerRow({
    super.key,
    required this.path,
    required this.value,
    required this.errors,
    required this.onChanged,
    this.readOnly = false,
  });

  final String path;
  final Map<String, dynamic> value;
  final Map<String, String> errors;
  final void Function(Map<String, dynamic> value) onChanged;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final cellErrors = [
      for (final p in _prayers)
        if (errors['$path.$p'] != null) errors['$path.$p']!,
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < _prayers.length; i++) ...[
              if (i > 0) const SizedBox(width: 6),
              Expanded(
                child: Column(
                  children: [
                    Text(
                      settingLabelMs(_prayers[i]),
                      style: text.labelSmall!.copyWith(color: SurauColors.muted),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 4),
                    NumberField(
                      path: '$path.${_prayers[i]}',
                      value: value[_prayers[i]],
                      readOnly: readOnly,
                      compact: true,
                      hasError: errors['$path.${_prayers[i]}'] != null,
                      onChanged: (nv) => onChanged({...value, _prayers[i]: nv}),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
        if (cellErrors.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(cellErrors.first, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
        ],
      ],
    );
  }
}

/// The 7 x 5 grid: one card per day, Subuh to Isyak across, with `Salin ke
/// semua hari` on each day's header.
class WeekTableEditor extends StatelessWidget {
  const WeekTableEditor({
    super.key,
    required this.name,
    required this.value,
    required this.errors,
    required this.onChanged,
    this.readOnly = false,
  });

  final String name;
  final Map<String, dynamic> value;
  final Map<String, String> errors;
  final void Function(Map<String, dynamic> value) onChanged;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < _days.length; i++) ...[
            if (i > 0) const Divider(),
            Padding(
              key: ValueKey('day-${_days[i]}'),
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(settingLabelMs(_days[i]), style: text.titleSmall),
                      ),
                      if (!readOnly)
                        TextButton.icon(
                          onPressed: () {
                            final row = copyJson(value[_days[i]]);
                            onChanged({for (final d in _days) d: copyJson(row)});
                            toast(context, s.settingsCopiedToAllDays(settingLabelMs(_days[i])));
                          },
                          icon: const Icon(Icons.copy_all_rounded, size: 20),
                          label: Text(s.settingsCopyToAllDays),
                        ),
                    ],
                  ),
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: PrayerRow(
                      path: '$name.${_days[i]}',
                      value: ((value[_days[i]] as Map?) ?? const {}).cast<String, dynamic>(),
                      errors: errors,
                      readOnly: readOnly,
                      onChanged: (row) => onChanged({...value, _days[i]: row}),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
