// Non-destructive image adjustment, shared by the box, the app and the kiosk.
//
// An image field holds an `ImageRef`: either the legacy plain asset id (sha256 hex, meaning "as
// uploaded, no adjustment") or `{ asset, crop?, bg?, rotate?, square? }`. The original asset is
// never changed; the box renders sized derivatives from the adjustment when it is saved.

/** A rectangle in 0..1 of the image (after `rotate`): top-left corner and size. */
export interface ImageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `keep` as uploaded, `remove` makes the detected plain background transparent, `card` puts the picture on a rounded light plate. */
export type ImageBg = 'keep' | 'remove' | 'card';
export type ImageRotate = 0 | 90 | 180 | 270;

export interface AdjustedImage {
  /** sha256 asset id of the original upload. */
  asset: string;
  crop?: ImageRect;
  bg?: ImageBg;
  rotate?: ImageRotate;
  /** Logo only: the area used for the square icon (app icon, favicon, manifest). */
  square?: ImageRect;
}

export type ImageRef = string | AdjustedImage;

/** The shape each kind of picture is shown in. `aspect` is width / height of the frame. */
export interface ImageSlot {
  aspect: number | 'free';
  fit?: 'contain' | 'cover';
  mask?: 'circle';
  /** Largest derived picture (pixels). Fixed here: never taken from a request. */
  maxW: number;
  maxH: number;
}

export type ImageSlotKey =
  | 'logo'
  | 'logoSquare'
  | 'poster'
  | 'programKhas'
  | 'takwim'
  | 'penceramah'
  | 'petugas'
  | 'kitab'
  | 'background';

export const IMAGE_SLOTS: Readonly<Record<ImageSlotKey, ImageSlot>> = {
  /** Wide logo (natural shape) for the kiosk header, strip and app headers. */
  logo: { aspect: 'free', maxW: 1024, maxH: 192 },
  /** Square logo for app icons, favicon and manifest. */
  logoSquare: { aspect: 1, maxW: 512, maxH: 512 },
  poster: { aspect: 16 / 9, fit: 'contain', maxW: 1920, maxH: 1080 },
  programKhas: { aspect: 16 / 9, fit: 'contain', maxW: 1920, maxH: 1080 },
  takwim: { aspect: 16 / 9, fit: 'contain', maxW: 1920, maxH: 1080 },
  penceramah: { aspect: 1, mask: 'circle', maxW: 512, maxH: 512 },
  petugas: { aspect: 1, mask: 'circle', maxW: 512, maxH: 512 },
  kitab: { aspect: 2 / 3, maxW: 400, maxH: 600 },
  background: { aspect: 16 / 9, fit: 'cover', maxW: 1920, maxH: 1080 },
};

/** Image fields of the content kinds and the slot each one is shown in. */
export const CONTENT_IMAGE_FIELDS: Readonly<Record<string, Readonly<Record<string, ImageSlotKey>>>> = {
  penceramah: { photoAssetId: 'penceramah' },
  kitab: { coverAssetId: 'kitab' },
  poster: { assetId: 'poster' },
  programKhas: { assetId: 'programKhas' },
  takwim: { assetId: 'takwim' },
  petugas: { photoAssetId: 'petugas' },
};

/** Smallest crop side (1% of the picture): keeps a rendered crop from collapsing to nothing. */
export const MIN_CROP_SPAN = 0.01;
const EPS = 1e-9;
const ASSET_RE = /^[0-9a-f]{64}$/;
const ROTATIONS: readonly number[] = [0, 90, 180, 270];
const BGS: readonly string[] = ['keep', 'remove', 'card'];

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** True for the object form (anything but the legacy plain id). */
export const isAdjustedImage = (ref: ImageRef): ref is AdjustedImage => typeof ref !== 'string';

/** The original asset id of a reference. */
export const imageAssetId = (ref: ImageRef): string => (typeof ref === 'string' ? ref : ref.asset);

/** True when the reference carries any adjustment beyond the asset id. */
export function hasAdjustment(ref: ImageRef): boolean {
  if (typeof ref === 'string') return false;
  return ref.crop !== undefined || ref.bg !== undefined || ref.rotate !== undefined || ref.square !== undefined;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkRect(path: string, v: unknown, errors: string[]): ImageRect | undefined {
  if (!isPlain(v)) {
    errors.push(`${path} must be an object { x, y, w, h }`);
    return undefined;
  }
  let ok = true;
  for (const k of Object.keys(v)) {
    if (k !== 'x' && k !== 'y' && k !== 'w' && k !== 'h') {
      errors.push(`${path}.${k} is not a known field`);
      ok = false;
    }
  }
  const { x, y, w, h } = v;
  if (!num(x) || !num(y) || !num(w) || !num(h)) {
    errors.push(`${path} x, y, w and h must be finite numbers`);
    return undefined;
  }
  if (x < 0 || y < 0 || w < MIN_CROP_SPAN || h < MIN_CROP_SPAN || x + w > 1 + EPS || y + h > 1 + EPS) {
    errors.push(`${path} must lie inside the picture (x, y >= 0, w, h >= ${MIN_CROP_SPAN}, x + w <= 1, y + h <= 1)`);
    return undefined;
  }
  return ok ? { x, y, w, h } : undefined;
}

/**
 * Validates one image reference. Unknown keys are refused; numbers must be finite and the crop
 * must lie inside the picture (nothing is clamped silently). `slot` decides which keys are
 * allowed: `square` belongs to the logo only. Pushes errors and returns the clean value, or
 * undefined when invalid.
 */
export function validateImageRef(path: string, v: unknown, errors: string[], slot: ImageSlotKey): ImageRef | undefined {
  if (typeof v === 'string') {
    if (!ASSET_RE.test(v)) {
      errors.push(`${path} must be a sha256 asset id`);
      return undefined;
    }
    return v;
  }
  if (!isPlain(v)) {
    errors.push(`${path} must be a sha256 asset id or an image object`);
    return undefined;
  }
  const before = errors.length;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (k === 'square' && slot !== 'logo') {
      errors.push(`${path}.square is only for the logo`);
    } else if (!['asset', 'crop', 'bg', 'rotate', 'square'].includes(k)) {
      errors.push(`${path}.${k} is not a known field`);
    }
  }
  if (typeof v.asset !== 'string' || !ASSET_RE.test(v.asset)) errors.push(`${path}.asset must be a sha256 asset id`);
  else out.asset = v.asset;
  if (v.crop !== undefined) {
    const r = checkRect(`${path}.crop`, v.crop, errors);
    if (r) out.crop = r;
  }
  if (v.square !== undefined && slot === 'logo') {
    const r = checkRect(`${path}.square`, v.square, errors);
    if (r) out.square = r;
  }
  if (v.bg !== undefined) {
    if (typeof v.bg !== 'string' || !BGS.includes(v.bg)) errors.push(`${path}.bg must be one of ${BGS.join(', ')}`);
    else out.bg = v.bg;
  }
  if (v.rotate !== undefined) {
    if (typeof v.rotate !== 'number' || !ROTATIONS.includes(v.rotate)) errors.push(`${path}.rotate must be 0, 90, 180 or 270`);
    else out.rotate = v.rotate;
  }
  return errors.length === before ? (out as unknown as AdjustedImage) : undefined;
}
