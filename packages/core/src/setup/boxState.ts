/** Box state and the views the kiosk and the app read. Pure types plus two tiny helpers. */

export type BoxState = 'setup' | 'active' | 'recovery' | 'locked';
export type BoxStateReason = 'none' | 'no_admin' | 'db_damaged';

export interface BoxInfo {
  boxId: string;
  keyFp: string;
  pub: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  name: string;
  /** The numbered local name the box answers on its LAN (`box1-surau.local`), or null on a legacy root. `name` stays the display name. */
  localName?: string | null | undefined;
  state: BoxState;
  reason: BoxStateReason;
  linked: boolean;
  https: boolean;
  caSha256: string | null;
  serverTime: string;
  /** The MAX Kiosk Server version (YYYY.MM.N) of the box answering: stamped into its release at build time. */
  version: string;
  /** Several boxes in one surau: `follower` for a kotak pengikut. Absent on a box older than 2026.11.15 (read as `main`). */
  mode?: 'main' | 'follower';
}

export interface BoxStateView extends BoxInfo {
  qr?: { payload: string; expiresAt: string };
  /**
   * Recovery only, and only for the box's own screen: false when no recovery code was ever made (a box upgraded from
   * before codes existed), so the screen shows no QR and tells the surau to contact the installer.
   */
  recoveryCodeSet?: boolean;
  surauName: string | null;
  appDownloadUrl: string;
  /** Follower only: the master it shows, whether the master answers now, whole minutes since it last did, and whether the master speaks a newer screen contract than this box. */
  master?: { name: string };
  connected?: boolean;
  awayMinutes?: number;
  needsUpdate?: boolean;
}

export interface NetCheckView {
  interfaces: { name: string; address: string; up: boolean }[];
  https: { listening: boolean; port: number | null };
  linked: boolean;
  lastPull: string | null;
  lastPhoneSeenAt: string | null;
  probe?: { payload: string; expiresAt: string };
}

/** No home page to download the app from yet: the setup screen hides the line while this is empty. */
export const APP_DOWNLOAD_URL = '';

/** `MAXCOM 4F2A`: the name a box carries until the setup form renames it. */
export function defaultBoxName(boxId: string): string {
  return `MAXCOM ${boxId.slice(0, 4).toUpperCase()}`;
}
