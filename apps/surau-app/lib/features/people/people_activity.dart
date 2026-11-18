// The live reads of the Peranti and Pengguna screens: the clean-up flags and
// the open enrolment codes. Both are answered by the box only, with the box's
// own clock; both give null instead of failing, and the screens then render
// the lists as they were before this feature (no badge, no card):
//
//  - an older box (404: the route does not exist, review focus 3),
//  - the box (or the connection) is away, or the call is live-only,
//  - the link is through the cloud, which cannot see unlocks made on the
//    surau Wi-Fi (the answer's `authority` is not `box`),
//  - any other refusal or an answer this app cannot read.
//
// An ended session is the one thing that is let through (and is not retried:
// the gateway has already told the app).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../box/box_client.dart';
import '../../sync/live_only.dart';

/// Every clean-up flag of the surau, from the server's clock (`GET
/// /api/people/activity`); null as described above.
final peopleActivityProvider = FutureProvider.autoDispose<PeopleActivityDto?>(retry: (_, _) => null, (ref) async {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return null;
  try {
    final body = await gateway.getFresh('/api/people/activity');
    final activity = PeopleActivityDto.fromJson(body);
    return activity.authorityIsBox ? activity : null;
  } on SessionExpired {
    rethrow;
  } on BoxError {
    return null;
  } on BoxUnreachable {
    return null;
  } on LiveOnly {
    return null;
  } on FormatException {
    return null;
  } on TypeError {
    return null;
  }
});

/// Every enrolment code of the surau that is not yet used, expired or ended
/// (`GET /api/enrol/open`); null under the same rules, and also whenever the
/// activity is null (a cloud link or an older box has no open-code list).
final openCodesProvider = FutureProvider.autoDispose<List<OpenCodeDto>?>(retry: (_, _) => null, (ref) async {
  final gateway = ref.watch(gatewayProvider);
  if (gateway == null) return null;
  final activity = await ref.watch(peopleActivityProvider.future);
  if (activity == null) return null;
  try {
    final body = await gateway.getFresh('/api/enrol/open');
    return [
      for (final c in (body['codes'] as List? ?? const []))
        if (c is Map<String, dynamic>) OpenCodeDto.fromJson(c),
    ];
  } on SessionExpired {
    rethrow;
  } on BoxError {
    return null;
  } on BoxUnreachable {
    return null;
  } on LiveOnly {
    return null;
  } on FormatException {
    return null;
  } on TypeError {
    return null;
  }
});
