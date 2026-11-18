// One rule for the name of a device, in enrol, first setup and recovery: the
// box keeps the trimmed name cut at 80 characters (`cleanName`,
// apps/box-server/src/auth/devices.ts), so the three fields accept 80 and
// send the name as the box will keep it.

/// The longest device name the box keeps.
const int maxDeviceNameLength = 80;

/// [raw] as the box will keep it: trimmed, at most [maxDeviceNameLength]
/// characters (code points, so an Arabic or emoji name is never cut in half).
String cleanDeviceName(String raw) {
  final t = raw.trim();
  final runes = t.runes;
  if (runes.length <= maxDeviceNameLength) return t;
  return String.fromCharCodes(runes.take(maxDeviceNameLength)).trim();
}
