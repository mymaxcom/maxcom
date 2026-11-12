import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { klInstant } from '@surau/core';
import { buildApp } from '../../src/app.ts';
import type { AppOptions } from '../../src/app.ts';
import { putItem } from '../../src/content/store.ts';
import { startFakeMediamtx } from './fakeMediamtx.ts';
import type { FakeMediamtx } from './fakeMediamtx.ts';

export const BOX_PASS = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

export interface Clock {
  t: number;
  now: () => Date;
}

export interface LiveHarness {
  app: FastifyInstance;
  fake: FakeMediamtx;
  clock: Clock;
  dir: string;
  dataDir: string;
  kuliahId: string;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /** Create no tool stubs (live tools missing). */
  noTools?: boolean;
  app?: Partial<AppOptions>;
  live?: AppOptions['live'];
  /** Extra supervisor options (a short restart backoff, say). */
  spawn?: Record<string, unknown>;
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A box with the live runtime pointed at a fake MediaMTX (API and WHIP/WHEP on one loopback port)
 * and a stub process standing in for mediamtx.exe.
 */
export async function startLiveHarness(o: HarnessOptions = {}): Promise<LiveHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'surau-live-'));
  const dataDir = join(dir, 'data');
  const tools = join(dir, 'tools');
  mkdirSync(join(dataDir, 'secret'), { recursive: true });
  // the box reads (does not recreate) a valid password file, so the fake can expect it
  writeFileSync(join(dataDir, 'secret', 'mediamtx.pass'), BOX_PASS);
  if (o.noTools !== true) {
    mkdirSync(join(tools, 'mediamtx'), { recursive: true });
    mkdirSync(join(tools, 'ffmpeg'), { recursive: true });
    writeFileSync(join(tools, 'mediamtx', 'mediamtx.exe'), 'stub');
    writeFileSync(join(tools, 'ffmpeg', 'ffmpeg.exe'), 'stub');
  } else {
    mkdirSync(tools, { recursive: true });
  }
  const fake = await startFakeMediamtx({ pass: BOX_PASS });
  const clock: Clock = { t: klInstant('2026-11-05', '19:00').getTime(), now: () => new Date(clock.t) };
  const app = buildApp(join(dir, 'test.db'), {
    now: clock.now,
    dataDir,
    liveTools: {
      dir: tools,
      spawn: { exe: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], ...(o.spawn ?? {}) },
      apiPort: fake.port,
      webrtcPort: fake.port,
    },
    live: { monitorMs: 20, ...(o.live ?? {}) },
    ...(o.app ?? {}),
  });
  await app.ready();
  if (o.noTools !== true && app.liveRuntime !== null) await until(() => app.liveRuntime?.supervisor?.status().running === true);

  const { db } = app.surau;
  const pen = putItem(db, 'penceramah', { name: 'Ustaz Ahmad Fauzi' }, 'test');
  const kuliah = putItem(
    db,
    'kuliah',
    { date: '2026-11-05', slot: 'maghrib', time: '19:15', label: 'Kuliah Maghrib', penceramahId: pen.item.id, topic: 'Bab Solat', status: 'aktif' },
    'test',
  );
  return {
    app,
    fake,
    clock,
    dir,
    dataDir,
    kuliahId: kuliah.item.id,
    close: async () => {
      await app.close().catch(() => undefined);
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function startBody(h: LiveHarness, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kuliahId: h.kuliahId, source: 'android', outputs: { kiosk: true, youtube: false }, youtubeVia: 'device', ...over };
}

/** Every change_log row as one string (to prove no secret is in it). */
export function changeLogText(app: FastifyInstance): string {
  const rows = app.surau.db.prepare('SELECT entity, entity_id, actor, before_json, after_json FROM change_log').all();
  return JSON.stringify(rows);
}
