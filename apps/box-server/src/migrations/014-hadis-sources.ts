import type { DatabaseSync } from 'node:sqlite';

export const migration = { name: '014-hadis-sources', up };

/**
 * Plan 14. Box-local tables for what the box learns from HadeethEnc: the category tree, a catalog of every
 * Malay hadis (searched locally), the crawl state and the pending text updates of saved hadis. They are never
 * in the sync feed (like `islamic_cache`); a hadis the surau saved is an ordinary `content_items` row.
 * The `surau_id` default follows every other table so the multi-surau sweep stays one change.
 */
function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE hadis_categories (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      provider TEXT NOT NULL,
      id TEXT NOT NULL,
      parent_id TEXT,
      title_en TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (provider, id)
    );

    CREATE TABLE hadis_catalog (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      provider TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      text_ms TEXT NOT NULL,
      intro_ms TEXT,
      text_ar TEXT NOT NULL,
      intro_ar TEXT,
      attribution_ar TEXT NOT NULL,
      grade_ar TEXT NOT NULL,
      categories_json TEXT NOT NULL,
      search_norm TEXT NOT NULL,
      title_norm TEXT NOT NULL DEFAULT '',
      digest TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (provider, id)
    );
    CREATE INDEX idx_hadis_catalog_fetched ON hadis_catalog (provider, fetched_at);
    CREATE INDEX idx_hadis_catalog_num ON hadis_catalog (provider, CAST(id AS INTEGER));

    -- which categories list a hadith: a category page and its sub-categories are read by index, a page at a time
    CREATE TABLE hadis_catalog_cat (
      provider TEXT NOT NULL,
      category_id TEXT NOT NULL,
      hadith_id TEXT NOT NULL,
      PRIMARY KEY (provider, category_id, hadith_id)
    );
    CREATE INDEX idx_hadis_catalog_cat_hadith ON hadis_catalog_cat (provider, hadith_id);

    CREATE TABLE hadis_catalog_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE hadis_source_updates (
      surau_id TEXT NOT NULL DEFAULT 'sdm',
      item_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      new_json TEXT NOT NULL,
      found_at TEXT NOT NULL
    );
  `);
}
