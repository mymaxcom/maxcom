import type { DatabaseSync } from 'node:sqlite';
import { logChange } from '../../auth/users.ts';
import { LOCAL_SURAU_ID } from '../../tenant.ts';
import type { YoutubeLeg } from '../sessions.ts';

/**
 * The box's own YouTube leg for its lives (release 2026.11.13: the grant is held by the box, the cloud leg is not
 * used for a live any more). Each broadcast the box makes gets its `youtube/broadcast` change-log row, as the cloud
 * wrote one for the broadcasts it made: the catch-up's "replace the live video" and the clean-up check only accept a
 * video this surau broadcast. Ids only: the stream key is in the answer and nowhere else.
 */
export function withBroadcastLog(leg: YoutubeLeg, db: DatabaseSync): YoutubeLeg {
  return {
    signedIn: () => leg.signedIn(),
    status: () => leg.status(),
    complete: (broadcastId) => leg.complete(broadcastId),
    async createBroadcastFor(req) {
      const made = await leg.createBroadcastFor(req);
      try {
        // a retry that got the same broadcast does not log it twice
        const known = db.prepare("SELECT 1 AS x FROM change_log WHERE surau_id = ? AND entity = 'youtube/broadcast' AND entity_id = ?").get(LOCAL_SURAU_ID, made.broadcastId);
        if (known === undefined) logChange(db, 'system:live', 'youtube/broadcast', made.broadcastId, null, { sessionId: req.sessionId, broadcastId: made.broadcastId }, undefined, LOCAL_SURAU_ID);
      } catch {
        /* the history never stops a live */
      }
      return made;
    },
  };
}
