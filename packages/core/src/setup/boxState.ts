/** Box state and the views the kiosk and the app read. Pure types plus two tiny helpers. */

export type BoxState = 'setup' | 'active' | 'recovery' | 'locked';
export type BoxStateReason = 'none' | 'no_admin' | 'db_damaged';

export interface BoxInfo {
  boxId: string;
  keyFp: string;
  pub: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  name: string;
  state: BoxState;
  reason: BoxStateReason;
  linked: boolean;
  https: boolean;
  caSha256: string | null;
  serverTime: string;
  /** The MAX Kiosk Server version (YYYY.MM.N) of the box answering: stamped into its release at build time. */
  version: string;
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
