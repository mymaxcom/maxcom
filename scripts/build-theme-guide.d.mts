// Types for build-theme-guide.mjs (used by the box-server tests under strict tsc).
export const MS_SRC: string;
export const EN_SRC: string;
export const CSS_SRC: string;
export const SAMPLE_DIR: string;
export const SHOT_SIZE: string;
export const OUT_NAMES: { ms: string; en: string };
export const SLOT_NAMES: string[];
export function escapeHtml(s: unknown): string;
export interface GuideTables {
  screens: string; themes: string; regions: string; attributes: string; variables: string; arabic: string;
  files: string; refused: string; warnings: string; protected: string; sample: string;
}
export function guideTables(lang: 'ms' | 'en', opts?: { shots?: string }): GuideTables;
export function fillSlots(source: string, tables: GuideTables | Record<string, string>): string;
export function renderPage(lang: 'ms' | 'en', shotsDir: string): string;
export function pdfInfo(buf: Buffer): { pages: number };
export function makeShots(dir: string): void;
export function buildGuide(opts?: { shots?: string; pdf?: boolean; outDir?: string }): Promise<string[]>;
