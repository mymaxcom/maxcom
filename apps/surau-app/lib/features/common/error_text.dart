// One map from what a failed request says to what the person reads.
//
// The box sends a stable `code` (and, where a text needs numbers, a `detail`
// object) with every refusal; the sentence it also sends is BM or English and
// is only for an older app. This file turns the code into the app's own text
// in the person's language. Where the box sent no code, or one this app does
// not know (a newer box), the server's sentence is shown as it came.

import '../../box/box_client.dart';
import '../../l10n/generated/s.dart';
import '../../sync/live_only.dart';
import '../../sync/sync_engine.dart' show AssetTooLarge;
import '../live/camera_url.dart' show cameraReasonText;
import '../people/people_api.dart' show BadPhone, PeopleNeedsUpdate;
import '../prayer/prayer_names.dart' show importRowReason, rowFieldName;
import '../shell/box_gateway.dart' show OfflineWriteRefused;

/// A code's text, given the catalogue and the answer's `detail`.
typedef ErrorCodeText = String Function(S s, Map<String, dynamic> detail);

int _int(Map<String, dynamic> d, String key, [int fallback = 0]) {
  final v = d[key];
  return v is num ? v.toInt() : fallback;
}

/// Every code the box sends today (`code: '...'` and `new AuthError(status,
/// '...')` under apps/box-server/src), plus the codes of release 2026.11.12.
/// Codes absent here whose answer carries its own specific sentence
/// (`invalid`, `bad_asset`, `bad_body`) show that sentence.
final Map<String, ErrorCodeText> kErrorCodeTexts = <String, ErrorCodeText>{
  // Session, PIN and unlock.
  'no_session': (s, d) => s.errorSessionExpired,
  'session_expired': (s, d) => s.errorSessionExpired,
  'device_revoked': (s, d) => s.errorDeviceRevoked,
  'user_inactive': (s, d) => s.errorDeviceRevoked,
  'bad_nonce': (s, d) => s.errcUnlockFailed,
  'bad_signature': (s, d) => s.errcUnlockFailed,
  'box_mismatch': (s, d) => s.errcUnlockFailed,
  'wrong_pin': (s, d) => s.errcWrongPin,
  'locked': (s, d) => s.errcLocked(_int(d, 'minutes', 1)),
  'pin_policy': (s, d) => s.errcPinPolicy,
  'pin_exists': (s, d) => s.errcPinExists,
  'pin_required': (s, d) => s.errcPinRequired,
  'pin_missing': (s, d) => s.errcPinMissing,
  'app_lock_off': (s, d) => s.errcAppLockOff,
  'surau_suspended': (s, d) => s.errcSuspended,
  'forbidden': (s, d) => s.errorForbidden,
  // Enrolling and pairing.
  'bad_enrol_code': (s, d) => s.errcBadEnrolCode,
  'enrol_code_unknown': (s, d) => s.ra5CodeUnknown,
  'enrol_code_expired': (s, d) => s.errCodeExpired,
  'enrol_code_used': (s, d) => s.errCodeUsed,
  'bad_key': (s, d) => s.errcBadRequest,
  'bad_platform': (s, d) => s.errcBadRequest,
  'bad_time': (s, d) => s.errcBadRequest,
  'bad_args': (s, d) => s.errcBadRequest,
  'bad_ttl': (s, d) => s.errcBadTtl,
  'bad_device': (s, d) => s.errcBadDevice,
  'bad_pair_code': (s, d) => s.errcBadPairCode,
  'pair_gone': (s, d) => s.errcPairGone,
  'too_many_codes': (s, d) => s.errorTooMany,
  'too_many_pairings': (s, d) => s.errorTooMany,
  'too_many': (s, d) => s.errorTooMany,
  'box_only': (s, d) => s.errcBoxOnly,
  // Users and devices.
  'user_not_found': (s, d) => s.errcUserNotFound,
  'device_not_found': (s, d) => s.errcDeviceNotFound,
  'not_found': (s, d) => s.errcNotFound,
  'none': (s, d) => s.errcNotFound,
  'bad_name': (s, d) => s.errcBadName,
  'bad_roles': (s, d) => s.errcBadRoles,
  'last_admin': (s, d) => s.errcLastAdmin,
  'last_superadmin': (s, d) => s.errcLastSuperadmin,
  'last_admin_device': (s, d) => s.errcLastAdminDevice,
  'ref_mismatch': (s, d) => s.errcRefMismatch,
  'own_account': (s, d) => s.errcOwnAccount,
  'phone_required': (s, d) => s.errcPhoneRequired,
  'bad_phone': (s, d) => s.errcBadPhone,
  // The box names the other person by ID only (`detail.ref`); an older box sends none.
  'phone_taken': (s, d) => d['ref'] is String ? s.phoneTaken(d['ref'] as String) : s.errcPhoneTaken,
  'superadmin_cli_only': (s, d) => s.errcSuperadminCliOnly,
  'superadmin_cloud_only': (s, d) => s.errcSuperadminCloudOnly,
  'superadmin_exists': (s, d) => s.errcSuperadminExists,
  'ops_app_required': (s, d) => s.errcOpsAppRequired,
  'ops_cli_only': (s, d) => s.errcOpsCliOnly,
  'not_ops_user': (s, d) => s.errcNotOpsUser,
  'ops_device_limit': (s, d) => s.errcOpsDeviceLimit,
  'not_ops_device': (s, d) => s.errcNotOpsDevice,
  'not_empty': (s, d) => s.errcNotEmpty,
  'module_off': (s, d) => s.errcModuleOff,
  // Content.
  'content_in_use': (s, d) => s.errcContentInUse(_int(d, 'count')),
  'asset_missing': (s, d) => s.errcAssetMissing,
  'hadis_full': (s, d) => s.errcHadisFull,
  'id_mismatch': (s, d) => s.errcBadRequest,
  // Live, camera and audio.
  'live_busy': (s, d) => s.errcLiveBusy,
  'bad_choice': (s, d) => s.errcBadChoice,
  'unusable': (s, d) => s.errcUnusable,
  'camera_error': (s, d) => s.errcCameraError,
  'not_configured': (s, d) => s.errcCameraNotConfigured,
  'unavailable': (s, d) => s.errcUnavailable,
  // A refused camera address says which rule it broke (`detail.reason`).
  'bad_address': (s, d) =>
      cameraReasonText(s, d['reason'] is String ? d['reason'] as String : null) ?? s.errcBadAddress,
  'unknown_video': (s, d) => s.errcUnknownVideo,
  'cloud_unreachable': (s, d) => s.liveWarnCloudUnreachable,
  // MAXCOM cloud and linked sites.
  'bad_claim': (s, d) => s.errcBadClaim,
  'worker_unreachable': (s, d) => s.errcWorkerUnreachable,
  'pending': (s, d) => s.errcClaimPending,
  'box_revoked': (s, d) => s.errcBoxRevoked,
  'entry_exists': (s, d) => s.errcEntryExists,
  'already_voided': (s, d) => s.errcAlreadyVoided,
  'opening_exists': (s, d) => s.errcOpeningExists,
  'opening_fund_fixed': (s, d) => s.errcOpeningFundFixed,
  // YouTube.
  'youtube_quota': (s, d) => s.errcYoutubeQuota,
  'youtube_reauthorise': (s, d) => s.errcYoutubeReauthorise,
  'youtube_not_configured': (s, d) => s.errcYoutubeNotConfigured,
  'youtube_forbidden': (s, d) => s.errcYoutubeForbidden,
  'youtube_not_found': (s, d) => s.errcYoutubeNotFound,
  'youtube_network': (s, d) => s.errcYoutubeNetwork,
  'catchup_off': (s, d) => s.errcCatchupOff,
  'unknown_live_video': (s, d) => s.errcUnknownLiveVideo,
  'kuliah_not_found': (s, d) => s.errcKuliahNotFound,
  'too_many_uploads': (s, d) => s.errcTooManyUploads,
  'upload_not_found': (s, d) => s.errcUploadNotFound,
  'video_mismatch': (s, d) => s.errcVideoMismatch,
  'upload_expired': (s, d) => s.errcUploadExpired,
  // MAXCOM Ops, the CLI and setup (the person may meet these on a phone).
  'surau_not_found': (s, d) => s.errcSurauNotFound,
  'surau_required': (s, d) => s.errcSurauRequired,
  'not_registered': (s, d) => s.errcNotRegistered,
  'code_mismatch': (s, d) => s.errcCodeMismatch,
  'no_worker': (s, d) => s.errcNoWorker,
  'worker': (s, d) => s.errcWorker,
  'not_linked': (s, d) => s.errcNotLinked,
  'already_linked': (s, d) => s.errcAlreadyLinked,
  'bad_box_name': (s, d) => s.errcBadBoxName,
  'not_support': (s, d) => s.errcNotSupport,
  'esolat_unreachable': (s, d) => s.errcEsolatUnreachable,
  'esolat_no_record': (s, d) =>
      s.errcEsolatNoRecord(_int(d, 'year'), '${d['zone'] ?? ''}'),
  // Prayer times.
  'csv_year_mismatch': (s, d) => s.errcCsvYearMismatch(
    _int(d, 'year'),
    '${d['from'] ?? ''}',
    '${d['to'] ?? ''}',
  ),
  'no_official_source': (s, d) => s.errcNoOfficialSource,
  'import_row_invalid': (s, d) =>
      '${s.impRow(_int(d, 'row'))}: ${importRowReason(s, '${d['field'] ?? 'row'}', '${d['reason'] ?? ''}') ?? s.ra2RowInvalid(rowFieldName(s, '${d['field'] ?? 'row'}'))}',
  'undo_blocked': (s, d) =>
      s.errcUndoBlocked('${d['date'] ?? ''}', '${d['by'] ?? ''}'),
  // Themes.
  'gone': (s, d) => s.errcThemeGone,
  'in_use': (s, d) => s.errcThemeInUse,
  'built_in': (s, d) => s.errcThemeBuiltIn,
};

/// What a failed request or write means in the person's words.
///
/// The app's own exceptions first; then a [BoxError] whose `code` is in
/// [kErrorCodeTexts] (filled from its `detail`); then 403 and 429; else the
/// server's own sentence, and [S.errorRequestFailed] when that is only the
/// generic marker.
String errorText(S s, Object error) {
  if (error is OfflineWriteRefused) return s.offlineWriteRefused;
  if (error is LiveOnly) return s.liveOnlyNeedsConnection;
  if (error is Uncertain) return s.errcUncertain;
  if (error is AssetTooLarge) return s.assetTooLarge;
  if (error is PeopleNeedsUpdate) return s.peopleNeedsUpdate;
  if (error is BadPhone) return s.phoneInvalid;
  if (error is BoxError) {
    final code = error.code;
    final known = code == null ? null : kErrorCodeTexts[code];
    if (error is SessionExpired) {
      // An ended session. A coded refusal that rode on a signed-in request
      // (a wrong PIN on "Tukar PIN") is that refusal, not an ended session.
      if (known == null || code == 'no_session' || code == 'session_expired') {
        return s.errorSessionExpired;
      }
    }
    if (known != null) return known(s, _detailFor(error));
    if (error.status == 403) return s.errorForbidden;
    if (error.status == 429) return s.errorTooMany;
    if (error.message == BoxError.genericMessage) return s.errorRequestFailed;
    return error.message;
  }
  if (error is BoxUnreachable) return s.errorBoxUnreachable;
  return s.errorUnknown;
}

/// The answer's detail, with the lockout minutes taken from `Retry-After`
/// when the box sent only that.
Map<String, dynamic> _detailFor(BoxError e) {
  final secs = e.retryAfterSec;
  if (secs == null || e.detail.containsKey('minutes')) return e.detail;
  final minutes = secs <= 0 ? 1 : (secs + 59) ~/ 60;
  return {...e.detail, 'minutes': minutes};
}
