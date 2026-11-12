/// The box's PIN rule (`isValidPin` in apps/box-server/src/auth/crypto.ts):
/// exactly 6 ASCII digits, not all the same digit, not a straight ascending
/// or descending run. Checked here first so a weak PIN never leaves the
/// device; the box checks again.
bool isValidPin(String pin) {
  if (pin.length != 6) return false;
  final digits = <int>[];
  for (final c in pin.codeUnits) {
    if (c < 0x30 || c > 0x39) return false;
    digits.add(c - 0x30);
  }
  if (digits.every((d) => d == digits.first)) return false;
  var ascending = true;
  var descending = true;
  for (var i = 1; i < digits.length; i++) {
    final step = digits[i] - digits[i - 1];
    if (step != 1) ascending = false;
    if (step != -1) descending = false;
  }
  return !ascending && !descending;
}

/// Length of every PIN the app accepts.
const int pinLength = 6;
