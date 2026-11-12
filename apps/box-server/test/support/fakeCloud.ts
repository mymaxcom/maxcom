import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import type { AppOptions } from '../../src/app.ts';

export const CLOUD_URL = 'https://cloud.test';

export interface TestCloud {
  app: FastifyInstance;
  dir: string;
  /** `fetch` that serves `https://cloud.test/...` from the in-process cloud app. */
  fetch: typeof fetch;
  close: () => Promise<void>;
}

async function bodyBuffer(body: unknown): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** A `fetch` over a Fastify app: any host is routed to it (the test wires the host it wants). */
export function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const method = (init?.method ?? 'GET').toUpperCase();
    const payload = await bodyBuffer(init?.body);
    const res = await app.inject({ method: method as 'GET', url: u.pathname + u.search, headers, ...(payload ? { payload } : {}) });
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    const bodyless = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
    return new Response(bodyless ? null : res.rawPayload, { status: res.statusCode, headers: h });
  }) as typeof fetch;
}

/** The cloud role as a second in-process app. Its box id is the surau's (`boxId`), as in production. */
export function buildCloud(boxId: string, opts: AppOptions = {}): TestCloud {
  const dir = mkdtempSync(join(tmpdir(), 'surau-cloud-'));
  const app = buildApp(join(dir, 'cloud.db'), { dataDir: dir, role: 'cloud', boxId, ...opts });
  return {
    app,
    dir,
    fetch: injectFetch(app),
    close: async () => {
      await app.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
