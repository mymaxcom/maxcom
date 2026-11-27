import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor } from './relay.ts';

/* The box's live log: one private rotating file `<dir>/live.log` that reads as a timeline of a live
   (events from the session code, ffmpeg lines from the combiner and relay). Every line passes the session
   redactor and a few fixed patterns before it is written; the camera address is never written. Writing never
   throws: a full disk or a missing folder drops the line. */

export type LiveLogFields = Record<string, string | number | boolean | null>;

export interface LiveLogLike {
  /** One timeline entry: `<time> event <kind> key=value ...`. */
  event(kind: string, fields?: LiveLogFields): void;
  /** One line printed by a process: `<time> [source] text`. */
  line(source: string, text: string): void;
  /** Replaces the redaction list (called when a session starts). */
  setSecrets(secrets: string[]): void;
}

/** A log that does nothing (default for code that has none). */
export const NULL_LIVE_LOG: LiveLogLike = {
  event(): void {},
  line(): void {},
  setSecrets(): void {},
};

export interface LiveLogOptions {
  /** Folder of `live.log` (created when missing). */
  dir: string;
  /** Size limit of the file before it is rotated to `live.log.1` (default 2 MB). */
  maxBytes?: number;
  now?: () => Date;
  /** Test hook: replaces the file append (default `appendFileSync` with mode 0600). */
  writeFn?: (path: string, text: string) => void;
  /** Test hook: replaces `statSync(path).size` (a failure means the size is unknown for now). */
  sizeFn?: (path: string) => number;
  /** Test hook: replaces `chmodSync(path, 0o600)` of a log file that already exists. */
  chmodFn?: (path: string) => void;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** IPv6 in full or compressed (`::`) form with an optional zone; never a clock like `00:01:02` (that has no `::` and not 8 groups). */
const IPV6_RE = /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})(?:%[\w.-]+)?(?![\w:])/gi;
/** Control characters (C0, DEL, line and paragraph separators): one space each run. */
const CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]+/g;
/** B8: one entry (without its time) is at most this long. */
const MAX_LINE_CHARS = 1000;
const RTSP_CRED_RE = /\b(rtsps?:\/\/)[^\s/@]*@/gi;
const RTMP_URL_RE = /\brtmps?:\/\/[^\s]+/gi;

/** `rtmp(s)://host/app/<key>`: the last path segment is the stream key. */
function maskRtmpKey(url: string): string {
  const m = /^(rtmps?:\/\/[^/]+(?:\/[^/]+)*)\/[^/]+$/i.exec(url);
  if (m === null) return url;
  return `${m[1]}/***`;
}

export class LiveLog implements LiveLogLike {
  private readonly dir: string;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly writeFn: (path: string, text: string) => void;
  private redact: (text: string) => { text: string; hit: boolean } = createRedactor([]);
  private readonly sizeFn: (path: string) => number;
  /** null: unknown (the stat failed); the next write checks again. */
  private size: number | null = 0;
  private dropped = 0;

  // no parameter properties: the box runs under Node's strip-only TypeScript mode
  constructor(o: LiveLogOptions) {
    this.dir = o.dir;
    this.path = join(o.dir, 'live.log');
    this.maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = o.now ?? (() => new Date());
    this.writeFn = o.writeFn ?? ((p, t) => appendFileSync(p, t, { mode: 0o600 }));
    this.sizeFn = o.sizeFn ?? ((p) => statSync(p).size);
    const chmodFn = o.chmodFn ?? ((p: string) => chmodSync(p, 0o600));
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      /* the first write tries again */
    }
    try {
      // a file that exists from an earlier box version or run may be wider than 0600: tighten it
      if (existsSync(this.path)) chmodFn(this.path);
    } catch {
      /* best effort (no modes on some systems) */
    }
    this.size = this.currentSize();
  }

  /** The size of the file now: 0 when there is none, null when it cannot be read (rotation then checks again on the next write). */
  private currentSize(): number | null {
    try {
      return existsSync(this.path) ? this.sizeFn(this.path) : 0;
    } catch {
      return null;
    }
  }

  /** Lines that could not be written (full disk, missing folder, permission). */
  droppedLines(): number {
    return this.dropped;
  }

  setSecrets(secrets: string[]): void {
    const all: string[] = [];
    for (const s of secrets) {
      if (typeof s !== 'string' || s === '') continue;
      all.push(s, encodeURIComponent(s));
    }
    this.redact = createRedactor(all);
  }

  event(kind: string, fields?: LiveLogFields): void {
    let text = `event ${this.clean(kind)}`;
    if (fields !== undefined) {
      for (const [k, v] of Object.entries(fields)) text += ` ${this.clean(k)}=${v === null ? 'null' : this.clean(String(v))}`;
    }
    this.write(text);
  }

  line(source: string, text: string): void {
    this.write(`[${this.clean(source)}] ${text}`);
  }

  /** Control characters out, then secrets, credential URLs and IPv4 and IPv6 addresses masked. */
  private clean(text: string): string {
    let out = this.redact(text.replace(CONTROL_RE, ' ')).text;
    out = out.replace(RTSP_CRED_RE, '$1***@');
    out = out.replace(RTMP_URL_RE, maskRtmpKey);
    return out.replace(IPV4_RE, '***').replace(IPV6_RE, '***');
  }

  private write(body: string): void {
    try {
      // event() already cleaned its parts; line() text is cleaned here (cleaning twice is harmless); one entry is capped
      const cleaned = this.clean(body).slice(0, MAX_LINE_CHARS);
      const text = `${this.now().toISOString()} ${cleaned}\n`;
      const len = Buffer.byteLength(text);
      // B10: a size that could not be read is read again now; a file that was large from before still rotates
      if (this.size === null) this.size = this.currentSize();
      if (this.size !== null && this.size > 0 && this.size + len > this.maxBytes) {
        try {
          renameSync(this.path, `${this.path}.1`);
        } catch {
          /* rotation is best effort */
        }
        this.size = 0;
      }
      try {
        this.writeFn(this.path, text);
      } catch {
        // the folder may have been removed: make it again and try once more
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.writeFn(this.path, text);
      }
      if (this.size !== null) this.size += len;
    } catch {
      this.dropped += 1;
    }
  }
}
