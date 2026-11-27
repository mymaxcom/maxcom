// Web: replaces the address, keeping the page and the route but not the join ticket.

import 'package:web/web.dart' as web;

String currentFragment() => Uri.base.fragment;

void scrubJoinAddress() {
  final u = Uri.base;
  if (!u.fragment.contains('join=')) return;
  final clean = u.replace(fragment: '/enrol');
  web.window.history.replaceState(null, '', clean.toString());
}
