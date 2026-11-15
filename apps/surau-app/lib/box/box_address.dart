// Which origin to enrol at, and how a box address is shown to a person.
//
// Neither changes who is trusted: the pinned CA, the boxId and the one-time
// code still decide that. This only picks a name the box answers to.

import 'box_name.dart';
import 'payload.dart';

/// The origin to enrol at. A web app may only call its own origin (the app's
/// CSP is `connect-src 'self'`), so when the page was opened at one of the
/// addresses the QR lists for this very box (its `box` host, its `name` or
/// one of its `ips`, on the same port) the enrolment goes to the page origin.
/// Anything else, and every non-web caller ([page] null), keeps `payload.box`.
Uri enrolOrigin(EnrolPayload payload, {Uri? page}) {
  final box = Uri.parse(payload.box);
  if (page == null || !page.hasAuthority || page.host.isEmpty) return box;
  if (page.scheme != box.scheme || page.port != box.port) return box;
  final host = page.host.toLowerCase();
  final own = <String>{
    box.host.toLowerCase(),
    if (payload.name != null && isBoxName(payload.name!))
      payload.name!.toLowerCase(),
    for (final ip in payload.ips) ip.toLowerCase(),
  };
  if (!own.contains(host)) return box;
  return Uri(
    scheme: page.scheme,
    host: page.host,
    port: page.hasPort ? page.port : null,
  );
}

/// The box address a person reads in `Butiran teknikal`: the numbered name
/// first when the box has one (`https://box1-surau.local:8443`), with the IP
/// address on a second line; just the address when it has no name.
String boxAddressText(Uri box, {String? name}) {
  if (name == null || !isBoxName(name) || box.host == name) {
    return box.toString();
  }
  final named = boxNameOrigin(name, box.port).toString();
  return isIpv4(box.host) ? '$named\n$box' : named;
}
