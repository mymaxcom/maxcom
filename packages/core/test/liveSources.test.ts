import { describe, expect, it } from 'vitest';
import {
  ALIGN_TARGET_MS,
  AUDIO_SOURCE_IDS,
  AV_OFFSET_CHOICES,
  audioPlanOf,
  defaultAudioMix,
  normaliseAudioMix,
  type AudioCaps,
  type LiveAudioMix,
} from '../src/live/sources.ts';

const CAPS: AudioCaps = { cameraHasAudio: true, deviceMic: true, boxInput: true, runner: 'android' };
const caps = (o: Partial<AudioCaps> = {}): AudioCaps => ({ ...CAPS, ...o });
const mixOf = (o: Partial<Record<keyof LiveAudioMix, Partial<LiveAudioMix['camera']>>>): LiveAudioMix => {
  const base = defaultAudioMix('external');
  return {
    camera: { ...base.camera, ...o.camera },
    deviceMic: { ...base.deviceMic, ...o.deviceMic },
    boxInput: { ...base.boxInput, ...o.boxInput },
  };
};

describe('constants', () => {
  it('aligns within 20 ms', () => {
    expect(ALIGN_TARGET_MS).toBe(20);
  });
  it('lists the three sources in a stable order', () => {
    expect([...AUDIO_SOURCE_IDS]).toEqual(['camera', 'deviceMic', 'boxInput']);
  });
  it('offers the fallback offset 0..2000 ms in steps of 50', () => {
    expect(AV_OFFSET_CHOICES[0]).toBe(0);
    expect(AV_OFFSET_CHOICES[AV_OFFSET_CHOICES.length - 1]).toBe(2000);
    expect(AV_OFFSET_CHOICES).toHaveLength(41);
    expect(AV_OFFSET_CHOICES.every((v, i) => v === i * 50)).toBe(true);
  });
});

describe('defaultAudioMix', () => {
  it('with the external camera: camera audio on at 100, nothing else added', () => {
    expect(defaultAudioMix('external')).toEqual({
      camera: { enabled: true, volume: 100 },
      deviceMic: { enabled: false, volume: 100 },
      boxInput: { enabled: false, volume: 100 },
    });
  });
  it('with the phone camera: its own microphone on at 100 (today\'s flow), camera audio not applicable', () => {
    expect(defaultAudioMix('phone')).toEqual({
      camera: { enabled: false, volume: 100 },
      deviceMic: { enabled: true, volume: 100 },
      boxInput: { enabled: false, volume: 100 },
    });
  });
  it('returns a fresh object each time', () => {
    const a = defaultAudioMix('phone');
    a.deviceMic.volume = 5;
    expect(defaultAudioMix('phone').deviceMic.volume).toBe(100);
  });
});

describe('normaliseAudioMix', () => {
  it('keeps a good mix as it is', () => {
    const m = mixOf({ camera: { volume: 40 }, deviceMic: { enabled: true, volume: 80 } });
    expect(normaliseAudioMix('external', m, CAPS)).toEqual(m);
  });
  it('falls back to the default for missing, null or garbage input', () => {
    for (const bad of [undefined, null, 'x', 7, [], {}]) {
      expect(normaliseAudioMix('external', bad, CAPS)).toEqual(defaultAudioMix('external'));
    }
  });
  it('clamps volumes to 0..100 and rounds them to steps of 5', () => {
    const m = normaliseAudioMix('external', mixOf({ camera: { volume: 250 }, deviceMic: { enabled: true, volume: -3 }, boxInput: { enabled: true, volume: 47 } }), CAPS);
    expect(m.camera.volume).toBe(100);
    expect(m.deviceMic.volume).toBe(0);
    expect(m.boxInput.volume).toBe(45);
  });
  it('ignores a volume that is not a finite number and an enabled flag that is not a boolean', () => {
    const raw = { camera: { enabled: 'yes', volume: Number.NaN }, deviceMic: { enabled: true, volume: '70' }, boxInput: { enabled: 1, volume: Infinity } };
    const m = normaliseAudioMix('external', raw, CAPS);
    expect(m.camera).toEqual({ enabled: true, volume: 100 });
    expect(m.deviceMic).toEqual({ enabled: true, volume: 100 });
    expect(m.boxInput).toEqual({ enabled: false, volume: 100 });
  });
  it('drops a source this device or box does not have, keeping the rest', () => {
    const m = normaliseAudioMix('external', mixOf({ deviceMic: { enabled: true }, boxInput: { enabled: true } }), caps({ boxInput: false }));
    expect(m.boxInput.enabled).toBe(false);
    expect(m.deviceMic.enabled).toBe(true);
    const n = normaliseAudioMix('phone', defaultAudioMix('phone'), caps({ deviceMic: false }));
    expect(n.deviceMic.enabled).toBe(false);
  });
  it('forces the camera audio off when the camera has no audio track, and keeps its volume', () => {
    const m = normaliseAudioMix('external', mixOf({ camera: { enabled: true, volume: 60 } }), caps({ cameraHasAudio: false }));
    expect(m.camera).toEqual({ enabled: false, volume: 60 });
  });
  it('forces the camera audio on when the camera has an audio track: the user silences it with volume 0, never by dropping the track', () => {
    const m = normaliseAudioMix('external', mixOf({ camera: { enabled: false, volume: 0 } }), CAPS);
    expect(m.camera).toEqual({ enabled: true, volume: 0 });
  });
  it('never uses camera audio with the phone camera', () => {
    const m = normaliseAudioMix('phone', mixOf({ camera: { enabled: true, volume: 90 } }), CAPS);
    expect(m.camera.enabled).toBe(false);
  });
  it('does not mutate its input', () => {
    const m = mixOf({ camera: { volume: 47 } });
    const copy = JSON.parse(JSON.stringify(m));
    normaliseAudioMix('external', m, CAPS);
    expect(m).toEqual(copy);
  });
  it('is idempotent', () => {
    const once = normaliseAudioMix('external', mixOf({ camera: { volume: 47 }, deviceMic: { enabled: true, volume: 999 } }), CAPS);
    expect(normaliseAudioMix('external', once, CAPS)).toEqual(once);
  });
});

describe('audioPlanOf: external camera', () => {
  it('camera alone: camera is the reference, nothing to align, mixed on the device', () => {
    const p = audioPlanOf('external', defaultAudioMix('external'), CAPS);
    expect(p).toMatchObject({ reference: 'camera', added: [], mixedOn: 'device', align: 'none', allMuted: false });
  });
  it('camera alone on the iPad / web path: the box carries it', () => {
    const p = audioPlanOf('external', defaultAudioMix('external'), caps({ runner: 'web' }));
    expect(p).toMatchObject({ reference: 'camera', added: [], mixedOn: 'box', align: 'none' });
  });
  it('camera + device microphone on the phone: aligned automatically, mixed on the phone', () => {
    const p = audioPlanOf('external', mixOf({ deviceMic: { enabled: true } }), CAPS);
    expect(p).toMatchObject({ reference: 'camera', added: ['deviceMic'], mixedOn: 'device', align: 'auto', allMuted: false });
  });
  it('camera + device microphone on the iPad: mixed on the box', () => {
    const p = audioPlanOf('external', mixOf({ deviceMic: { enabled: true } }), caps({ runner: 'web' }));
    expect(p).toMatchObject({ reference: 'camera', added: ['deviceMic'], mixedOn: 'box', align: 'auto' });
  });
  it('camera + Mic-in pada kotak: mixed on the box', () => {
    const p = audioPlanOf('external', mixOf({ boxInput: { enabled: true } }), CAPS);
    expect(p).toMatchObject({ reference: 'camera', added: ['boxInput'], mixedOn: 'box', align: 'auto' });
  });
  it('both added: each is aligned, mixed on the box, in a stable order', () => {
    const p = audioPlanOf('external', mixOf({ boxInput: { enabled: true }, deviceMic: { enabled: true } }), CAPS);
    expect(p).toMatchObject({ reference: 'camera', added: ['deviceMic', 'boxInput'], mixedOn: 'box', align: 'auto' });
  });
  it('camera volume 0 ("mic only"): the camera stays the reference in the same graph, the microphone is added', () => {
    const p = audioPlanOf('external', mixOf({ camera: { volume: 0 }, deviceMic: { enabled: true } }), CAPS);
    expect(p).toMatchObject({ reference: 'camera', added: ['deviceMic'], align: 'auto', allMuted: false });
  });
  it('camera without audio and a source added: that source alone with the manual offset', () => {
    const p = audioPlanOf('external', mixOf({ deviceMic: { enabled: true } }), caps({ cameraHasAudio: false }));
    expect(p).toMatchObject({ reference: null, added: ['deviceMic'], align: 'manual', allMuted: false });
    expect(p.notes).toContain('camera_no_audio');
  });
  it('camera without audio and Mic-in added: manual, mixed on the box', () => {
    const p = audioPlanOf('external', mixOf({ boxInput: { enabled: true } }), caps({ cameraHasAudio: false }));
    expect(p).toMatchObject({ reference: null, added: ['boxInput'], mixedOn: 'box', align: 'manual' });
  });
  it('camera without audio and nothing added: no sound, says so', () => {
    const p = audioPlanOf('external', defaultAudioMix('external'), caps({ cameraHasAudio: false }));
    expect(p).toMatchObject({ reference: null, added: [], align: 'none', allMuted: true });
    expect(p.notes).toContain('camera_no_audio');
  });
  it('every volume at 0: warns that the broadcast has no sound', () => {
    const p = audioPlanOf('external', mixOf({ camera: { volume: 0 }, deviceMic: { enabled: true, volume: 0 } }), CAPS);
    expect(p.allMuted).toBe(true);
    expect(p.notes).toContain('audio_all_muted');
  });
  it('an added source at 0 does not count as audible but the camera still is', () => {
    const p = audioPlanOf('external', mixOf({ deviceMic: { enabled: true, volume: 0 } }), CAPS);
    expect(p.allMuted).toBe(false);
    expect(p.notes).not.toContain('audio_all_muted');
  });
  it('drops an unavailable source from the plan', () => {
    const p = audioPlanOf('external', mixOf({ boxInput: { enabled: true } }), caps({ boxInput: false }));
    expect(p.added).toEqual([]);
    expect(p.align).toBe('none');
  });
  it('hints that the camera microphone is far and noisy while it is in the mix', () => {
    expect(audioPlanOf('external', defaultAudioMix('external'), CAPS).notes).toContain('camera_volume_hint');
    expect(audioPlanOf('external', defaultAudioMix('external'), caps({ cameraHasAudio: false })).notes).not.toContain('camera_volume_hint');
  });
  it('asks to keep the phone near the speaker while the device microphone is audible', () => {
    expect(audioPlanOf('external', mixOf({ deviceMic: { enabled: true } }), CAPS).notes).toContain('device_mic_placement');
    expect(audioPlanOf('external', mixOf({ deviceMic: { enabled: true, volume: 0 } }), CAPS).notes).not.toContain('device_mic_placement');
  });
});

describe('audioPlanOf: phone camera', () => {
  it('own microphone: today\'s flow, the microphone is the reference, nothing to align', () => {
    const p = audioPlanOf('phone', defaultAudioMix('phone'), CAPS);
    expect(p).toMatchObject({ reference: 'deviceMic', added: [], mixedOn: 'device', align: 'none', allMuted: false });
  });
  it('muted (today\'s mute): no sound', () => {
    const p = audioPlanOf('phone', { ...defaultAudioMix('phone'), deviceMic: { enabled: false, volume: 100 } }, CAPS);
    expect(p).toMatchObject({ reference: null, added: [], align: 'none', allMuted: true });
  });
  it('phone camera + Mic-in: the phone microphone is the reference, Mic-in aligned on the box, with a recording notice', () => {
    const mix = { ...defaultAudioMix('phone'), boxInput: { enabled: true, volume: 100 } };
    const p = audioPlanOf('phone', mix, CAPS);
    expect(p).toMatchObject({ reference: 'deviceMic', added: ['boxInput'], mixedOn: 'box', align: 'auto', allMuted: false });
    expect(p.notes).toContain('mic_in_not_in_phone_recording');
  });
  it('phone camera + Mic-in on the iPad behaves the same', () => {
    const mix = { ...defaultAudioMix('phone'), boxInput: { enabled: true, volume: 100 } };
    const p = audioPlanOf('phone', mix, caps({ runner: 'web' }));
    expect(p).toMatchObject({ reference: 'deviceMic', added: ['boxInput'], mixedOn: 'box', align: 'auto' });
  });
  it('phone camera + Mic-in with the phone microphone muted: Mic-in alone, manual', () => {
    const mix = { camera: { enabled: false, volume: 100 }, deviceMic: { enabled: false, volume: 100 }, boxInput: { enabled: true, volume: 100 } };
    const p = audioPlanOf('phone', mix, CAPS);
    expect(p).toMatchObject({ reference: null, added: ['boxInput'], mixedOn: 'box', align: 'manual' });
  });
  it('"Kamera telefon + Audio kamera luaran" does not exist: camera audio is ignored with the phone camera', () => {
    const mix = { ...defaultAudioMix('phone'), camera: { enabled: true, volume: 100 } };
    const p = audioPlanOf('phone', mix, CAPS);
    expect(p.reference).toBe('deviceMic');
    expect(p.added).toEqual([]);
    expect(p.notes).not.toContain('camera_volume_hint');
  });
  it('all muted: phone microphone at volume 0', () => {
    const p = audioPlanOf('phone', { ...defaultAudioMix('phone'), deviceMic: { enabled: true, volume: 0 } }, CAPS);
    expect(p.allMuted).toBe(true);
    expect(p.notes).toContain('audio_all_muted');
  });
  it('defaults the runner to the phone when the caps leave it out', () => {
    const p = audioPlanOf('external', mixOf({ deviceMic: { enabled: true } }), { cameraHasAudio: true, deviceMic: true, boxInput: true });
    expect(p.mixedOn).toBe('device');
  });
});
