import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { isBlockedHost, sourceUrlError } from '@surau/core';
import { tooMany } from './auth/authz.ts';
import { createRateLimiter } from './auth/ratelimit.ts';
import { authLog } from './auth/sessions.ts';
import { getSettings } from './settingsStore.ts';
import { readCapped } from './net/readCapped.ts';
import { sourceUrlsFrom } from './net/safeFetch.ts';

export type SourceTestError = 'blocked_host' | 'timeout' | 'bad_url' | 'failed';
export interface SourceTestResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: SourceTestError;
}

export interface SettingsTestDeps {
  db: DatabaseSync;
  /** The guarded fetch (https only, public hosts only, no redirect). */
  fetchImpl: typeof fetch;
  /** Test seam; default 5 s. */
  timeoutMs?: number;
}

const RECITER_RE = /^[A-Za-z0-9_]{3,64}$/;
const MAX_BODY = 4 * 1024;
const SMALL_BODY = { bodyLimit: 8 * 1024 } as const;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One GET or HEAD through the guarded fetch: the status and the time, nothing else. Never stores or returns the body. */
export async function probe(url: string, method: 'GET' | 'HEAD', deps: SettingsTestDeps): Promise<SourceTestResult> {
  const began = Date.now();
  const done = (r: Omit<SourceTestResult, 'ms'>): SourceTestResult => ({ ...r, ms: Date.now() - began });
  const bad = sourceUrlError(url);
  if (bad !== null) {
    let blocked = false;
    try {
      blocked = isBlockedHost(new URL(url).hostname);
    } catch {
      blocked = false;
    }
    return done({ ok: false, status: null, error: blocked ? 'blocked_host' : 'bad_url' });
  }
  const timeoutMs = deps.timeoutMs ?? 5_000;
  try {
    const res = await deps.fetchImpl(url, { method, signal: AbortSignal.timeout(timeoutMs), headers: { accept: '*/*' } });
    if (method === 'GET') await readCapped(res, MAX_BODY, 'response').catch(() => res.body?.cancel().catch(() => undefined));
    else await res.body?.cancel().catch(() => undefined);
    return done({ ok: res.status >= 200 && res.status < 300, status: res.status });
  } catch (error) {
    const msg = error instanceof Error ? `${error.name} ${error.message}` : '';
    if (/Timeout|Abort/i.test(msg)) return done({ ok: false, status: null, error: 'timeout' });
    if (/local or private|private address|must use https|credentials/i.test(msg)) return done({ ok: false, status: null, error: 'blocked_host' });
    return done({ ok: false, status: null, error: 'failed' });
  }
}

/** The host of an address for the log: a plain token, never the path, query or credentials; `-` when it has none. */
function hostForLog(url: string): string {
  try {
    const h = new URL(url).hostname;
    return /^[A-Za-z0-9.\-[\]:]{1,100}$/.test(h) ? h : '-';
  } catch {
    return '-';
  }
}

/**
 * `POST /api/settings/test-source` (system:write): "Cuba sambungan". `source` fetches a data-source address;
 * `reciter` asks the configured audio source for a verse of the named reciter folder. Nothing is stored and
 * only the status code and the time come back.
 */
export function registerSettingsTest(app: FastifyInstance, deps: SettingsTestDeps): void {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
  // One auth_log row per probe: who asked, which host, and how it ended. Never the path, query or folder.
  const logged = (request: FastifyRequest, kind: 'source' | 'reciter', url: string, result: SourceTestResult): SourceTestResult => {
    const who = request.auth !== null && request.auth.kind === 'user' ? request.auth : null;
    const outcome = result.ok ? 'ok' : result.error ?? `status_${result.status ?? 'none'}`;
    authLog(deps.db, new Date(), 'source_test', result.ok, {
      userId: who?.userId ?? null,
      deviceId: who?.deviceId ?? null,
      ip: request.ip,
      detail: `${kind} ${hostForLog(url)} ${outcome}`,
    });
    return result;
  };
  app.post('/api/settings/test-source', SMALL_BODY, async (request, reply) => {
    const who = request.auth !== null && request.auth.kind === 'user' ? request.auth.sessionId : request.ip;
    const hit = limiter.hit(who);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const b = request.body;
    if (!isPlain(b)) return reply.code(400).send({ errors: ['Permintaan tidak sah'] });
    reply.header('Cache-Control', 'no-store');
    if (b.kind === 'source') {
      if (typeof b.url !== 'string' || b.url.length === 0 || b.url.length > 300) return reply.code(400).send({ errors: ['Alamat tidak sah'] });
      return logged(request, 'source', b.url, await probe(b.url, 'GET', deps));
    }
    if (b.kind === 'reciter') {
      if (typeof b.folder !== 'string' || !RECITER_RE.test(b.folder)) return reply.code(400).send({ errors: ['Nama folder qari tidak sah'] });
      const base = sourceUrlsFrom(getSettings(deps.db)).quranAudio.replace(/\/+$/, '');
      return logged(request, 'reciter', base, await probe(`${base}/${b.folder}/001001.mp3`, 'HEAD', deps));
    }
    return reply.code(400).send({ errors: ['Jenis ujian tidak sah'] });
  });
}
