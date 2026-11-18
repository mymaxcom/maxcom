// The Dart twin of packages/core/src/finance/schema.ts validateEntryShape:
// the checks the box makes on an entry body, run here before the entry is
// queued, so nothing is "saved" that the box will refuse and delete later.
// The `id` is not in the payload (the outbox adds it), so it is not checked.

const int _maxNote = 200;
const int _maxPayee = 80;
const int _maxReference = 60;
const int _reasonMin = 15;
const int _reasonMax = 500;
const int _countersRequired = 2;
const int _maxAmountSen = 1000000000;

final RegExp _safeId = RegExp(r'^[A-Za-z0-9_-]{1,100}$');
final RegExp _plain = RegExp(r'^[^<>\x00-\x1f\x7f]+$');
final RegExp _reasonPlain = RegExp(r'^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>]+$');
final RegExp _dateRe = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

/// The characters a single-line text field refuses: `<`, `>` and every
/// control character (a line break included).
final RegExp financeForbiddenChars = RegExp(r'[<>\x00-\x1f\x7f]');

bool _absent(Object? v) => v == null;

bool _realDate(Object? s) {
  if (s is! String) return false;
  final m = _dateRe.firstMatch(s);
  if (m == null) return false;
  final y = int.parse(m.group(1)!);
  final mo = int.parse(m.group(2)!);
  final d = int.parse(m.group(3)!);
  final t = DateTime.utc(y, mo, d);
  return t.year == y && t.month == mo && t.day == d;
}

/// First day of the month before [day] (`YYYY-MM-DD`).
String previousMonthStart(String day) {
  final y = int.parse(day.substring(0, 4));
  final m = int.parse(day.substring(5, 7));
  final py = m == 1 ? y - 1 : y;
  final pm = m == 1 ? 12 : m - 1;
  return '${py.toString().padLeft(4, '0')}-${pm.toString().padLeft(2, '0')}-01';
}

/// Why [v] would be refused by the box, as short English sentences (the
/// person never reads them: the form prevents each one). Empty means the
/// box accepts the shape. [windowKl] is the day the old end of the date
/// window is judged from (default [todayKl]); [startedOn] is the day the
/// finance module started (an opening balance dated on it is always inside).
List<String> validateEntryPayload(
  Map<String, dynamic> v, {
  required String todayKl,
  String? windowKl,
  String? startedOn,
}) {
  final errors = <String>[];
  final kind = v['kind'];
  if (kind is! String || !const ['in', 'out', 'opening', 'adjust'].contains(kind)) {
    errors.add('kind must be in, out, opening or adjust');
  }
  final date = v['entryDate'];
  if (!_realDate(date)) {
    errors.add('entryDate must be a real date YYYY-MM-DD');
  } else if ((date as String).compareTo(todayKl) > 0) {
    errors.add('entryDate cannot be in the future');
  } else if (date.compareTo(previousMonthStart(windowKl ?? todayKl)) < 0 &&
      !(kind == 'opening' &&
          startedOn != null &&
          startedOn.isNotEmpty &&
          date == startedOn)) {
    errors.add('entryDate cannot be before the previous month');
  }
  final fund = v['fundId'];
  if (fund is! String || !_safeId.hasMatch(fund)) errors.add('fundId is not valid');

  final amount = v['amountSen'];
  var amountSen = 0;
  if (amount is! int || amount < 0 || amount > _maxAmountSen) {
    errors.add('amountSen must be a whole number of sen');
  } else {
    amountSen = amount;
    if ((kind == 'in' || kind == 'out') && amount == 0) {
      errors.add('amountSen must be more than 0');
    }
  }

  void text(String name, int max) {
    final t = v[name];
    if (_absent(t)) return;
    if (t is! String) {
      errors.add('$name must be text');
      return;
    }
    if (t.isEmpty) return;
    if (t.trim().isEmpty || t.length > max || !_plain.hasMatch(t)) {
      errors.add('$name must be 1..$max characters of plain text');
    }
  }

  text('note', _maxNote);
  text('payee', _maxPayee);
  text('penceramahName', _maxPayee);

  if (kind == 'in' || kind == 'out') {
    final p = v['perihalId'];
    if (p is! String || !_safeId.hasMatch(p)) errors.add('perihalId is not valid');
    final method = v['method'];
    if (method is! String ||
        !const ['tunai', 'bank', 'duitnow', 'cek'].contains(method)) {
      errors.add('method must be tunai, bank, duitnow or cek');
    } else if (method == 'tunai') {
      if (!_absent(v['reference'])) errors.add('a cash entry has no reference');
      // A collection needs two counters; a payment needs none, two are
      // accepted when the person named them.
      if (kind == 'in' || !_absent(v['counters'])) {
        _counters(v['counters'], errors);
      }
    } else {
      if (!_absent(v['counters'])) errors.add('only a cash entry has counters');
      final r = v['reference'];
      if (r is! String ||
          r.trim().length < 3 ||
          r.length > _maxReference ||
          !_plain.hasMatch(r)) {
        errors.add('reference must be 3..$_maxReference characters of plain text');
      }
    }
    if (!_absent(v['denominations']) && method != 'tunai') {
      errors.add('only a cash entry has denominations');
    }
    if (kind == 'in') {
      final payee = v['payee'];
      if (payee is String && payee.isNotEmpty) errors.add('a collection has no payee');
    }
  } else if (kind == 'adjust') {
    final reason = v['reason'];
    if (reason is! String ||
        reason.trim().length < _reasonMin ||
        reason.trim().length > _reasonMax) {
      errors.add('reason must be $_reasonMin..$_reasonMax characters');
    } else if (!_reasonPlain.hasMatch(reason)) {
      errors.add('reason must be plain text');
    }
    final ck = v['correctionKind'];
    if (ck is! String || !const ['amount', 'void', 'fund'].contains(ck)) {
      errors.add('correctionKind must be amount, void or fund');
    } else if (ck == 'fund') {
      final to = v['toFundId'];
      if (to is! String || !_safeId.hasMatch(to)) {
        errors.add('toFundId is required');
      } else if (to == fund) {
        errors.add('toFundId must differ from the current tabung');
      }
      if (amountSen != 0) errors.add('amountSen must be 0 for a tabung change');
    } else if (ck == 'void' && amountSen != 0) {
      errors.add('amountSen must be 0 for a void');
    }
    final c = v['correctsId'];
    if (c is! String || !_safeId.hasMatch(c)) errors.add('correctsId is required');
  }
  return errors;
}

void _counters(Object? v, List<String> errors) {
  if (v is! List || v.length != _countersRequired) {
    errors.add('counters must list exactly $_countersRequired people');
    return;
  }
  final seen = <String>{};
  for (final raw in v) {
    final Map<Object?, Object?> c = raw is Map ? raw : const {};
    if (c.length != 1) {
      errors.add('a counter is { userId } or { name }');
      return;
    }
    final key = c.keys.first;
    final val = c[key];
    if (key == 'userId') {
      if (val is! String || !_safeId.hasMatch(val)) {
        errors.add('counter userId is not valid');
        return;
      }
      if (!seen.add('u:$val')) {
        errors.add('the two counters must be different people');
        return;
      }
    } else if (key == 'name') {
      if (val is! String ||
          val.trim().isEmpty ||
          val.length > _maxPayee ||
          !_plain.hasMatch(val)) {
        errors.add('counter name must be 1..$_maxPayee characters of plain text');
        return;
      }
      if (!seen.add('n:${val.trim().toLowerCase()}')) {
        errors.add('the two counters must be different people');
        return;
      }
    } else {
      errors.add('a counter is { userId } or { name }');
      return;
    }
  }
}
