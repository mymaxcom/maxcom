// Web: the page's own origin, and a navigation to the app on another origin.

import 'package:web/web.dart' as web;

import 'box_name.dart';

Uri? pageOrigin() {
  final b = Uri.base;
  if (!b.hasAuthority || b.host.isEmpty) return null;
  return Uri(scheme: b.scheme, host: b.host, port: b.hasPort ? b.port : null);
}

void openOrigin(Uri origin) {
  if (origin.scheme != 'https' || !isBoxName(origin.host)) return;
  web.window.location.href = origin.replace(path: '/app/').toString();
}
