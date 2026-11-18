/**
 * Live sources and the audio mix (plan 2026-11-16-live-external-source rev 4, sections 3.2, 4.2, 4.3a).
 *
 * The picture source (phone camera or external camera) brings its own sound with it as one unit; other sources are
 * ADDED and mixed in, each with its own volume. Pure rules only: no I/O, no device code. The box, the kiosk and the
 * app all read the same plan from here.
 */

import type { LiveSource } from './types.ts';

/** The picture source of a live. */
export type LiveVideoSource = 'phone' | 'external';

/** One sound source. `camera` is the external camera's own audio; the other two are added to it. */
export type AudioSourceId = 'camera' | 'deviceMic' | 'boxInput';
/** The sources that can be added (mixed in and aligned to the unit's own audio). */
export type AddedAudioId = 'deviceMic' | 'boxInput';

export const AUDIO_SOURCE_IDS: readonly AudioSourceId[] = ['camera', 'deviceMic', 'boxInput'];
export const ADDED_AUDIO_IDS: readonly AddedAudioId[] = ['deviceMic', 'boxInput'];

export interface AudioSourceMix { enabled: boolean; volume: number }
/** One entry per source: an enabled flag and a volume 0..100 (steps of 5). Silence is every volume at 0, never a dropped track. */
export type LiveAudioMix = Record<AudioSourceId, AudioSourceMix>;

/** Two microphones mixed more than this far apart double every word, so each added source is aligned within it. */
export const ALIGN_TARGET_MS = 20;

/** What the aligner reports per added source (plan 4.3a). */
export type AlignState = 'searching' | 'locked' | 'holding' | 'failed' | 'manual';
export const ALIGN_STATES: readonly AlignState[] = ['searching', 'locked', 'holding', 'failed', 'manual'];

/** Fallback offset (a camera with no audio track): 0 to 2000 ms in steps of 50. */
export const AV_OFFSET_MAX_MS = 2000;
export const AV_OFFSET_STEP_MS = 50;
export const AV_OFFSET_CHOICES: readonly number[] = Array.from({ length: AV_OFFSET_MAX_MS / AV_OFFSET_STEP_MS + 1 }, (_, i) => i * AV_OFFSET_STEP_MS);

export const VOLUME_STEP = 5;

/** What this device and box can offer right now. `runner` is the device that starts the live (default: the phone). */
export interface AudioCaps {
  /** The external camera has an audio track (from the last "Uji sambungan"). Ignored for the phone camera. */
  cameraHasAudio: boolean;
  /** The phone's or iPad's microphone is usable. */
  deviceMic: boolean;
  /** The box reports an audio input ("Mic-in pada kotak"). */
  boxInput: boolean;
  runner?: LiveSource;
}

/** Codes the app turns into the messages of plan 4.7. */
export type AudioNote =
  | 'camera_no_audio'
  | 'audio_all_muted'
  | 'camera_volume_hint'
  | 'device_mic_placement'
  | 'mic_in_not_in_phone_recording';

export interface AudioPlan {
  /** The audio the added sources are aligned to; never delayed. Null when the unit has no sound of its own. */
  reference: AudioSourceId | null;
  /** The sources mixed in, in the stable order deviceMic, boxInput. */
  added: AddedAudioId[];
  /** Where the final mix is made: on the starting device, or on the box combiner. */
  mixedOn: 'device' | 'box';
  /** `auto` = measured and corrected continuously; `manual` = the stored fallback offset; `none` = nothing to align. */
  align: 'auto' | 'manual' | 'none';
  /** No enabled source has a volume above 0: the live has no sound. */
  allMuted: boolean;
  notes: AudioNote[];
}

const clampVolume = (v: number): number => Math.min(100, Math.max(0, Math.round(v / VOLUME_STEP) * VOLUME_STEP));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function defaultAudioMix(video: LiveVideoSource): LiveAudioMix {
  return {
    camera: { enabled: video === 'external', volume: 100 },
    deviceMic: { enabled: video === 'phone', volume: 100 },
    boxInput: { enabled: false, volume: 100 },
  };
}

/**
 * A usable mix from whatever was stored or sent: bad parts fall back to the default, volumes are clamped to 0..100 and
 * rounded to steps of 5, sources this device or box does not have are switched off, and `camera.enabled` follows the
 * camera's audio track (the user silences the camera with volume 0, never by dropping it). Never throws.
 */
export function normaliseAudioMix(video: LiveVideoSource, mix: unknown, caps: AudioCaps): LiveAudioMix {
  const out = defaultAudioMix(video);
  const src = isObj(mix) ? mix : {};
  for (const id of AUDIO_SOURCE_IDS) {
    const e = src[id];
    if (!isObj(e)) continue;
    if (typeof e.enabled === 'boolean') out[id].enabled = e.enabled;
    if (typeof e.volume === 'number' && Number.isFinite(e.volume)) out[id].volume = clampVolume(e.volume);
  }
  // The camera's audio belongs to the external camera's picture: with the phone camera it does not exist.
  out.camera.enabled = video === 'external' && caps.cameraHasAudio;
  if (!caps.deviceMic) out.deviceMic.enabled = false;
  if (!caps.boxInput) out.boxInput.enabled = false;
  return out;
}

/** The plan every part of the system follows for a start request or an audio change. */
export function audioPlanOf(video: LiveVideoSource, mix: unknown, caps: AudioCaps): AudioPlan {
  const m = normaliseAudioMix(video, mix, caps);
  const runner = caps.runner ?? 'android';
  const notes: AudioNote[] = [];

  let reference: AudioSourceId | null = null;
  const added: AddedAudioId[] = [];
  if (video === 'external') {
    if (m.camera.enabled) reference = 'camera';
    for (const id of ADDED_AUDIO_IDS) if (m[id].enabled) added.push(id);
  } else {
    if (m.deviceMic.enabled) reference = 'deviceMic';
    if (m.boxInput.enabled) added.push('boxInput');
  }

  // The iPad cannot mix the camera picture with its microphone itself: the box does. Mic-in is always on the box.
  const mixedOn: AudioPlan['mixedOn'] = added.includes('boxInput') || (video === 'external' && runner === 'web') ? 'box' : 'device';
  const align: AudioPlan['align'] = added.length === 0 ? 'none' : reference === null ? 'manual' : 'auto';
  const audible = (Object.keys(m) as AudioSourceId[]).some((id) => m[id].enabled && m[id].volume > 0);

  if (video === 'external' && !caps.cameraHasAudio) notes.push('camera_no_audio');
  if (!audible) notes.push('audio_all_muted');
  if (video === 'external' && m.camera.enabled) notes.push('camera_volume_hint');
  if (m.deviceMic.enabled && m.deviceMic.volume > 0 && (video === 'phone' || added.includes('deviceMic'))) notes.push('device_mic_placement');
  if (video === 'phone' && added.includes('boxInput')) notes.push('mic_in_not_in_phone_recording');

  return { reference, added, mixedOn, align, allMuted: !audible, notes };
}
