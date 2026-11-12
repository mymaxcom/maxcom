import type { FakeGoogle, GoogleCall } from './fakeGoogle.ts';

/** The resumable-upload id a fake session URI carries; tests grep for its absence. */
export const FAKE_UPLOAD_ID = 'UPLOADID-SECRET-77';

export interface GoogleUploadFake {
  /** The fake Google's `fetch` plus the three video endpoints Plan 6 Task 5 uses. */
  fetchImpl: typeof fetch;
  /** Resumable-session requests received (POST /upload/youtube/v3/videos). */
  sessions: GoogleCall[];
  /** videos.update requests received (PUT /youtube/v3/videos). */
  updates: GoogleCall[];
  /** Answer the next session request with this error keyword (for example `quotaExceeded`), status 403. */
  sessionError: string | null;
  /** Answer the next videos.update with this status. */
  updateStatus: number;
  /** privacyStatus the next videos.list reports. */
  currentPrivacy: string;
  /** Per-video answers for videos.list. A video not listed here answers as before (exists, `currentPrivacy`, processed, no duration). */
  videos: Record<string, FakeVideo>;
  /** When set, videos.list answers a `snippet` with this publishedAt (and channelId) for every video that exists. */
  snippet: (() => { publishedAt: string; channelId: string }) | null;
  /** Every videos.list GET received (to count calls and read the `part` and `id` asked for). */
  lists: GoogleCall[];
}

export interface FakeVideo {
  /** false: Google returns no item for the id. */
  exists?: boolean;
  privacy?: string;
  uploadStatus?: string;
  processingStatus?: string;
  /** ISO 8601, for example `PT1H2M3S`; omitted when undefined. */
  duration?: string;
  /** Overrides the fake's snippet for this video. */
  publishedAt?: string;
  channelId?: string;
}

async function readText(body: unknown): Promise<string> {
  if (body === undefined || body === null) return '';
  return typeof body === 'string' ? body : Buffer.from(body as Uint8Array).toString('utf8');
}

/** Wraps `FakeGoogle` with the upload and video endpoints it lacks. Every other call goes to the base fake. */
export function withUploadApi(g: FakeGoogle): GoogleUploadFake {
  const fake: GoogleUploadFake = {
    fetchImpl: g.fetchImpl,
    sessions: [],
    updates: [],
    sessionError: null,
    updateStatus: 200,
    currentPrivacy: 'unlisted',
    videos: {},
    snippet: null,
    lists: [],
  };
  const json = (status: number, obj: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const record = async (u: URL, init: RequestInit | undefined): Promise<GoogleCall> => {
    const body = await readText(init?.body);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    return { method: (init?.method ?? 'GET').toUpperCase(), path: u.pathname, query: u.searchParams, headers, body, json: parsed };
  };
  fake.fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw);
    const authed = new Headers(init?.headers).get('authorization')?.startsWith('Bearer access-token-') === true;
    if (u.hostname === 'www.googleapis.com' && u.pathname === '/upload/youtube/v3/videos') {
      const call = await record(u, init);
      fake.sessions.push(call);
      if (!authed) return json(401, { error: { code: 401, errors: [{ reason: 'authError' }] } });
      if (fake.sessionError !== null) return json(403, { error: { code: 403, errors: [{ reason: fake.sessionError }] } });
      return json(200, {}, { Location: `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=${FAKE_UPLOAD_ID}` });
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname === '/youtube/v3/videos') {
      const call = await record(u, init);
      if (!authed) return json(401, { error: { code: 401, errors: [{ reason: 'authError' }] } });
      if (call.method === 'GET') {
        fake.lists.push(call);
        const ids = (u.searchParams.get('id') ?? '').split(',').filter((x) => x !== '');
        const items = ids.flatMap((id) => {
          const v = fake.videos[id] ?? {};
          if (v.exists === false) return [];
          const item: Record<string, unknown> = {
            id,
            status: { privacyStatus: v.privacy ?? fake.currentPrivacy, embeddable: true, selfDeclaredMadeForKids: false, uploadStatus: v.uploadStatus ?? 'processed' },
          };
          if (v.processingStatus !== undefined) item.processingDetails = { processingStatus: v.processingStatus };
          if (v.duration !== undefined) item.contentDetails = { duration: v.duration };
          const sn = fake.snippet?.();
          if (sn !== undefined && sn !== null) item.snippet = { publishedAt: v.publishedAt ?? sn.publishedAt, channelId: v.channelId ?? sn.channelId };
          return [item];
        });
        return json(200, { items });
      }
      if (call.method === 'PUT') {
        fake.updates.push(call);
        if (fake.updateStatus !== 200) return json(fake.updateStatus, { error: { code: fake.updateStatus, errors: [{ reason: 'backendError' }] } });
        return json(200, { id: (call.json as { id?: string } | null)?.id ?? '' });
      }
    }
    return g.fetchImpl(input, init);
  }) as typeof fetch;
  return fake;
}
