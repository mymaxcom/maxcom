import type { KioskPengumuman } from '@surau/core';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../i18n.ts';
import { assetSrc } from '../assets.ts';
import { cardPictureFailed, markCardPictureFailed } from '../cardPictures.ts';
import type { CardProps } from '../ContentLayer.tsx';
import { pageAt, splitForPages, useFit } from '../paging.ts';

/**
 * How large a short notice may grow (the `--fit` it starts at) to fill the card before it steps down. Kept at a level
 * where a short notice at the default text size about fills the card, so Ubah suai "Saiz teks" still makes it larger or
 * smaller (a higher cap would let every size grow to the same box-filling size; scripts/setting-matrix.mjs checks this).
 */
export const PENGUMUMAN_FIT_MAX = 1.5;

/**
 * The optional picture of a notice ("pengumuman bergambar", 2026.11.11): `KioskPengumuman.pictureAssetId`, served at
 * /assets/<id> like every other picture. A box that does not send it yet changes nothing. A picture that failed to load
 * counts as none (see cardPictures.ts), so the card shows its text-only layout and the ticker stays.
 */
export function pengumumanPicture(p: KioskPengumuman | undefined): string | null {
  const id: unknown = p?.pictureAssetId;
  // The same rule as every picture (assetSrc): a sha256 asset id, else no picture (and the ticker stays).
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) && !cardPictureFailed(id) ? id : null;
}

/**
 * The text starts large enough to fill the card (a short notice grows, `PENGUMUMAN_FIT_MAX`) and `useFit` steps the
 * title and body down together; when the smallest step is not enough the body is split over pages (shown one after
 * the other for equal shares of the slot), so a long notice, or a larger text size, never loses a word. A notice with a
 * picture shows it whole (contained, never cropped) beside the text, as large as the card allows.
 */
export function PengumumanCard({ view, lang, content, itemId, startedAt, durationSeconds, onRendered }: CardProps) {
  const p = content.pengumuman.find((x) => x.id === itemId);
  // A picture that fails to load (missing, undecodable) turns the card into the text-only one, here and in Main's ticker rule.
  const [broken, setBroken] = useState(false);
  const pictureId = broken ? null : pengumumanPicture(p);
  const picture = assetSrc(pictureId);
  const { ref, fit, pages } = useFit<HTMLDivElement>(`${itemId ?? ''}|${p?.title ?? ''}|${p?.body ?? ''}|${picture ?? ''}`, { paged: true, max: PENGUMUMAN_FIT_MAX });
  // The picture's shape picks its share of the card: a tall picture takes a narrower column than a wide one.
  const [tall, setTall] = useState(false);
  // No item (removed or expired under the rotation): tell the content layer, so the band reads as empty and Main goes idle.
  const rendered = !!p;
  useEffect(() => {
    onRendered?.(rendered);
  }, [rendered, onRendered]);
  if (!p) return null;
  const chunks = pages > 1 ? splitForPages(p.body, pages) : [p.body];
  const n = chunks.length;
  const sub = n > 1 ? pageAt(view.now, startedAt, durationSeconds / n, n, view.tz) : 0;
  const text = [
    <span class="card__tag" key="tag">{t('pengumuman', lang)}</span>,
    n > 1 ? <span class="pengumuman__sub num" key="sub">{`${sub + 1} / ${n}`}</span> : null,
    <div class="pengumuman__text" ref={ref} style={`--fit:${fit}`} key="text">
      <h2 class="pengumuman__title">{p.title}</h2>
      <p class="pengumuman__body">{chunks[sub]}</p>
    </div>,
  ];
  // Text only: the round 2 card as it was (tag, page, text). With a picture: the picture, then the same text in a column.
  return (
    <article
      class={`card glass card--pengumuman${p.priority === 1 ? ' is-priority' : ''}${picture ? ` has-picture${tall ? ' is-tall' : ''}` : ''}`}
      data-card="pengumuman"
      data-item={p.id}
    >
      {picture ? (
        <>
          <div class="pengumuman__pic">
            <img
              src={picture}
              alt=""
              onLoad={(e) => {
                const img = e.currentTarget;
                setTall(img.naturalHeight > img.naturalWidth);
              }}
              onError={() => {
                if (pictureId !== null) markCardPictureFailed(pictureId);
                setBroken(true);
              }}
            />
          </div>
          <div class="pengumuman__main">{text}</div>
        </>
      ) : (
        text
      )}
    </article>
  );
}
