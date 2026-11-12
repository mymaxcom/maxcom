// The form every content editor is built on: one widget per field type
// from the kind's spec (text, a date with a calendar button, a time, a
// date and time, a whole number, choices as chips, a speaker or book or
// person from the box, the days as chips, a picture, a switch), the
// core-equal validator deciding when `Simpan` wakes up, and the save
// (`PUT /api/content/:kind/:id`, a fresh UUID for a new item) with the
// box's refusals in BM. Field errors show once a field has been touched,
// so a new form does not open covered in red.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/providers.dart';
import '../../app/router.dart';
import '../../app/theme.dart';
import '../../box/box_client.dart';
import '../../l10n/generated/s.dart';
import '../../screens/widgets/box_read.dart';
import '../../screens/widgets/pieces.dart';
import '../asset_picker.dart';
import '../image_ref.dart' show slotForField;
import '../kinds.dart';

String contentPath(String kind) => '/api/content/$kind';

/// The items of [kind] from a list body, meta included.
List<Map<String, dynamic>> parseItems(Map<String, dynamic> body) => [
  for (final x in (body['items'] as List? ?? const [])) (x as Map).cast<String, dynamic>(),
];

/// The one-line name of a referenced item (`penceramah`, `kitab`,
/// `petugas`).
String refName(Map<String, dynamic> item) =>
    (item['name'] ?? item['title'] ?? item['id'] ?? '').toString();

/// What a 409 from the box means to the person: the referenced thing is
/// gone (`Penceramah tidak dijumpai`), else the box's own words.
String contentWriteErrorText(S s, Object error) {
  if (error is BoxError && error.status == 409) {
    final m = error.message;
    for (final ref in const ['penceramah', 'kitab', 'petugas']) {
      if (m.contains('refers to a $ref')) {
        return s.contentRefMissing(contentKindByKey(ref)!.labelMs);
      }
    }
    return m;
  }
  return writeErrorText(s, error);
}

class ContentForm extends ConsumerStatefulWidget {
  const ContentForm({
    super.key,
    required this.spec,
    required this.initial,
    required this.itemId,
    this.readOnly = false,
    this.hints = const {},
    this.extra,
  });

  final ContentKindSpec spec;

  /// The item being edited (meta included), or the defaults for a new one.
  final Map<String, dynamic> initial;

  /// Null for a new item.
  final String? itemId;
  final bool readOnly;

  /// Extra guidance under a field, by field key.
  final Map<String, String> hints;

  /// Something of the editor's own between the fields and `Simpan`, built
  /// from the current (unsaved) values; the poster editor's `Pratonton di
  /// TV` lives here.
  final Widget Function(BuildContext context, Map<String, dynamic> values)? extra;

  @override
  ConsumerState<ContentForm> createState() => _ContentFormState();
}

class _ContentFormState extends ConsumerState<ContentForm> {
  late final Map<String, dynamic> _values = {
    for (final f in widget.spec.fields)
      if (widget.initial.containsKey(f.key)) f.key: widget.initial[f.key],
  };

  /// Minted once per form, so a retry after a lost reply updates the same
  /// item instead of adding a second one.
  late final String _newItemId = newId();
  final Set<String> _touched = {};
  bool _submitted = false;
  bool _busy = false;
  String? _error;

  void _set(String key, Object? value) => setState(() {
    _values[key] = value;
    _touched.add(key);
    _error = null;
  });

  Map<String, dynamic> get _clean => cleanItem(widget.spec, _values);

  Future<void> _save() async {
    final s = S.of(context);
    final spec = widget.spec;
    final item = _clean;
    final result = validateContent(spec.key, item);
    if (!result.ok) {
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
      await gateway.put('${contentPath(spec.key)}/$id', {
        ...item,
        for (final k in spec.carried)
          if (widget.initial.containsKey(k)) k: widget.initial[k],
      });
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(contentPath(spec.key)));
      toast(context, s.contentSaved(spec.labelMs));
      context.go(AppRoutes.contentFor(spec.key));
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
    final spec = widget.spec;
    final id = widget.itemId;
    if (id == null) return;
    final ok = await confirmDialog(
      context,
      title: s.contentDeleteTitle(spec.labelMs.toLowerCase()),
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
      await gateway.delete('${contentPath(spec.key)}/$id');
      if (!mounted) return;
      ref.invalidate(boxJsonProvider(contentPath(spec.key)));
      toast(context, s.contentDeleted(spec.labelMs));
      context.go(AppRoutes.contentFor(spec.key));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = contentWriteErrorText(s, e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final spec = widget.spec;
    final readOnly = widget.readOnly || _busy;
    final result = validateContent(spec.key, _clean);
    final errors = <String, String>{};
    for (final e in result.errors) {
      if (_submitted || _touched.contains(e.path)) errors.putIfAbsent(e.path, () => e.message);
    }
    // A range error belongs to both dates once both have been touched.
    final canSave = result.ok && !readOnly;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.readOnly)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 16),
            child: Text(
              s.readOnlyHint,
              style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: SurauColors.muted),
            ),
          ),
        for (final f in spec.fields) ...[
          FieldEditor(
            spec: f,
            kind: spec.key,
            value: _values[f.key],
            error: errors[f.key],
            hint: widget.hints[f.key] ?? f.hintMs,
            readOnly: readOnly,
            onChanged: (v) => _set(f.key, v),
          ),
          const SizedBox(height: 20),
        ],
        if (widget.extra != null) ...[widget.extra!(context, _clean), const SizedBox(height: 20)],
        if (_error != null) ...[ErrorLine(_error!), const SizedBox(height: 16)],
        if (!widget.readOnly) ...[
          FilledButton.icon(
            key: const ValueKey('content-save'),
            onPressed: canSave ? _save : null,
            icon: const Icon(Icons.check_rounded),
            label: Text(s.settingsSave),
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: _busy ? null : () => context.go(AppRoutes.contentFor(spec.key)),
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
}

/// One field by its spec type. Keys: `field-<key>` on the control.
class FieldEditor extends StatelessWidget {
  const FieldEditor({
    super.key,
    required this.spec,
    required this.kind,
    required this.value,
    required this.onChanged,
    this.error,
    this.hint,
    this.readOnly = false,
  });

  final FieldSpec spec;
  final String kind;
  final Object? value;
  final void Function(Object? value) onChanged;
  final String? error;
  final String? hint;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final f = spec;
    final label = f.required ? f.labelMs : '${f.labelMs} (${s.contentOptional.toLowerCase()})';
    switch (f.type) {
      case FieldType.text:
      case FieldType.multiline:
        return _TextInput(
          fieldKey: f.key,
          label: label,
          value: value is String ? value! as String : '',
          maxLength: f.maxLength,
          multiline: f.type == FieldType.multiline,
          hint: hint,
          error: error,
          readOnly: readOnly,
          onChanged: onChanged,
        );
      case FieldType.date:
        return DateInput(
          fieldKey: f.key,
          label: label,
          value: value is String ? value! as String : '',
          hint: hint,
          error: error,
          readOnly: readOnly,
          onChanged: onChanged,
        );
      case FieldType.time:
        return TimeInput(
          fieldKey: f.key,
          label: label,
          value: value is String ? value! as String : '',
          error: error,
          readOnly: readOnly,
          onChanged: onChanged,
        );
      case FieldType.dateTime:
        return DateTimeInput(
          fieldKey: f.key,
          label: label,
          value: value is String ? value! as String : '',
          error: error,
          readOnly: readOnly,
          onChanged: onChanged,
        );
      case FieldType.int:
        return IntInput(
          fieldKey: f.key,
          label: label,
          value: value,
          min: f.min,
          max: f.max,
          hint: hint,
          error: error,
          readOnly: readOnly,
          onChanged: onChanged,
        );
      case FieldType.enumOf:
      case FieldType.status:
      case FieldType.priority:
        final current = f.type == FieldType.priority
            ? (value is num ? (value! as num).toInt().toString() : null)
            : (value is String ? value! as String : null);
        return ChoiceChips(
          fieldKey: f.key,
          label: label,
          choices: f.choices,
          labelOf: f.choiceLabelMs,
          value: current,
          hint: hint,
          error: error,
          readOnly: readOnly,
          onChanged: (v) => onChanged(f.type == FieldType.priority ? int.parse(v) : v),
        );
      case FieldType.ref:
        return RefPicker(
          fieldKey: f.key,
          label: label,
          refKind: f.refKind!,
          value: value is String ? value! as String : null,
          required: f.required,
          error: error,
          readOnly: readOnly,
          onChanged: onChanged,
        );
      case FieldType.days:
        return DaysChips(
          fieldKey: f.key,
          label: label,
          value: value is List ? (value! as List).cast<String>() : const [],
          allowDaily: f.allowDaily,
          error: error,
          readOnly: readOnly,
          onChanged: onChanged,
        );
      case FieldType.asset:
        return ImageField(
          key: ValueKey('field-${f.key}'),
          label: f.labelMs,
          value: value,
          slot: slotForField(kind, f.key),
          required: f.required,
          readOnly: readOnly,
          error: error,
          hint: hint,
          onChanged: onChanged,
        );
      case FieldType.bool:
        return Card(
          child: SwitchListTile(
            key: ValueKey('field-${f.key}'),
            value: value == true,
            onChanged: readOnly ? null : onChanged,
            title: Text(f.labelMs),
            subtitle: hint == null ? null : Text(hint!),
            contentPadding: const EdgeInsets.fromLTRB(20, 6, 12, 6),
          ),
        );
      case FieldType.timezone:
        return _Labelled(
          label: label,
          error: error,
          hint: hint,
          child: DropdownMenu<String>(
            key: ValueKey('field-${f.key}'),
            initialSelection: value is String ? value! as String : null,
            enabled: !readOnly,
            expandedInsets: EdgeInsets.zero,
            enableFilter: true,
            requestFocusOnTap: true,
            hintText: s.contentPickRef(f.labelMs.toLowerCase()),
            dropdownMenuEntries: [
              for (final z in timezoneChoices)
                DropdownMenuEntry(value: z.$2, label: '${z.$1} (${z.$2})'),
            ],
            onSelected: (v) {
              if (v != null) onChanged(v);
            },
          ),
        );
    }
  }
}

/// A title, the control, an error or hint under it.
class _Labelled extends StatelessWidget {
  const _Labelled({required this.label, required this.child, this.error, this.hint});

  final String label;
  final Widget child;
  final String? error;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: text.titleSmall),
        const SizedBox(height: 10),
        child,
        if (error != null) ...[
          const SizedBox(height: 6),
          Text(error!, style: text.bodySmall!.copyWith(color: SurauColors.danger)),
        ] else if (hint != null) ...[
          const SizedBox(height: 6),
          Text(hint!, style: text.bodySmall),
        ],
      ],
    );
  }
}

/// A text controller that follows [value] when it changes from outside.
mixin _FollowsValue<T extends StatefulWidget> on State<T> {
  late final TextEditingController controller = TextEditingController(text: initialText);

  String get initialText;

  void follow(String value) {
    if (controller.text != value) controller.text = value;
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }
}

class _TextInput extends StatefulWidget {
  const _TextInput({
    required this.fieldKey,
    required this.label,
    required this.value,
    required this.maxLength,
    required this.multiline,
    required this.onChanged,
    this.hint,
    this.error,
    this.readOnly = false,
  });

  final String fieldKey;
  final String label;
  final String value;
  final int maxLength;
  final bool multiline;
  final void Function(String) onChanged;
  final String? hint;
  final String? error;
  final bool readOnly;

  @override
  State<_TextInput> createState() => _TextInputState();
}

class _TextInputState extends State<_TextInput> with _FollowsValue<_TextInput> {
  @override
  String get initialText => widget.value;

  @override
  void didUpdateWidget(covariant _TextInput old) {
    super.didUpdateWidget(old);
    follow(widget.value);
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final left = widget.maxLength - widget.value.trim().length;
    final nearLimit = left < widget.maxLength ~/ 5;
    return TextField(
      key: ValueKey('field-${widget.fieldKey}'),
      controller: controller,
      enabled: !widget.readOnly,
      maxLength: widget.maxLength,
      maxLines: widget.multiline ? null : 1,
      minLines: widget.multiline ? 3 : 1,
      keyboardType: widget.multiline ? TextInputType.multiline : TextInputType.text,
      textCapitalization: TextCapitalization.sentences,
      decoration: InputDecoration(
        labelText: widget.label,
        hintText: widget.hint,
        helperText: nearLimit ? s.contentCharsLeft(left < 0 ? 0 : left) : null,
        errorText: widget.error,
        errorMaxLines: 3,
        counterText: '',
        alignLabelWithHint: widget.multiline,
      ),
      onChanged: widget.onChanged,
    );
  }
}

/// `YYYY-MM-DD` typed or picked from the calendar; the date in words
/// under the field once it reads.
class DateInput extends StatefulWidget {
  const DateInput({
    super.key,
    required this.fieldKey,
    required this.label,
    required this.value,
    required this.onChanged,
    this.hint,
    this.error,
    this.readOnly = false,
  });

  final String fieldKey;
  final String label;
  final String value;
  final void Function(String) onChanged;
  final String? hint;
  final String? error;
  final bool readOnly;

  @override
  State<DateInput> createState() => _DateInputState();
}

class _DateInputState extends State<DateInput> with _FollowsValue<DateInput> {
  @override
  String get initialText => widget.value;

  @override
  void didUpdateWidget(covariant DateInput old) {
    super.didUpdateWidget(old);
    follow(widget.value);
  }

  Future<void> _pick() async {
    final parsed = DateTime.tryParse(widget.value);
    final picked = await showDatePicker(
      context: context,
      initialDate: parsed ?? DateTime.now(),
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (picked != null) widget.onChanged(isoDate(picked));
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final words = dateWordsMs(widget.value);
    return TextField(
      key: ValueKey('field-${widget.fieldKey}'),
      controller: controller,
      enabled: !widget.readOnly,
      keyboardType: TextInputType.datetime,
      inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9-]'))],
      decoration: InputDecoration(
        labelText: widget.label,
        hintText: s.contentDateHint,
        helperText: words == widget.value ? widget.hint : words,
        errorText: widget.error,
        errorMaxLines: 3,
        suffixIcon: widget.readOnly
            ? null
            : IconButton(
                tooltip: s.contentPickDate,
                icon: const Icon(Icons.calendar_month_outlined),
                onPressed: _pick,
              ),
      ),
      onChanged: widget.onChanged,
    );
  }
}

/// `HH:mm` typed or picked.
class TimeInput extends StatefulWidget {
  const TimeInput({
    super.key,
    required this.fieldKey,
    required this.label,
    required this.value,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String fieldKey;
  final String label;
  final String value;
  final void Function(String) onChanged;
  final String? error;
  final bool readOnly;

  @override
  State<TimeInput> createState() => _TimeInputState();
}

class _TimeInputState extends State<TimeInput> with _FollowsValue<TimeInput> {
  @override
  String get initialText => widget.value;

  @override
  void didUpdateWidget(covariant TimeInput old) {
    super.didUpdateWidget(old);
    follow(widget.value);
  }

  Future<void> _pick() async {
    final p = widget.value.split(':');
    final initial = p.length == 2 && int.tryParse(p[0]) != null && int.tryParse(p[1]) != null
        ? TimeOfDay(hour: int.parse(p[0]).clamp(0, 23), minute: int.parse(p[1]).clamp(0, 59))
        : const TimeOfDay(hour: 19, minute: 0);
    final picked = await showTimePicker(context: context, initialTime: initial);
    if (picked != null) widget.onChanged(isoTime(picked));
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final words = timeWordsMs(widget.value);
    return TextField(
      key: ValueKey('field-${widget.fieldKey}'),
      controller: controller,
      enabled: !widget.readOnly,
      keyboardType: TextInputType.datetime,
      inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9:]'))],
      decoration: InputDecoration(
        labelText: widget.label,
        hintText: s.contentTimeHint,
        helperText: words == widget.value ? null : words,
        errorText: widget.error,
        errorMaxLines: 3,
        suffixIcon: widget.readOnly
            ? null
            : IconButton(
                tooltip: s.contentPickTime,
                icon: const Icon(Icons.schedule_outlined),
                onPressed: _pick,
              ),
      ),
      onChanged: widget.onChanged,
    );
  }
}

/// `YYYY-MM-DDTHH:mm`: the calendar then the clock.
class DateTimeInput extends StatefulWidget {
  const DateTimeInput({
    super.key,
    required this.fieldKey,
    required this.label,
    required this.value,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String fieldKey;
  final String label;
  final String value;
  final void Function(String) onChanged;
  final String? error;
  final bool readOnly;

  @override
  State<DateTimeInput> createState() => _DateTimeInputState();
}

class _DateTimeInputState extends State<DateTimeInput> with _FollowsValue<DateTimeInput> {
  @override
  String get initialText => widget.value;

  @override
  void didUpdateWidget(covariant DateTimeInput old) {
    super.didUpdateWidget(old);
    follow(widget.value);
  }

  Future<void> _pick() async {
    final parsed = DateTime.tryParse(widget.value);
    final date = await showDatePicker(
      context: context,
      initialDate: parsed ?? DateTime.now(),
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: parsed == null
          ? const TimeOfDay(hour: 20, minute: 0)
          : TimeOfDay(hour: parsed.hour, minute: parsed.minute),
    );
    if (time == null) return;
    widget.onChanged('${isoDate(date)}T${isoTime(time)}');
  }

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final words = dateTimeWordsMs(widget.value);
    return TextField(
      key: ValueKey('field-${widget.fieldKey}'),
      controller: controller,
      enabled: !widget.readOnly,
      keyboardType: TextInputType.datetime,
      inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9:T-]'))],
      decoration: InputDecoration(
        labelText: widget.label,
        hintText: s.contentDateTimeHint,
        helperText: words == widget.value ? null : words,
        errorText: widget.error,
        errorMaxLines: 3,
        suffixIcon: widget.readOnly
            ? null
            : IconButton(
                tooltip: s.contentPickDate,
                icon: const Icon(Icons.event_outlined),
                onPressed: _pick,
              ),
      ),
      onChanged: widget.onChanged,
    );
  }
}

String isoDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

String isoTime(TimeOfDay t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

/// A whole number with `[-]` and `[+]` inside [min]..[max].
class IntInput extends StatefulWidget {
  const IntInput({
    super.key,
    required this.fieldKey,
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.onChanged,
    this.hint,
    this.error,
    this.readOnly = false,
  });

  final String fieldKey;
  final String label;
  final Object? value;
  final int min;
  final int max;
  final void Function(Object? value) onChanged;
  final String? hint;
  final String? error;
  final bool readOnly;

  @override
  State<IntInput> createState() => _IntInputState();
}

class _IntInputState extends State<IntInput> with _FollowsValue<IntInput> {
  static String textOf(Object? v) {
    if (v is num) return v == v.truncate() ? v.toInt().toString() : v.toString();
    if (v is String) return v;
    return '';
  }

  static Object? parse(String t) {
    final x = t.trim();
    if (x.isEmpty) return null;
    return int.tryParse(x) ?? x;
  }

  @override
  String get initialText => textOf(widget.value);

  @override
  void didUpdateWidget(covariant IntInput old) {
    super.didUpdateWidget(old);
    if (parse(controller.text) != widget.value) follow(textOf(widget.value));
  }

  int get _current => widget.value is num ? (widget.value! as num).toInt() : widget.min;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final cur = _current;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: TextField(
            key: ValueKey('field-${widget.fieldKey}'),
            controller: controller,
            enabled: !widget.readOnly,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9-]'))],
            style: text.titleMedium!.copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
            decoration: InputDecoration(
              labelText: widget.label,
              helperText: widget.hint ?? '${widget.min} hingga ${widget.max}',
              errorText: widget.error,
              errorMaxLines: 3,
            ),
            onChanged: (t) => widget.onChanged(parse(t)),
          ),
        ),
        const SizedBox(width: 8),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: IconButton.outlined(
            key: ValueKey('field-${widget.fieldKey}-minus'),
            tooltip: s.settingsDecrease,
            onPressed: widget.readOnly || cur <= widget.min ? null : () => widget.onChanged(cur - 1),
            icon: const Icon(Icons.remove_rounded),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: IconButton.outlined(
            key: ValueKey('field-${widget.fieldKey}-plus'),
            tooltip: s.settingsIncrease,
            onPressed: widget.readOnly || cur >= widget.max ? null : () => widget.onChanged(cur + 1),
            icon: const Icon(Icons.add_rounded),
          ),
        ),
      ],
    );
  }
}

/// Every choice visible as a chip; one selected.
class ChoiceChips extends StatelessWidget {
  const ChoiceChips({
    super.key,
    required this.fieldKey,
    required this.label,
    required this.choices,
    required this.labelOf,
    required this.value,
    required this.onChanged,
    this.hint,
    this.error,
    this.readOnly = false,
  });

  final String fieldKey;
  final String label;
  final List<String> choices;
  final String Function(String) labelOf;
  final String? value;
  final void Function(String value) onChanged;
  final String? hint;
  final String? error;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    return _Labelled(
      label: label,
      error: error,
      hint: hint,
      child: Wrap(
        key: ValueKey('field-$fieldKey'),
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final c in choices)
            ChoiceChip(
              label: Text(labelOf(c)),
              selected: value == c,
              showCheckmark: false,
              labelStyle: TextStyle(
                color: value == c ? SurauColors.glass : SurauColors.teal,
                fontWeight: FontWeight.w600,
              ),
              side: BorderSide(color: value == c ? SurauColors.teal : SurauColors.line),
              onSelected: readOnly ? null : (_) => onChanged(c),
            ),
        ],
      ),
    );
  }
}

/// `Setiap hari` or any of the seven days.
class DaysChips extends StatelessWidget {
  const DaysChips({
    super.key,
    required this.fieldKey,
    required this.label,
    required this.value,
    required this.allowDaily,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String fieldKey;
  final String label;
  final List<String> value;
  final bool allowDaily;
  final void Function(List<String> days) onChanged;
  final String? error;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final everyKey = allowDaily ? 'daily' : 'umum';
    final every = value.contains('umum') || value.contains('daily');
    Widget chip(String key, String text, bool selected, void Function() onTap) => FilterChip(
      key: ValueKey('day-$key'),
      label: Text(text),
      selected: selected,
      showCheckmark: true,
      checkmarkColor: SurauColors.glass,
      labelStyle: TextStyle(
        color: selected ? SurauColors.glass : SurauColors.teal,
        fontWeight: FontWeight.w600,
      ),
      side: BorderSide(color: selected ? SurauColors.teal : SurauColors.line),
      onSelected: readOnly ? null : (_) => onTap(),
    );
    return _Labelled(
      label: label,
      error: error,
      hint: s.contentDaysHint,
      child: Wrap(
        key: ValueKey('field-$fieldKey'),
        spacing: 8,
        runSpacing: 8,
        children: [
          chip(everyKey, s.contentEveryDay, every, () => onChanged(every ? [] : [everyKey])),
          for (final d in dayKeys)
            chip(d, dayLabelsMs[d]!, !every && value.contains(d), () {
              final next = [
                for (final x in value)
                  if (x != 'umum' && x != 'daily' && x != d) x,
              ];
              if (!value.contains(d) || every) next.add(d);
              onChanged([
                for (final x in dayKeys)
                  if (next.contains(x)) x,
              ]);
            }),
        ],
      ),
    );
  }
}

/// A speaker, book or person from the box's own list.
class RefPicker extends ConsumerWidget {
  const RefPicker({
    super.key,
    required this.fieldKey,
    required this.label,
    required this.refKind,
    required this.value,
    required this.required,
    required this.onChanged,
    this.error,
    this.readOnly = false,
  });

  final String fieldKey;
  final String label;
  final String refKind;
  final String? value;
  final bool required;
  final void Function(String? id) onChanged;
  final String? error;
  final bool readOnly;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = S.of(context);
    final text = Theme.of(context).textTheme;
    final refSpec = contentKindByKey(refKind)!;
    final read = ref.watch(boxJsonProvider(contentPath(refKind))).value;
    final items = read == null ? <Map<String, dynamic>>[] : parseItems(read.value);
    items.sort((a, b) => refName(a).toLowerCase().compareTo(refName(b).toLowerCase()));
    final known = items.any((x) => x['id'] == value);
    return _Labelled(
      label: label,
      error: error,
      hint: items.isEmpty && read != null ? s.contentNoRefItems(refSpec.labelMs) : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DropdownMenu<String>(
            key: ValueKey('field-$fieldKey'),
            initialSelection: known ? value : null,
            enabled: !readOnly && items.isNotEmpty,
            expandedInsets: EdgeInsets.zero,
            hintText: s.contentPickRef(refSpec.labelMs.toLowerCase()),
            dropdownMenuEntries: [
              if (!required) DropdownMenuEntry(value: '', label: s.contentNone),
              for (final x in items) DropdownMenuEntry(value: x['id'] as String, label: refName(x)),
            ],
            onSelected: (v) => onChanged(v == null || v.isEmpty ? null : v),
          ),
          if (value != null && !known && read != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                s.contentRefUnknown(refSpec.labelMs),
                style: text.bodySmall!.copyWith(color: SurauColors.danger),
              ),
            ),
        ],
      ),
    );
  }
}
