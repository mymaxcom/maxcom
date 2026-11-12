/** Sync facts of one write, shared by every store. Absent meta = a plain local write made now. */
export interface ChangeMeta {
  deviceId?: string;
  origin?: string;
  opId?: string;
  /** When the edit was made (device clock, clamped by the server). Default: now. */
  editedAt?: string;
  /** Default `<editedAt>|<deviceId or 'local'>`. */
  rev?: string;
  /** When the write reached this database from elsewhere. Default: null for a local write. */
  syncedAt?: string;
  /** Replication: skip the cross-item reference checks (the feed delivers items in order, assets come separately). */
  trusted?: boolean;
}

/** Revision of a write: the caller's, else `<editedAt>|<deviceId or 'local'>`. */
export function revOf(editedAt: string, meta?: ChangeMeta): string {
  return meta?.rev ?? `${editedAt}|${meta?.deviceId ?? 'local'}`;
}

/** Device id inside a rev (`<editedAt>|<deviceId>`); null when the rev has none. */
export function deviceOfRev(rev: string | null): string | null {
  if (rev === null) return null;
  const i = rev.lastIndexOf('|');
  return i < 0 ? null : rev.slice(i + 1);
}
