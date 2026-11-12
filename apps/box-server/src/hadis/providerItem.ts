import { HADIS_GRADES, attributionOf, gradeOf, providerItemId } from '@surau/core';
import type { HadisGrade } from '@surau/core';
import type { HeHadith } from './hadeethenc.ts';

/** Turns what HadeethEnc served into a `hadis` content item. The only place that decides what a provider item says. */

/** The longest text MAXCOM keeps (the content schema's limit). */
export const MAX_HADIS_TEXT = 2000;
const MAX_INTRO = 400;
const MAX_TITLE = 300;
/** The content schema's limits for `ext.attributionAr` and `ext.gradeAr`. */
const MAX_ATTRIBUTION = 200;
const MAX_GRADE = 60;

export type ProviderBuild =
  | { ok: true; item: Record<string, unknown>; grade: HadisGrade | null; blocked: boolean }
  | { ok: false; error: 'too_long' | 'field_too_long' };

/** The opening sentence, only when it really is the start of the text and fits its field. */
function introOf(h: Pick<HeHadith, 'introMs' | 'textMs'>): string | undefined {
  const intro = h.introMs?.trim();
  return intro && intro.length <= MAX_INTRO && h.textMs.startsWith(intro) ? intro : undefined;
}

/** True when a grade may be saved at all: known, and not one of the two locked off (Dhaif, Palsu). */
export function gradeSavable(grade: HadisGrade | null): boolean {
  return grade !== null && HADIS_GRADES.find((g) => g.key === grade)?.allowed === true;
}

/**
 * The item for `h`. `blocked` is true when the grade is dhaif, maudhu or not a known text: the caller refuses
 * the add, or saves the update hidden. `keep` carries `order` and `shown` of an item that already exists.
 */
export function buildProviderItem(
  h: HeHadith, fetchedAt: string, keep?: { order?: number; shown?: boolean },
): ProviderBuild {
  if (h.textMs.length > MAX_HADIS_TEXT || h.textAr.length > MAX_HADIS_TEXT) return { ok: false, error: 'too_long' };
  if (h.attributionAr.length > MAX_ATTRIBUTION || h.gradeAr.length > MAX_GRADE) return { ok: false, error: 'field_too_long' };
  const grade = gradeOf(h.gradeAr);
  const blocked = !gradeSavable(grade);
  const attribution = attributionOf(h.attributionAr);
  const item: Record<string, unknown> = {
    id: providerItemId('hadeethenc', h.id),
    textMs: h.textMs,
    textAr: h.textAr,
    intro: introOf(h),
    title: h.title.slice(0, MAX_TITLE),
    source: attribution?.short ?? h.attributionAr,
    grade: grade ?? undefined,
    shown: blocked ? false : keep?.shown ?? true,
    ...(keep?.order !== undefined ? { order: keep.order } : {}),
    ext: {
      provider: 'hadeethenc',
      id: h.id,
      attributionAr: h.attributionAr,
      gradeAr: h.gradeAr,
      categories: h.categories.slice(0, 20),
      fetchedAt,
      digest: h.digest,
    },
  };
  return { ok: true, item, grade, blocked };
}
