// Web only: offer to open the app by the box's name instead of its IP address.
//
// The enrolment, the device key and all storage belong to one browser origin.
// A page opened at `https://<ip>:8443/app/` loses its enrolment when the box's
// IP changes; a page opened at `https://box1-surau.local:8443/app/` keeps it.
// Nothing here redirects by itself: a person taps a button.

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'box_name.dart';
import 'payload.dart';
import 'open_by_name_stub.dart' if (dart.library.js_interop) 'open_by_name_web.dart' as platform;

/// The origin the web page was opened at; null on every native platform.
Uri? pageOrigin() => platform.pageOrigin();

/// True only for an `https` origin whose host is a box name: the only place
/// the page may send a person (defence in depth behind every caller).
bool mayOpenOrigin(Uri origin) => origin.scheme == 'https' && isBoxName(origin.host);

/// Navigates the browser to `<origin>/app/`. Does nothing on native, and
/// nothing unless [mayOpenOrigin].
void openOrigin(Uri origin) {
  if (!mayOpenOrigin(origin)) return;
  platform.openOrigin(origin);
}

/// The box-name origin to offer on the enrol screen, or null for "nothing to
/// offer". Only when the page is one of the addresses [payload] lists for
/// THIS box (the same rule as `enrolOrigin`): its scheme and port are the
/// payload `box`'s and its host is that box's host or one of `ips`; the host
/// must be an IPv4 literal (not already a name or a domain) and the payload's
/// name a valid box name. [page] null (native) gives null.
Uri? enrolNameOriginToOffer({required Uri? page, required EnrolPayload payload}) {
  if (page == null || !page.hasAuthority || !isIpv4(page.host)) return null;
  final name = payload.name;
  if (name == null || !isBoxName(name)) return null;
  final box = Uri.parse(payload.box);
  if (page.scheme != box.scheme || page.port != box.port) return null;
  final host = page.host.toLowerCase();
  final own = <String>{box.host.toLowerCase(), for (final ip in payload.ips) ip.toLowerCase()};
  if (!own.contains(host)) return null;
  return boxNameOrigin(name, page.port);
}

/// Test seams: the page origin and the opener, read by the screens that take no constructor parameters.
final pageOriginProvider = Provider<Uri?>((ref) => pageOrigin());
final originOpenerProvider = Provider<void Function(Uri)>((ref) => openOrigin);

/// The enrolment's box host is an IPv4 literal and the box has a valid name: the name origin to offer (same port as
/// the enrolment), else null. Web only: [page] null (native) gives null.
Uri? enrolmentNameOriginToOffer({required Uri? page, required Uri box, required String? name}) {
  if (page == null || !isIpv4(box.host)) return null;
  if (name == null || !isBoxName(name)) return null;
  return boxNameOrigin(name, box.port);
}
