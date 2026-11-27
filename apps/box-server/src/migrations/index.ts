import type { DatabaseSync } from 'node:sqlite';
import { migration as content002 } from './002-content.ts';
import { migration as auth003 } from './003-auth.ts';
import { migration as kioskCookies004 } from './004-kiosk-cookies.ts';
import { migration as posterTitles005 } from './005-poster-titles.ts';
import { migration as assetDerivatives006 } from './006-asset-derivatives.ts';
import { migration as derivativeFailures007 } from './007-asset-derivative-failures.ts';
import { migration as sync008 } from './008-sync.ts';
import { migration as workerOutbox009 } from './009-worker-outbox.ts';
import { migration as gateFixes010 } from './010-gate-fixes.ts';
import { migration as uploadReplace011 } from './011-upload-replace.ts';
import { migration as youtubePendingComplete012 } from './012-youtube-pending-complete.ts';
import { migration as boxCodes013 } from './013-box-codes.ts';
import { migration as hadisSources014 } from './014-hadis-sources.ts';
import { migration as prayerSources015 } from './015-prayer-sources.ts';
import { migration as finance016 } from './016-finance.ts';
import { migration as siteApprovals017 } from './017-site-approvals.ts';
import { migration as userFeedRepair018 } from './018-user-feed-repair.ts';
import { migration as multiSurau019 } from './019-multi-surau.ts';
import { migration as siteThemeSupport020 } from './020-site-theme-support.ts';
import { migration as cameraSecret021 } from './021-camera-secret.ts';
import { migration as peopleRelook022 } from './022-people-relook.ts';
import { migration as youtubeBox023 } from './023-youtube-box.ts';
import { migration as outboxCameraMark024 } from './024-outbox-camera-mark.ts';
import { migration as posterStretchKeep025 } from './025-poster-stretch-keep.ts';
import { migration as parkedSettings026 } from './026-parked-settings.ts';
import { migration as deletedPeoplePhone027 } from './027-deleted-people-phone.ts';
import { migration as boxNameFollowsSurau028 } from './028-box-name-follows-surau.ts';
import { migration as linkedBoxes029 } from './029-linked-boxes.ts';
import { migration as linkPeople030 } from './030-link-people.ts';
import { migration as liveSessions031 } from './031-live-sessions.ts';
import { migration as uploadSessionKey032 } from './032-upload-session-key.ts';
import { migration as surauSleep033 } from './033-surau-sleep.ts';
import { migration as liveSessionOutputs034 } from './034-live-session-outputs.ts';

export interface Migration {
  name: string;
  up(db: DatabaseSync): void;
}

/** Add new migrations here. They are applied in name order, each recorded by name. */
export const MIGRATIONS: readonly Migration[] = [content002, auth003, kioskCookies004, posterTitles005, assetDerivatives006, derivativeFailures007, sync008, workerOutbox009, gateFixes010, uploadReplace011, youtubePendingComplete012, boxCodes013, hadisSources014, prayerSources015, finance016, siteApprovals017, userFeedRepair018, multiSurau019, siteThemeSupport020, cameraSecret021, peopleRelook022, youtubeBox023, outboxCameraMark024, posterStretchKeep025, parkedSettings026, deletedPeoplePhone027, boxNameFollowsSurau028, linkedBoxes029, linkPeople030, liveSessions031, uploadSessionKey032, surauSleep033, liveSessionOutputs034];

/**
 * Apply every migration whose name is not yet recorded, in name order, each in its own
 * transaction. Returns the names applied by this call. A migration added later with a lower
 * name (e.g. 002 after 003 was applied) is still applied, because tracking is by name.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT)',
  );
  const applied = new Set<string>();
  for (const row of db.prepare('SELECT name FROM schema_migrations').all()) {
    if (typeof row.name === 'string') applied.add(row.name);
  }
  const ordered = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const done: string[] = [];
  for (const migration of ordered) {
    if (applied.has(migration.name)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    done.push(migration.name);
  }
  return done;
}
