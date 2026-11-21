// What the kuliah card (live_notice_card.dart) needs from the box besides the
// words: the penceramah's photo. Every failure answers null (the card is then
// made without a photo); nothing is cached or logged here.

import 'dart:typed_data';

import '../../content/image_ref.dart' show ImageRef;
import '../shell/box_gateway.dart';

/// The photo of the penceramah named [speaker] (the kuliah's penceramah, as
/// the box's `/api/content/penceramah` lists them), or null: no name, no such
/// penceramah, no photo, or the box does not answer.
Future<Uint8List?> penceramahPhotoFor(BoxGateway? gateway, String? speaker) async {
  final name = speaker?.trim();
  if (gateway == null || name == null || name.isEmpty) return null;
  try {
    final body = (await gateway.get('/api/content/penceramah')).value;
    for (final i in (body['items'] as List? ?? const [])) {
      if (i is! Map || i['name'] is! String || (i['name'] as String).trim() != name) continue;
      final id = ImageRef.assetIdOf(i['photoAssetId']);
      if (id == null || id.isEmpty) return null;
      final bytes = await gateway.getBytes('/assets/$id');
      return bytes.isEmpty ? null : bytes;
    }
  } on Object {
    return null;
  }
  return null;
}
