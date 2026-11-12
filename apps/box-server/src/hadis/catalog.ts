import type { DatabaseSync } from 'node:sqlite';
import { hadisCategoryMs } from '@surau/core';
import type { HeCategory, HeHadith } from './hadeethenc.ts';

/** The box-local HadeethEnc catalog (never synced): categories, hadis texts for local search, crawl state. */

const PROVIDER = 'hadeethenc';

/** NFKD, no combining marks, lower-case, punctuation to space, single spaces. Shared by indexing and queries. */
export function normalise(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inTx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function stateGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM hadis_catalog_state WHERE key = ?').get(key);
  return typeof row?.value === 'string' ? row.value : null;
}

export function stateSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO hadis_catalog_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function stateDelete(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM hadis_catalog_state WHERE key = ?').run(key);
}

/** Replaces the whole category tree with `rows`. */
export function upsertCategories(db: DatabaseSync, rows: readonly HeCategory[], fetchedAt: string): void {
  inTx(db, () => {
    db.prepare('DELETE FROM hadis_categories WHERE provider = ?').run(PROVIDER);
    const ins = db.prepare(
      'INSERT INTO hadis_categories (provider, id, parent_id, title_en, count, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) ins.run(PROVIDER, r.id, r.parentId, r.titleEn, r.count, fetchedAt);
  });
}

export function listCategories(db: DatabaseSync): (HeCategory & { titleMs: string })[] {
  const rows = db
    .prepare('SELECT id, parent_id, title_en, count FROM hadis_categories WHERE provider = ? ORDER BY CAST(id AS INTEGER)')
    .all(PROVIDER);
  return rows.map((r) => {
    const id = String(r.id);
    const titleEn = String(r.title_en);
    return {
      id,
      parentId: typeof r.parent_id === 'string' ? r.parent_id : null,
      titleEn,
      count: Number(r.count),
      titleMs: hadisCategoryMs(id) ?? titleEn,
    };
  });
}

/** The category's own id plus every descendant. Unknown ids give just themselves. */
export function descendantIds(db: DatabaseSync, categoryId: string): string[] {
  const rows = db.prepare('SELECT id, parent_id FROM hadis_categories WHERE provider = ?').all(PROVIDER);
  const kids = new Map<string, string[]>();
  for (const r of rows) {
    if (typeof r.parent_id !== 'string') continue;
    const list = kids.get(r.parent_id) ?? [];
    list.push(String(r.id));
    kids.set(r.parent_id, list);
  }
  const out = [categoryId];
  for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i]!) ?? []) if (!out.includes(k)) out.push(k);
  return out;
}

/** Ids of the categories that have no child: the ones that list hadis. */
export function leafCategoryIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT c.id FROM hadis_categories c WHERE c.provider = ?
       AND NOT EXISTS (SELECT 1 FROM hadis_categories k WHERE k.provider = c.provider AND k.parent_id = c.id)
       ORDER BY CAST(c.id AS INTEGER)`,
    )
    .all(PROVIDER);
  return rows.map((r) => String(r.id));
}

/** Longest values the catalog keeps; a hadith over one is left out (the catalog is a convenience). */
export const CATALOG_MAX = { textAr: 8000, title: 300, attributionAr: 200 } as const;

/** A hadith the catalog refuses because a field is over its cap. Deterministic: asking again gives the same text. */
export class CatalogCapError extends Error {
  constructor(field: string) {
    super(`catalog: ${field} too long`);
    this.name = 'CatalogCapError';
  }
}

export function upsertHadith(db: DatabaseSync, h: HeHadith, fetchedAt: string): void {
  for (const f of ['textAr', 'title', 'attributionAr'] as const) if (h[f].length > CATALOG_MAX[f]) throw new CatalogCapError(f);
  inTx(db, () => {
    db.prepare(
      `INSERT INTO hadis_catalog
         (provider, id, title, text_ms, intro_ms, text_ar, intro_ar, attribution_ar, grade_ar, categories_json, search_norm, title_norm, digest, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, id) DO UPDATE SET
         title = excluded.title, text_ms = excluded.text_ms, intro_ms = excluded.intro_ms, text_ar = excluded.text_ar,
         intro_ar = excluded.intro_ar, attribution_ar = excluded.attribution_ar, grade_ar = excluded.grade_ar,
         categories_json = excluded.categories_json, search_norm = excluded.search_norm, title_norm = excluded.title_norm,
         digest = excluded.digest, fetched_at = excluded.fetched_at`,
    ).run(
      PROVIDER, h.id, h.title, h.textMs, h.introMs, h.textAr, h.introAr, h.attributionAr, h.gradeAr,
      JSON.stringify(h.categories), normalise(`${h.title} ${h.textMs}`), normalise(h.title), h.digest, fetchedAt,
    );
    db.prepare('DELETE FROM hadis_catalog_cat WHERE provider = ? AND hadith_id = ?').run(PROVIDER, h.id);
    const link = db.prepare('INSERT OR IGNORE INTO hadis_catalog_cat (provider, category_id, hadith_id) VALUES (?, ?, ?)');
    for (const c of h.categories) link.run(PROVIDER, c, h.id);
  });
}

type Row = Record<string, unknown>;

function toHadith(r: Row): HeHadith {
  let categories: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.categories_json));
    if (Array.isArray(parsed)) categories = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // keep []
  }
  return {
    id: String(r.id),
    title: String(r.title),
    textMs: String(r.text_ms),
    introMs: typeof r.intro_ms === 'string' ? r.intro_ms : null,
    textAr: String(r.text_ar),
    introAr: typeof r.intro_ar === 'string' ? r.intro_ar : null,
    attributionAr: String(r.attribution_ar),
    gradeAr: String(r.grade_ar),
    categories,
    digest: String(r.digest),
  };
}

export function getHadith(db: DatabaseSync, id: string): HeHadith | null {
  const row = db.prepare('SELECT * FROM hadis_catalog WHERE provider = ? AND id = ?').get(PROVIDER, id);
  return row ? toHadith(row) : null;
}

/** Catalog ids with the time they were fetched. */
export function catalogIndex(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of db.prepare('SELECT id, fetched_at FROM hadis_catalog WHERE provider = ?').all(PROVIDER)) {
    out.set(String(r.id), String(r.fetched_at));
  }
  return out;
}

/** Hadis in the category or any descendant, in id order; one page is read from the index, never the whole catalog. */
export function itemsInCategory(
  db: DatabaseSync, categoryId: string, page: number, perPage: number,
): { items: HeHadith[]; total: number } {
  const wanted = descendantIds(db, categoryId);
  const marks = wanted.map(() => '?').join(',');
  const inCategory = `SELECT hadith_id FROM hadis_catalog_cat WHERE provider = ? AND category_id IN (${marks})`;
  const total = Number(
    db.prepare(`SELECT COUNT(DISTINCT hadith_id) AS n FROM hadis_catalog_cat WHERE provider = ? AND category_id IN (${marks})`)
      .get(PROVIDER, ...wanted)?.n ?? 0,
  );
  const start = (Math.max(1, page) - 1) * perPage;
  const rows = db
    .prepare(
      `SELECT * FROM hadis_catalog WHERE provider = ? AND id IN (${inCategory}) ORDER BY CAST(id AS INTEGER) LIMIT ? OFFSET ?`,
    )
    .all(PROVIDER, PROVIDER, ...wanted, perPage, start);
  return { items: rows.map(toHadith), total };
}

/** `LIKE` over the normalised title and text; title hits first, then id order. Reads at most `limit` rows. Never logs the query. */
export function search(db: DatabaseSync, q: string, limit = 50): HeHadith[] {
  const needle = normalise(q);
  if (needle === '') return [];
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM hadis_catalog WHERE provider = ? AND search_norm LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN title_norm LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, CAST(id AS INTEGER) LIMIT ?`,
    )
    .all(PROVIDER, like, like, Math.max(0, limit));
  return rows.map(toHadith);
}

export function catalogStats(db: DatabaseSync): { entries: number; categories: number; fetchedAt: string | null } {
  const e = db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS t FROM hadis_catalog WHERE provider = ?').get(PROVIDER);
  const c = db.prepare('SELECT COUNT(*) AS n FROM hadis_categories WHERE provider = ?').get(PROVIDER);
  return { entries: Number(e?.n ?? 0), categories: Number(c?.n ?? 0), fetchedAt: typeof e?.t === 'string' ? e.t : null };
}
