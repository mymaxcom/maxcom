import type { DatabaseSync } from 'node:sqlite';
import { HADIS_MAX_SAVED, canonicalJson, dateOf, gradeOf, isContentKind, newId, providerItemId, tzOf, validateContent } from '@surau/core';
import type { ContentItemOf, ContentKind } from '@surau/core';
import { bumpVersion, getSettings } from '../settingsStore.ts';
import { serverRoleOf } from '../auth/users.ts';
import { surauHoldsAsset } from '../surau/storage.ts';
import { revOf } from '../sync/meta.ts';
import type { ChangeMeta } from '../sync/meta.ts';

export class ContentError extends Error {
  readonly errors: string[];
  readonly status: 400 | 404 | 409;
  /** A stable code the app maps to its own text; `errors[0]` stays the sentence for an older app. */
  readonly code: string | undefined;
  readonly detail: Record<string, unknown> | undefined;

  constructor(status: 400 | 404 | 409, errors: string[], code?: string, detail?: Record<string, unknown>) {
    super(errors.length > 0 ? errors.join('; ') : 'invalid content');
    this.name = 'ContentError';
    this.errors = errors;
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

type Plain = Record<string, unknown>;

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Fields that must point at an existing (non-deleted) item of another kind. */
const ITEM_REFS: Partial<Record<ContentKind, { field: string; kind: ContentKind }[]>> = {
  kuliah: [
    { field: 'penceramahId', kind: 'penceramah' },
    { field: 'kitabId', kind: 'kitab' },
  ],
  tugasan: [{ field: 'petugasId', kind: 'petugas' }],
};

/** Fields that must point at an existing asset, on any kind. */
const ASSET_FIELDS = ['assetId', 'photoAssetId', 'coverAssetId', 'pictureAssetId'] as const;

/** Reverse of ITEM_REFS: which kinds/fields reference a given kind. */
const REFERRERS: Partial<Record<ContentKind, { kind: ContentKind; field: string }[]>> = {
  penceramah: [{ kind: 'kuliah', field: 'penceramahId' }],
  kitab: [{ kind: 'kuliah', field: 'kitabId' }],
  petugas: [{ kind: 'tugasan', field: 'petugasId' }],
};

function assertKind(kind: string): asserts kind is ContentKind {
  if (!isContentKind(kind)) throw new ContentError(404, [`unknown content kind ${kind}`]);
}

function parseRow(json: unknown): Plain | null {
  if (typeof json !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Plain) : null;
  } catch {
    return null;
  }
}

export function listItems<K extends ContentKind>(
  db: DatabaseSync,
  kind: K,
  opts: { includeDeleted?: boolean } = {},
  surauId: string,
): ContentItemOf<K>[] {
  assertKind(kind);
  const rows = db
    .prepare(
      opts.includeDeleted === true
        ? 'SELECT json FROM content_items WHERE surau_id = ? AND kind = ? ORDER BY id'
        : 'SELECT json FROM content_items WHERE surau_id = ? AND kind = ? AND deleted_at IS NULL ORDER BY id',
    )
    .all(surauId, kind);
  const out: ContentItemOf<K>[] = [];
  for (const row of rows) {
    const parsed = parseRow(row.json);
    if (parsed !== null) out.push(parsed as unknown as ContentItemOf<K>);
  }
  return out;
}

function readRow(
  db: DatabaseSync,
  kind: ContentKind,
  id: string,
  surauId: string,
): { item: Plain; deleted: boolean } | undefined {
  const row = db.prepare('SELECT json, deleted_at FROM content_items WHERE surau_id = ? AND kind = ? AND id = ?').get(surauId, kind, id);
  if (row === undefined) return undefined;
  const item = parseRow(row.json);
  if (item === null) return undefined;
  return { item, deleted: row.deleted_at !== null && row.deleted_at !== undefined };
}

export function getItem<K extends ContentKind>(
  db: DatabaseSync,
  kind: K,
  id: string,
  surauId: string,
): ContentItemOf<K> | null {
  assertKind(kind);
  const found = readRow(db, kind, id, surauId);
  return found === undefined || found.deleted ? null : (found.item as unknown as ContentItemOf<K>);
}

function checkReferences(db: DatabaseSync, kind: ContentKind, item: Plain, surauId: string, stored?: Plain): void {
  const errors: string[] = [];
  for (const ref of ITEM_REFS[kind] ?? []) {
    const value = item[ref.field];
    if (typeof value !== 'string') continue;
    // a reference the saved item already holds is not asked again (the past kuliah of a deleted penceramah stays editable)
    if (stored !== undefined && stored[ref.field] === value) continue;
    if (getItem(db, ref.kind, value, surauId) === null) errors.push(`${ref.field} refers to a ${ref.kind} that does not exist`);
  }
  for (const field of ASSET_FIELDS) {
    const raw = item[field];
    // An image field is a plain asset id or an adjusted image { asset, ... }.
    const value = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? (raw as { asset?: unknown }).asset : undefined;
    if (typeof value !== 'string') continue;
    // On the cloud the asset must also be one this surau holds (`surau_assets`): another surau's hash is "missing".
    if (db.prepare('SELECT 1 AS ok FROM assets WHERE id = ?').get(value) === undefined) {
      errors.push(`${field} refers to an asset that does not exist`);
    } else if (!surauHoldsAsset(db, serverRoleOf(db), surauId, value)) {
      // the bytes are stored (another surau holds them) but this surau has not uploaded them
      errors.push(`${field} refers to an asset this surau does not hold`);
    }
  }
  if (errors.length > 0) {
    const onlyAssets = errors.every((e) => e.includes('asset'));
    throw new ContentError(409, errors, onlyAssets ? 'asset_missing' : undefined);
  }
}

/** The fields of a hadis that HadeethEnc serves; only the box's own add and accept-update paths may write them. */
export const HADIS_PROVIDER_FIELDS = ['textMs', 'textAr', 'intro', 'title', 'source', 'grade', 'ext'] as const;

const PROVIDER_ERROR = 'provider fields are read-only; use /api/hadis/add';
/** Row ids of saved HadeethEnc hadis (`providerItemId`); an item without `ext` may not take one. */
const PROVIDER_ID_PREFIX = 'hadeethenc-';

const canon = (v: unknown): string => (v === undefined ? '\u0000' : canonicalJson(v));

/**
 * Nothing may sit under a HadeethEnc badge that HadeethEnc did not serve. A hadis with `ext` (stored or
 * incoming) keeps every provider field equal to the stored live row: a phone, a stolen session or a device
 * op may change `shown` and `order` only. Replication (`meta.trusted`) and the box's own provider paths pass.
 */
function guardProviderFields(value: Plain, id: string, live: Plain | undefined, meta: ChangeMeta | undefined, providerWrite: boolean): void {
  if (providerWrite) return;
  if (meta?.trusted === true) {
    // Replication brings the provider text as served, but a provider hadis must still be what it says it is.
    const ext = value.ext as { provider?: string; id?: unknown; gradeAr?: unknown } | undefined;
    if (ext === undefined) return;
    const known = typeof ext.gradeAr === 'string' ? gradeOf(ext.gradeAr) : null;
    if (ext.provider !== 'hadeethenc' || typeof ext.id !== 'string' || id !== providerItemId('hadeethenc', ext.id) ||
        (value.grade ?? null) !== known) {
      throw new ContentError(400, [PROVIDER_ERROR]);
    }
    return;
  }
  if (value.ext === undefined) {
    // an own-list item carries no grade (the grade chip is a provider claim) and cannot take a provider row id
    if (value.grade !== undefined || id.startsWith(PROVIDER_ID_PREFIX)) throw new ContentError(400, [PROVIDER_ERROR]);
  }
  if (value.ext === undefined && live?.ext === undefined) return;
  for (const f of HADIS_PROVIDER_FIELDS) {
    if (canon(value[f]) !== canon(live?.[f])) throw new ContentError(400, [PROVIDER_ERROR]);
  }
}

/** Write an item; the caller owns the transaction. */
export function putItemIn<K extends ContentKind>(
  db: DatabaseSync,
  kind: K,
  item: unknown,
  actor: string,
  meta: ChangeMeta | undefined,
  surauId: string,
): { item: ContentItemOf<K>; created: boolean } {
  return writeItemIn(db, kind, item, actor, meta, false, surauId);
}

/**
 * A saved HadeethEnc hadis can be switched or moved with a body that holds only `shown` and/or `order` (and `id`):
 * the stored provider fields are put back under it, so a toggle queued before a text update still lands on the
 * NEW text. A body with any other key is not a patch and meets the lock as before.
 */
function hadisPatch(db: DatabaseSync, item: unknown, surauId: string): unknown {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
  const body = item as Plain;
  if (Object.keys(body).some((k) => k !== 'id' && k !== 'shown' && k !== 'order')) return item;
  const id = body.id;
  if (typeof id !== 'string') return item;
  const row = readRow(db, 'hadis', id, surauId);
  if (row === undefined || row.deleted || row.item.ext === undefined) return item;
  return {
    ...row.item,
    ...(body.shown !== undefined ? { shown: body.shown } : {}),
    ...(body.order !== undefined ? { order: body.order } : {}),
  };
}

function writeItemIn<K extends ContentKind>(
  db: DatabaseSync,
  kind: K,
  item: unknown,
  actor: string,
  meta: ChangeMeta | undefined,
  providerWrite: boolean,
  surauId: string,
): { item: ContentItemOf<K>; created: boolean } {
  assertKind(kind);
  const result = validateContent(kind, kind === 'hadis' && !providerWrite && meta?.trusted !== true ? hadisPatch(db, item, surauId) : item);
  if (!result.ok) throw new ContentError(400, result.errors);

  const value = { ...(result.value as Plain) };
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : newId();
  if (!SAFE_ID.test(id)) throw new ContentError(400, ['id must be 1-100 letters, digits, - or _']);
  const now = new Date().toISOString();
  const editedAt = meta?.editedAt ?? now;
  const rev = revOf(editedAt, meta);
  const origin = meta?.origin ?? 'local';
  value.id = id;
  value.updatedAt = editedAt;
  value.updatedBy = actor;

  const before = readRow(db, kind, id, surauId);
  if (kind === 'hadis') {
    guardProviderFields(value, id, before !== undefined && !before.deleted ? before.item : undefined, meta, providerWrite);
  }
  if (meta?.trusted !== true) checkReferences(db, kind, value, surauId, before !== undefined && !before.deleted ? (before.item as unknown as Plain) : undefined);
  // One cap on every way of saving an own hadis (the provider route and a replicated write keep their own rules):
  // a new hadis past the limit is refused, an edit of a saved one never is.
  if (kind === 'hadis' && !providerWrite && meta?.rev === undefined && meta?.trusted !== true && (before === undefined || before.deleted)
    && countLive(db, 'hadis', surauId) >= HADIS_MAX_SAVED) {
    throw new ContentError(409, ['Senarai hadis sudah penuh'], 'hadis_full');
  }
  const afterJson = JSON.stringify(value);
  db.prepare(
    `INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by, deleted_at, rev, edited_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(surau_id, kind, id) DO UPDATE SET
       json = excluded.json,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       deleted_at = NULL,
       rev = excluded.rev,
       edited_at = excluded.edited_at,
       origin = excluded.origin`,
  ).run(surauId, kind, id, afterJson, editedAt, actor, rev, editedAt, origin);
  const beforeLive = before !== undefined && !before.deleted ? before.item : undefined;
  db.prepare(
    `INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id, origin, op_id, edited_at, synced_at, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    surauId,
    now,
    actor,
    `content:${kind}`,
    id,
    beforeLive === undefined ? null : JSON.stringify(beforeLive),
    afterJson,
    meta?.deviceId ?? null,
    origin,
    meta?.opId ?? null,
    editedAt,
    meta?.syncedAt ?? null,
    rev,
  );
  bumpVersion(db, surauId);
  return { item: value as unknown as ContentItemOf<K>, created: beforeLive === undefined };
}

/**
 * The only way to create or change the provider fields of a hadis: the box's own `POST /api/hadis/add` and
 * `accept-update`. The item must be a HadeethEnc hadis whose id is `hadeethenc-<provider id>`; the caller owns
 * the transaction. The flag is local to this module: sync code and routes cannot set it.
 */
export function putProviderItemIn(
  db: DatabaseSync,
  item: unknown,
  actor: string,
  surauId: string,
): { item: ContentItemOf<'hadis'>; created: boolean } {
  const checked = validateContent('hadis', item);
  if (!checked.ok) throw new ContentError(400, checked.errors);
  const v = checked.value as Plain;
  const ext = v.ext as { provider?: string; id?: string } | undefined;
  if (ext === undefined || ext.provider !== 'hadeethenc' || typeof ext.id !== 'string' || v.id !== providerItemId('hadeethenc', ext.id) ||
    // a hadis without a known grade can only be kept hidden
    (v.grade === undefined && v.shown !== false)) {
    throw new ContentError(400, ['not a HadeethEnc hadis']);
  }
  return writeItemIn(db, 'hadis', item, actor, undefined, true, surauId);
}

export function putProviderItem(
  db: DatabaseSync,
  item: unknown,
  actor: string,
  surauId: string,
): { item: ContentItemOf<'hadis'>; created: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = putProviderItemIn(db, item, actor, surauId);
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Number of live (not deleted) items of a kind. */
export function countLive(db: DatabaseSync, kind: ContentKind, surauId: string): number {
  assertKind(kind);
  const row = db.prepare('SELECT COUNT(*) AS n FROM content_items WHERE surau_id = ? AND kind = ? AND deleted_at IS NULL').get(surauId, kind);
  return Number(row?.n ?? 0);
}

export function putItem<K extends ContentKind>(
  db: DatabaseSync,
  kind: K,
  item: unknown,
  actor: string,
  meta: ChangeMeta | undefined,
  surauId: string,
): { item: ContentItemOf<K>; created: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = putItemIn(db, kind, item, actor, meta, surauId);
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Soft-delete an item; the caller owns the transaction. False when there was nothing live to delete.
 * A synced delete (`meta.rev`) that the merge rule already accepted always leaves a tombstone: for an item
 * this side never saw it writes one (so a later, older put cannot bring the item back), and over an older
 * tombstone it moves the tombstone's stamp to the newer delete (so both orders end alike).
 */
export function deleteItemIn(
  db: DatabaseSync,
  kind: ContentKind,
  id: string,
  actor: string,
  meta: ChangeMeta | undefined,
  surauId: string,
): boolean {
  assertKind(kind);
  const now = new Date().toISOString();
  const editedAt = meta?.editedAt ?? now;
  const rev = revOf(editedAt, meta);
  const origin = meta?.origin ?? 'local';
  const before = readRow(db, kind, id, surauId);
  const synced = meta?.rev !== undefined;
  if (before !== undefined && before.deleted && !synced) return false;
  if (before === undefined && !synced) return false;
  if (before !== undefined && !before.deleted && meta?.trusted !== true) {
    // Only a referrer of today or later blocks (a speaker of last year can go); a past kuliah then shows no speaker.
    const today = dateOf(new Date(), tzOf(getSettings(db, surauId)));
    const blockers: string[] = [];
    let detail: Record<string, unknown> | undefined;
    for (const ref of REFERRERS[kind] ?? []) {
      const using = (listItems(db, ref.kind, {}, surauId) as unknown as Plain[])
        .filter((other) => other[ref.field] === id)
        .filter((other) => typeof other.date !== 'string' || other.date >= today);
      if (using.length === 0) continue;
      blockers.push(`${kind} is still used by ${using.length} ${ref.kind} item(s)`);
      detail ??= {
        kind,
        count: using.length,
        items: using
          .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
          .slice(0, 5)
          .map((o) => ({ id: String(o.id), date: String(o.date ?? ''), label: String(o.label ?? o.topic ?? o.role ?? '') })),
      };
    }
    if (blockers.length > 0) throw new ContentError(409, blockers, 'content_in_use', detail);
  }

  if (before === undefined) {
    if (!SAFE_ID.test(id)) throw new ContentError(400, ['id must be 1-100 letters, digits, - or _']);
    db.prepare(
      `INSERT INTO content_items (surau_id, kind, id, json, updated_at, updated_by, deleted_at, rev, edited_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(surau_id, kind, id) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by, rev = excluded.rev, edited_at = excluded.edited_at, origin = excluded.origin`,
    ).run(surauId, kind, id, JSON.stringify({ id }), editedAt, actor, editedAt, rev, editedAt, origin);
  } else {
    db.prepare(
      'UPDATE content_items SET deleted_at = ?, updated_at = ?, updated_by = ?, rev = ?, edited_at = ?, origin = ? WHERE surau_id = ? AND kind = ? AND id = ?',
    ).run(editedAt, editedAt, actor, rev, editedAt, origin, surauId, kind, id);
  }
  db.prepare(
    `INSERT INTO change_log (surau_id, at, actor, entity, entity_id, before_json, after_json, device_id, origin, op_id, edited_at, synced_at, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    surauId,
    now,
    actor,
    `content:${kind}`,
    id,
    before === undefined || before.deleted ? null : JSON.stringify(before.item),
    null,
    meta?.deviceId ?? null,
    origin,
    meta?.opId ?? null,
    editedAt,
    meta?.syncedAt ?? null,
    rev,
  );
  bumpVersion(db, surauId);
  return true;
}

export function deleteItem(
  db: DatabaseSync,
  kind: ContentKind,
  id: string,
  actor: string,
  meta: ChangeMeta | undefined,
  surauId: string,
): boolean {
  assertKind(kind);
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = deleteItemIn(db, kind, id, actor, meta, surauId);
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
