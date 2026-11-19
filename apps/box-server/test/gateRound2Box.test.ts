import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameGrabber } from '../src/live/noticeFrame.ts';
import type { FrameApi } from '../src/live/noticeFrame.ts';
import { enqueueCameraMark } from '../src/sync/workerOutbox.ts';
import { buildCloud } from './support/fakeCloud.ts';
import type { TestCloud } from './support/fakeCloud.ts';
import { FakeWorker } from './support/fakeWorker.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** Gate round 2 (box): S5 leftover frame users, Q7 an old Worker's 404 on the camera mark. (S9 agent cap: cameraRelayWake.test.ts.) */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

const clouds: TestCloud[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clouds.splice(0)) await c.close();
});

function ffmpegStandIn() {
  return () => {
    const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => void };
    proc.stdout = new PassThrough();
    proc.kill = () => undefined;
    setTimeout(() => {
      proc.stdout.write(JPEG);
      proc.stdout.end();
      proc.emit('close', 0);
    }, 0);
    return proc as never;
  };
}

describe('S5: a frame user that could not be removed is removed at the session end', () => {
  function grabber(api: FrameApi) {
    return new FrameGrabber({
      ffmpegPath: () => 'ffmpeg',
      api: () => api,
      ready: () => true,
      sessionId: () => 's1',
      spawnFn: ffmpegStandIn(),
    });
  }

  it('a failed removal is retried by sweepStale; the log line carries a count and no secret', async () => {
    const added: string[] = [];
    let removeWorks = false;
    const api = {
      authUserAdd: vi.fn(async (u: { user: string }): Promise<void> => void added.push(u.user)),
      authUserRemove: vi.fn(async (_user: string): Promise<void> => {
        if (!removeWorks) throw new Error('mediamtx down');
      }),
    };
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.join(' ')));
    const g = grabber(api);
    expect(await g.get()).not.toBeNull();
    expect(await g.sweepStale()).toBe(0); // still down: nothing removed, stays pending
    removeWorks = true;
    api.authUserRemove.mockClear();
    expect(await g.sweepStale()).toBe(1);
    expect(api.authUserRemove).toHaveBeenCalledWith(added[0]);
    expect(await g.sweepStale()).toBe(0); // nothing left
    const text = warns.join('\n');
    expect(text).toMatch(/leftover frame user/);
    expect(text).not.toContain(added[0]!);
  });

  it('success path: a clean removal leaves nothing to sweep', async () => {
    const api = { authUserAdd: vi.fn(async (): Promise<void> => undefined), authUserRemove: vi.fn(async (_user: string): Promise<void> => undefined) };
    const g = grabber(api);
    expect(await g.get()).not.toBeNull();
    expect(api.authUserRemove).toHaveBeenCalledTimes(1);
    api.authUserRemove.mockClear();
    expect(await g.sweepStale()).toBe(0);
    expect(api.authUserRemove).not.toHaveBeenCalled();
  });
});

describe('Q7: an old Worker answers 404 to the camera mark', () => {
  const BOX = 'a1b2c3d4e5f60718';

  it('PUT 404 is retried (not failed); the mark lands once the Worker knows the route; a DELETE 404 still counts as done', async () => {
    const hook: { fetch: typeof fetch } = { fetch: (() => Promise.reject(new Error('unwired'))) as typeof fetch };
    const cloud = buildCloud(BOX, {
      workerAdmin: { url: 'https://worker.test', token: 'test-admin-token', fetchImpl: ((i: Parameters<typeof fetch>[0], n?: RequestInit) => hook.fetch(i, n)) as typeof fetch },
      workerOutbox: { auto: false },
    });
    clouds.push(cloud);
    const worker = new FakeWorker(cloud.fetch);
    hook.fetch = worker.fetch;
    const db = cloud.app.surau.db;
    enqueueCameraMark(db, BOX, true);
    worker.adminStatus = 404;
    await cloud.app.workerOutbox!.drain();
    expect(db.prepare("SELECT state, last_error FROM worker_outbox WHERE kind = 'camera_put'").get()).toMatchObject({ last_error: 'http_404' });
    expect(db.prepare("SELECT state FROM worker_outbox WHERE kind = 'camera_put'").get()?.state).not.toBe('failed');
    // the Worker is updated: the next try (after the backoff) delivers it
    worker.adminStatus = null;
    db.prepare("UPDATE worker_outbox SET next_at = '2000-01-01T00:00:00.000Z'").run();
    await cloud.app.workerOutbox!.drain();
    expect(worker.camera.has(BOX)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM worker_outbox WHERE kind = 'camera_put'").get()).toEqual({ n: 0 });
    // a clear the old Worker does not know is simply done
    enqueueCameraMark(db, BOX, false);
    worker.adminStatus = 404;
    await cloud.app.workerOutbox!.drain();
    expect(db.prepare("SELECT COUNT(*) AS n FROM worker_outbox WHERE kind = 'camera_delete'").get()).toEqual({ n: 0 });
  });
});
