import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { MdnsResponder, UdpTransport, isPrivateV4, realClock } from './responder.ts';
import type { Clock, IfaceAddr, MdnsTransport } from './responder.ts';
import { BoxNameStore, MAX_RENUMBERS_PER_DAY } from './store.ts';
import type { ClaimAction } from './claim.ts';
import { BOX_NAME_RE } from '../boxName.ts';

/** The prefix length of a dotted netmask (`255.255.255.0` gives 24), or null when it is not a contiguous mask. */
export function prefixOf(mask: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mask);
  if (m === null) return null;
  let bits = 0;
  let seenZero = false;
  for (const part of m.slice(1, 5).map(Number)) {
    if (part > 255) return null;
    for (let i = 7; i >= 0; i--) {
      if ((part & (1 << i)) !== 0) {
        if (seenZero) return null;
        bits++;
      } else {
        seenZero = true;
      }
    }
  }
  return bits;
}

/** The LAN addresses of this PC: private IPv4, not loopback, not virtual-only duplicates of one address. */
export function listLanInterfaces(): IfaceAddr[] {
  const out: IfaceAddr[] = [];
  const seen = new Set<string>();
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateV4(a.address) || seen.has(a.address)) continue;
      const prefix = prefixOf(a.netmask);
      if (prefix === null || prefix < 8 || prefix > 30) continue;
      seen.add(a.address);
      out.push({ addr: a.address, prefix, ident: name });
    }
  }
  return out;
}

export interface BoxNamingOptions {
  /** The data folder: the claim lives in `<dataDir>/box-name.json`. */
  dataDir: string;
  /** The DNS names of the certificate the box is serving now (read fresh each time). */
  certNames: () => string[];
  /** Looks at the certificate files again now, so a leaf renewed for the claimed name is served without waiting. */
  checkCert?: () => void;
  /** The HTTPS port the box listens on, named in the SRV record (default 8443). */
  httpsPort?: number | null;
  /** The public hints of the TXT record; null when unknown. */
  hints?: () => { boxId: string | null; caShort: string | null };
  log?: (message: string) => void;
  now?: () => Date;
  clock?: Clock;
  random?: (bound: number) => number;
  /** Test hooks. */
  transport?: MdnsTransport;
  interfaces?: () => IfaceAddr[];
  pollMs?: number;
}

export interface BoxNaming {
  responder: MdnsResponder;
  store: BoxNameStore;
  stop(): void;
}

/**
 * Claims `boxN-surau.local` for this Windows box and keeps answering for it (the Android box does the same in
 * Kotlin). The number N is the stored one (data/box-name.json) or 1; it moves only on a real conflict, at most three
 * times a day. The box service cannot make certificates, so the claim is a file: the daily certificate renewal
 * (scripts/box-cert-renew.ps1, which runs with the CA key) reads the claimed number and puts the name into the leaf.
 * Once the renewed leaf is on disk, `checkCert` makes the server serve it, and the display name follows
 * (`boxN-<surau name>`) through boxNameOf.
 */
export function startBoxNaming(o: BoxNamingOptions): BoxNaming {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? ((): Date => new Date());
  const clock = o.clock ?? realClock;
  const store = new BoxNameStore(join(o.dataDir, 'box-name.json'));
  const listInterfaces = o.interfaces ?? listLanInterfaces;
  const transport = o.transport ?? new UdpTransport();

  let claimedOnce = false;
  let recent: number[] = [];

  const responder = new MdnsResponder({
    transport,
    clock,
    ...(o.random !== undefined ? { random: o.random } : {}),
    log,
    ...(o.httpsPort !== undefined && o.httpsPort !== null ? { port: o.httpsPort } : {}),
    renumberGate: () => {
      // A box that has never claimed a name (no box-name.json) walks past taken names freely (99 at most). A box that
      // has a stored name is capped at three renumbers a day from the very first probe after a start: by the stored
      // record and, if that cannot be written, by a count in memory, so a spoofer who answers the probes of a fresh
      // process cannot walk it through the numbers (and it cannot do that at every restart either).
      if (!claimedOnce && store.read() === null) return true;
      const at = now();
      const day = at.getTime() - 86_400_000;
      recent = recent.filter((t) => t > day);
      if (recent.length >= MAX_RENUMBERS_PER_DAY) return false;
      try {
        if (!store.tryRecordRenumber(at)) return false;
      } catch (error) {
        log(`box name: renumber record not saved (${(error as Error).name})`);
      }
      recent.push(at.getTime());
      return true;
    },
    onAction: (a: ClaimAction) => {
      if (a.type === 'claimed') {
        claimedOnce = true;
        try {
          store.persistClaim(a.n, now());
          log(`box name: claimed box${a.n}-surau.local`);
        } catch (error) {
          log(`box name: claim not saved (${(error as Error).name})`);
        }
      } else if (a.type === 'exhausted') {
        log('box name: all 99 names are taken; the box is reached by its address only');
      } else if (a.type === 'lost') {
        log(`box name: gave up ${a.oldHost}`);
      }
    },
    onStatus: (bound, reason) => log(bound ? 'box name: mDNS is listening' : `box name: mDNS is not listening (${reason ?? 'unknown'})`),
  });

  const applyHints = (): void => {
    const h = o.hints?.();
    if (h !== undefined) responder.setTxt(h.boxId, h.caShort);
  };
  // The numbered name is advertised only while the certificate the box serves carries it (a legacy root never
  // does): otherwise the name would resolve and then fail the TLS name check. The name is still claimed and defended.
  const certCarries = (): boolean => {
    const host = responder.claimedHost;
    return host !== null && o.certNames().some((n) => n.toLowerCase() === host);
  };
  responder.setAdvertise(false);
  responder.start(store.read()?.n ?? 1, listInterfaces());
  applyHints();

  const poll = o.pollMs ?? 10_000;
  let ticks = 0;
  let handle: unknown = null;
  let stopped = false;
  const loop = (): void => {
    if (stopped) return;
    try {
      responder.updateInterfaces(listInterfaces());
      responder.setAdvertise(certCarries());
      // A claimed name that the certificate does not carry yet: look at the certificate files every minute for the
      // first half hour (the renewal task adds the name), then every ten minutes (a legacy root never carries it).
      const host = responder.claimedHost;
      ticks++;
      // the hints (box id, root fingerprint) read the key and certificate files: once at start, then every ten minutes
      if (ticks % 60 === 0) applyHints();
      if (host !== null && BOX_NAME_RE.test(host) && !o.certNames().map((n) => n.toLowerCase()).includes(host) && (ticks <= 180 ? ticks % 6 === 0 : ticks % 60 === 0)) {
        o.checkCert?.();
      }
    } catch (error) {
      log(`box name: check failed (${(error as Error).name})`);
    }
    handle = clock.setTimeout(loop, poll);
  };
  handle = clock.setTimeout(loop, poll);

  return {
    responder,
    store,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (handle !== null) clock.clearTimeout(handle);
      responder.stop();
    },
  };
}
