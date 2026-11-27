import { describe, expect, it } from 'vitest';
import {
  LIVE_REFUSALS,
  LIVE_REFUSAL_STATUS,
  LIVE_SESSIONS_RECENT_MAX,
  LIVE_VIDEO_PATHS,
  LIVE_VIDEO_PATH_DEFAULT,
  cameraUseBlocksPull,
  isLiveGap,
  isLiveRefusal,
  isLiveVideoPath,
  parseLiveStartOptions,
  videoPathOf,
  youtubeBusyOnPeer,
  type LiveCameraUse,
  type LiveGap,
  type LiveSessionRecord,
  type LiveStartRequest,
  type LiveStatus,
} from '../src/live/types.ts';

const BASE: LiveStartRequest = { kuliahId: null, source: 'android', outputs: { kiosk: true, youtube: false }, youtubeVia: 'device' };

describe('live start: the resume and videoPath fields', () => {
  it('accepts a valid resume request', () => {
    expect(parseLiveStartOptions({ ...BASE, resume: true })).toEqual({ resume: true });
  });

  it('accepts each known videoPath, alone and with resume', () => {
    expect(parseLiveStartOptions({ ...BASE, video: 'external', videoPath: 'device' })).toEqual({ videoPath: 'device' });
    expect(parseLiveStartOptions({ ...BASE, video: 'external', videoPath: 'box' })).toEqual({ videoPath: 'box' });
    expect(parseLiveStartOptions({ ...BASE, video: 'external', videoPath: 'box', resume: false })).toEqual({ resume: false, videoPath: 'box' });
  });

  it('an older app that sends neither field still passes, with nothing added', () => {
    expect(parseLiveStartOptions(BASE)).toEqual({});
  });

  it('refuses an unknown videoPath', () => {
    for (const videoPath of ['cloud', 'Box', '', 1, null, true, {}]) {
      expect(parseLiveStartOptions({ ...BASE, video: 'external', videoPath })).toBeNull();
    }
  });

  it('refuses a resume that is not a boolean', () => {
    for (const resume of ['true', 1, null, {}]) expect(parseLiveStartOptions({ ...BASE, resume })).toBeNull();
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'x', 3, []]) expect(parseLiveStartOptions(body)).toBeNull();
  });

  it('the default is the starting device, and the list holds both paths', () => {
    expect(LIVE_VIDEO_PATH_DEFAULT).toBe('device');
    expect([...LIVE_VIDEO_PATHS]).toEqual(['device', 'box']);
    expect(isLiveVideoPath('box')).toBe(true);
    expect(isLiveVideoPath('phone')).toBe(false);
  });
});

describe('videoPathOf: who pulls the camera in a live', () => {
  it('an Android phone pulls the external camera itself unless the box is asked', () => {
    expect(videoPathOf({ source: 'android', video: 'external' })).toBe('device');
    expect(videoPathOf({ source: 'android', video: 'external', videoPath: 'device' })).toBe('device');
    expect(videoPathOf({ source: 'android', video: 'external', videoPath: 'box' })).toBe('box');
  });

  it('a browser cannot pull a camera: the box always does', () => {
    expect(videoPathOf({ source: 'web', video: 'external' })).toBe('box');
    expect(videoPathOf({ source: 'web', video: 'external', videoPath: 'device' })).toBe('box');
  });

  it('a live on the device camera is always the device path', () => {
    expect(videoPathOf({ source: 'android' })).toBe('device');
    expect(videoPathOf({ source: 'android', video: 'phone', videoPath: 'box' })).toBe('device');
    expect(videoPathOf({ source: 'web', video: 'phone' })).toBe('device');
  });
});

describe('the new refusal codes', () => {
  it('lists every code once, each with its HTTP status', () => {
    expect([...LIVE_REFUSALS].sort()).toEqual(
      ['box_clock_wrong', 'camera_in_use', 'last_output', 'no_destination', 'preview_off', 'resume_mismatch', 'too_many_viewers', 'youtube_busy_other_box', 'youtube_live_not_enabled'].sort(),
    );
    expect(new Set(LIVE_REFUSALS).size).toBe(LIVE_REFUSALS.length);
    for (const code of LIVE_REFUSALS) expect(LIVE_REFUSAL_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(LIVE_REFUSAL_STATUS.resume_mismatch).toBe(409);
    expect(LIVE_REFUSAL_STATUS.too_many_viewers).toBe(429);
    expect(LIVE_REFUSAL_STATUS.preview_off).toBe(409);
    expect(LIVE_REFUSAL_STATUS.no_destination).toBe(400);
  });

  it('knows its own codes and no others', () => {
    expect(isLiveRefusal('resume_mismatch')).toBe(true);
    expect(isLiveRefusal('youtube_busy_other_box')).toBe(true);
    expect(isLiveRefusal('live_busy')).toBe(false);
    expect(isLiveRefusal(409)).toBe(false);
  });
});

describe('camera in use: join the shared picture, never a second pull', () => {
  const use = (o: Partial<LiveCameraUse> = {}): LiveCameraUse => ({
    cameraId: 'external',
    sessionId: 'S1',
    via: 'device',
    by: { name: 'Telefon Ujian', mine: false },
    since: '2026-11-22T12:00:00.000Z',
    ...o,
  });

  it('a free camera may be pulled', () => {
    expect(cameraUseBlocksPull(undefined, 'external')).toBe(false);
    expect(cameraUseBlocksPull([], 'external')).toBe(false);
    expect(cameraUseBlocksPull([use({ cameraId: 'other' })], 'external')).toBe(false);
  });

  it('the device that holds the flag may keep (or re-open) its own pull', () => {
    expect(cameraUseBlocksPull([use({ by: { name: 'Telefon Ujian', mine: true } })], 'external')).toBe(false);
  });

  it('another device pulling it blocks a second pull', () => {
    expect(cameraUseBlocksPull([use()], 'external')).toBe(true);
  });

  it('the box pulling it blocks every device pull, the starter included', () => {
    expect(cameraUseBlocksPull([use({ via: 'box', by: { name: 'Telefon Ujian', mine: true } })], 'external')).toBe(true);
  });

  it('rides in the live status beside the per-box fields', () => {
    const status: Pick<LiveStatus, 'cameraUse' | 'nextLiveOn' | 'gapSeconds' | 'broadcastIds'> = {
      cameraUse: [use()],
      nextLiveOn: false,
      gapSeconds: 0,
      broadcastIds: [],
    };
    expect(status.cameraUse?.[0]?.since).toBe('2026-11-22T12:00:00.000Z');
  });
});

describe('YouTube is per box: the busy check is keyed by channel id', () => {
  const open = { boxId: 'B2', channelId: 'UC-one', broadcastId: 'bc1' };

  it('two boxes on the same channel: the second is busy', () => {
    expect(youtubeBusyOnPeer('UC-one', [open])).toBe(true);
  });

  it('boxes on different channels never block each other', () => {
    expect(youtubeBusyOnPeer('UC-two', [open])).toBe(false);
    expect(youtubeBusyOnPeer('UC-two', [open, { boxId: 'B3', channelId: 'UC-three', broadcastId: 'bc2' }])).toBe(false);
  });

  it('no open broadcast anywhere, or an unknown channel on either side, never blocks', () => {
    expect(youtubeBusyOnPeer('UC-one', [])).toBe(false);
    expect(youtubeBusyOnPeer(null, [open])).toBe(false);
    expect(youtubeBusyOnPeer('', [{ ...open, channelId: '' }])).toBe(false);
    expect(youtubeBusyOnPeer('UC-one', [{ ...open, channelId: null }])).toBe(false);
  });
});

describe('the live_sessions row and its gaps', () => {
  const gap: LiveGap = { from: '2026-11-22T12:01:00.000Z', to: '2026-11-22T12:01:20.000Z', kind: 'ingest' };

  it('accepts an ingest gap and a YouTube gap with its broadcast', () => {
    expect(isLiveGap(gap)).toBe(true);
    expect(isLiveGap({ ...gap, kind: 'youtube', broadcastId: 'bc1' })).toBe(true);
  });

  it('refuses an unknown kind, a missing end and a broadcast id that is not text', () => {
    expect(isLiveGap({ ...gap, kind: 'relay' })).toBe(false);
    expect(isLiveGap({ from: gap.from, kind: 'ingest' })).toBe(false);
    expect(isLiveGap({ ...gap, broadcastId: 7 })).toBe(false);
    expect(isLiveGap(null)).toBe(false);
  });

  it('a record is held per box and names its own YouTube channel', () => {
    const row: LiveSessionRecord = {
      id: 'S1',
      surauId: 'surau-1',
      boxId: 'B1',
      ownerDeviceId: 'D1',
      startedBy: 'Pentadbir Ujian',
      kuliahId: null,
      source: 'android',
      video: 'external',
      videoPath: 'device',
      outputs: { kiosk: true, youtube: true },
      youtubeVia: 'device',
      youtubeChannelId: 'UC-one',
      startedAt: '2026-11-22T12:00:00.000Z',
      stoppedAt: null,
      reason: null,
      broadcastIds: ['bc1'],
      gaps: [gap],
      gapSeconds: 20,
    };
    expect(row.gaps.every(isLiveGap)).toBe(true);
    expect(LIVE_SESSIONS_RECENT_MAX).toBe(10);
  });
});
