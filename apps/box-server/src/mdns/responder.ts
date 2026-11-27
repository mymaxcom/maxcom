import { createSocket } from 'node:dgram';
import { announcement, goodbye, LEGACY_MAX_BYTES, MdnsIdentity, parseHost, probeMessage, replyTo, SERVICE_PORT } from './answerer.ts';
import { NameClaim } from './claim.ts';
import type { ClaimAction } from './claim.ts';
import { decodeMessage, encodeMessage, ipv4Bytes, isResponse } from './codec.ts';
import type { DnsMessage } from './codec.ts';

export const MDNS_PORT = 5353;
export const MDNS_GROUP = '224.0.0.251';
export const MAX_PACKETS_PER_SECOND = 200;
export const MAX_PACKETS_PER_SOURCE = 20;
const MAX_TRACKED_SOURCES = 512;

/** One LAN interface address: dotted IPv4, prefix length, and an identity (name and index) so a re-created interface differs. */
export interface IfaceAddr {
  addr: string;
  prefix: number;
  ident: string;
}

export interface TransportHandlers {
  onPacket(data: Buffer, addr: string, port: number): void;
  /** The socket died after it was open. */
  onError(reason: string): void;
}

/** The sockets under the responder; a test swaps in an in-memory one. */
export interface MdnsTransport {
  /** Binds the socket; rejects when it cannot. */
  open(handlers: TransportHandlers): Promise<void>;
  /** Joins the multicast group on one interface; throws when it cannot. */
  join(iface: IfaceAddr): void;
  leave(iface: IfaceAddr): void;
  /** Sends to the multicast group out of one interface, from the mDNS port. */
  sendMulticast(iface: IfaceAddr, data: Buffer): void;
  sendUnicast(data: Buffer, addr: string, port: number): void;
  close(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Number(process.hrtime.bigint() / 1_000_000n),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** True for the ranges a home or surau LAN uses: 10/8, 172.16/12, 192.168/16 and link-local 169.254/16. */
export function isPrivateV4(addr: string): boolean {
  const b = ipv4Bytes(addr);
  if (b === null) return false;
  const [a, c] = b as [number, number];
  return a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 169 && c === 254);
}

/** True when `other` lies in the subnet of the interface. */
export function ifaceContains(i: IfaceAddr, other: string): boolean {
  const x = ipv4Bytes(i.addr);
  const y = ipv4Bytes(other);
  if (x === null || y === null) return false;
  let bits = i.prefix;
  for (let k = 0; k < 4; k++) {
    const take = Math.min(8, bits);
    if (take <= 0) break;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((x[k]! & mask) !== (y[k]! & mask)) return false;
    bits -= take;
  }
  return true;
}

export interface ResponderOptions {
  transport: MdnsTransport;
  clock?: Clock;
  random?: (bound: number) => number;
  onAction?: (a: ClaimAction) => void;
  log?: (message: string) => void;
  /** The source port of real mDNS peers (5353); a test uses another one. Anything else is a legacy unicast asker. */
  peerPort?: number;
  /** Asked at each renumber decision (see NameClaim.renumberGate); false keeps the current name. */
  renumberGate?: () => boolean;
  /** Called on every change of `bound` with the failure reason (null when bound). */
  onStatus?: (bound: boolean, reason: string | null) => void;
  /** Delays before each bind retry; the last one repeats. */
  backoffMs?: number[];
  maxPerSource?: number;
  /** Tests only: accept a source that is not a private LAN address (loopback). */
  allowNonPrivate?: boolean;
  /** The HTTPS port the box listens on, named in the SRV record (default 8443). */
  port?: number;
  /** How many source addresses are tracked at most; a source beyond that is dropped, never a tracked one forgotten. */
  maxTrackedSources?: number;
}

interface SourceWindow {
  start: number;
  count: number;
}

/**
 * The mDNS node of a Windows box: one socket on UDP 5353 (IPv4 only, shared with any other mDNS service on the PC),
 * answers for `boxN-surau.local` and the `_maxcom._tcp` service while the name is claimed, probes and defends the
 * name through NameClaim. It answers for ITS OWN names only and speaks only on the LAN interfaces it was given.
 *
 * What it accepts: a packet only from a private source on one of our own subnets and never from our own addresses;
 * a response or a probe only from port 5353 (RFC 6762 11). Packets are rate limited per source address in front of
 * the global cap, so one flooder cannot starve the others. Anything that does not decode is dropped; no packet can
 * throw out of the receive path.
 *
 * When the socket cannot be bound or joined, or dies later, the node reports bound = false with the failure reason
 * and retries after 5 s, 30 s, 2 min and then every 5 min.
 */
export class MdnsResponder {
  private readonly transport: MdnsTransport;
  private readonly clock: Clock;
  private readonly random: (bound: number) => number;
  private readonly onAction: (a: ClaimAction) => void;
  private readonly log: (m: string) => void;
  private lastReprobeLog = Number.NEGATIVE_INFINITY;
  private readonly peerPort: number;
  private readonly renumberGate: () => boolean;
  private readonly onStatus: (bound: boolean, reason: string | null) => void;
  private readonly backoffMs: number[];
  private readonly maxPerSource: number;
  private readonly allowNonPrivate: boolean;
  private readonly port: number;
  private readonly maxTracked: number;
  /** False while the name must not be announced or answered (the certificate does not carry it yet); probes are still defended. */
  private advertise = true;

  private ifaces: IfaceAddr[] = [];
  private claim: NameClaim | null = null;
  private boxId: string | null = null;
  private caShort: string | null = null;
  private startN = 1;
  private attempt = 0;
  private retryHandle: unknown = null;
  private timerHandle: unknown = null;
  private opening = false;
  private stopped = false;
  private windowStart = 0;
  private windowCount = 0;
  private readonly sources = new Map<string, SourceWindow>();

  /** True while the socket is bound and the group joined; false before the first bind and after a failure. */
  bound = false;
  /** Why the node is not bound (a short reason, no addresses), or null. */
  failure: string | null = null;
  /** The claimed host name, or null while probing, when stopped or when no name is free. */
  claimedHost: string | null = null;
  exhausted = false;

  constructor(o: ResponderOptions) {
    this.transport = o.transport;
    this.clock = o.clock ?? realClock;
    this.random = o.random ?? ((bound) => Math.floor(Math.random() * bound));
    this.onAction = o.onAction ?? (() => undefined);
    this.log = o.log ?? (() => undefined);
    this.peerPort = o.peerPort ?? MDNS_PORT;
    this.renumberGate = o.renumberGate ?? (() => true);
    this.onStatus = o.onStatus ?? (() => undefined);
    this.backoffMs = o.backoffMs ?? [5_000, 30_000, 120_000, 300_000];
    this.maxPerSource = o.maxPerSource ?? MAX_PACKETS_PER_SOURCE;
    this.allowNonPrivate = o.allowNonPrivate === true;
    this.port = o.port ?? SERVICE_PORT;
    this.maxTracked = o.maxTrackedSources ?? MAX_TRACKED_SOURCES;
  }

  /**
   * Turns announcing and answering for the claimed name on or off. The name stays claimed and a probe of it is still
   * defended either way (so no other box takes the number), but while off nothing tells the LAN to use the name.
   * Turning it on announces at once when the name is claimed.
   */
  setAdvertise(on: boolean): void {
    this.guard(() => {
      const was = this.advertise;
      this.advertise = on;
      if (on && !was && this.claim?.claimed === true) this.announce();
    });
  }

  /** The number the claim is at now (it moves on a conflict), or null before the first bind. */
  get number(): number | null {
    return this.claim?.n ?? null;
  }

  /** Starts the node: binds the socket, joins the group on each interface and begins probing at startN. */
  start(startN: number, list: IfaceAddr[]): void {
    this.startN = startN;
    this.ifaces = list;
    void this.attemptBind();
  }

  /** The interface set changed: goodbyes on gone ones, join new ones, probe again at once. */
  updateInterfaces(list: IfaceAddr[]): void {
    if (this.stopped) return;
    this.guard(() => {
      if (!this.bound) {
        this.ifaces = list;
        return;
      }
      const c = this.claim;
      if (c === null || this.sameInterfaces(list, this.ifaces)) return;
      const removed = this.ifaces.filter((old) => !list.some((n) => this.sameIface(n, old)));
      const id = this.identity();
      if (c.claimed && id !== null) for (const r of removed) this.send(r, goodbye(id, r.addr));
      for (const r of removed) this.leave(r);
      const added = list.filter((n) => !this.ifaces.some((o) => this.sameIface(o, n)));
      this.ifaces = list;
      try {
        this.joinAll(added);
      } catch (error) {
        this.log(`mdns join failed: ${(error as Error).message}`);
      }
      c.setAddresses(list.map((i) => i.addr));
      this.released();
      if (list.length > 0) c.restart(this.clock.now());
      else c.stop();
      this.reschedule();
    });
  }

  /** The public hints in the TXT record changed; announce again when the name is ours. */
  setTxt(id: string | null, ca: string | null): void {
    this.guard(() => {
      const changed = id !== this.boxId || ca !== this.caShort;
      this.boxId = id;
      this.caShort = ca;
      if (changed && this.claim?.claimed === true && this.advertise) this.announce();
    });
  }

  /** Sends goodbyes, closes the socket (after the goodbyes left) and stops the timers. */
  stop(): void {
    if (this.stopped) return;
    try {
      const c = this.claim;
      const id = this.identity();
      if (this.bound && c !== null && c.claimed && id !== null) for (const r of this.ifaces) this.send(r, goodbye(id, r.addr));
    } catch {
      /* closing anyway */
    }
    this.stopped = true;
    this.released();
    this.bound = false;
    if (this.timerHandle !== null) this.clock.clearTimeout(this.timerHandle);
    if (this.retryHandle !== null) this.clock.clearTimeout(this.retryHandle);
    this.timerHandle = this.retryHandle = null;
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
  }

  // ---- internals ------------------------------------------------------------------------------------------

  /** Runs one step; a throw is logged and never leaves the node. */
  private guard(block: () => void): void {
    if (this.stopped) return;
    try {
      block();
    } catch (error) {
      this.log(`mdns step failed: ${(error as Error).name}`);
    }
  }

  private async attemptBind(): Promise<void> {
    if (this.stopped || this.bound || this.opening) return;
    this.opening = true;
    try {
      await this.transport.open({
        onPacket: (data, addr, port) => this.onPacket(data, addr, port),
        onError: (reason) => this.guard(() => this.fail(`receive: ${reason}`)),
      });
      if (this.stopped) {
        this.transport.close();
        return;
      }
      this.joinAll(this.ifaces);
      const c = new NameClaim(this.claim?.n ?? this.startN, this.random);
      c.renumberGate = this.renumberGate;
      c.setAddresses(this.ifaces.map((i) => i.addr));
      this.claim = c;
      this.bound = true;
      this.failure = null;
      this.attempt = 0;
      try {
        this.onStatus(true, null);
      } catch {
        /* the owner's problem */
      }
      if (this.ifaces.length > 0) c.start(this.clock.now());
      this.reschedule();
    } catch (error) {
      try {
        this.transport.close();
      } catch {
        /* nothing open */
      }
      this.fail(`bind: ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}`);
    } finally {
      this.opening = false;
    }
  }

  /** The claim is released without a conflict (interfaces gone, socket lost): tell the owner the name is gone. */
  private released(): void {
    const h = this.claimedHost;
    if (h === null) return;
    this.claimedHost = null;
    try {
      this.onAction({ type: 'lost', oldHost: h });
    } catch {
      /* the owner's problem */
    }
  }

  /** The node is not (or no longer) usable: say so, drop the socket and try again later. */
  private fail(reason: string): void {
    if (this.stopped) return;
    const wasBound = this.bound;
    this.bound = false;
    this.failure = reason;
    this.exhausted = false;
    this.released();
    this.claim?.stop();
    if (this.timerHandle !== null) this.clock.clearTimeout(this.timerHandle);
    this.timerHandle = null;
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
    this.log(`mdns not bound: ${reason}`);
    if (wasBound || this.attempt === 0) {
      try {
        this.onStatus(false, reason);
      } catch {
        /* the owner's problem */
      }
    }
    if (this.retryHandle !== null) return;
    const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)]!;
    this.attempt++;
    this.retryHandle = this.clock.setTimeout(() => {
      this.retryHandle = null;
      void this.attemptBind();
    }, delay);
  }

  private sameIface(x: IfaceAddr, y: IfaceAddr): boolean {
    return x.addr === y.addr && x.prefix === y.prefix && x.ident === y.ident;
  }

  private sameInterfaces(a: IfaceAddr[], b: IfaceAddr[]): boolean {
    return a.length === b.length && a.every((x) => b.some((y) => this.sameIface(x, y)));
  }

  private identity(): MdnsIdentity | null {
    const c = this.claim;
    return c === null ? null : new MdnsIdentity(c.n, this.boxId, this.caShort, this.port);
  }

  private reschedule(): void {
    const c = this.claim;
    if (this.timerHandle !== null) this.clock.clearTimeout(this.timerHandle);
    this.timerHandle = null;
    if (c === null || this.stopped) return;
    const due = c.nextDeadline();
    if (due === null) return;
    const wait = Math.max(0, due - this.clock.now());
    this.timerHandle = this.clock.setTimeout(() => {
      this.timerHandle = null;
      this.guard(() => this.tick());
    }, wait);
  }

  private tick(): void {
    const c = this.claim;
    if (c === null) return;
    this.handle(c.tick(this.clock.now()));
    this.reschedule();
  }

  private handle(actions: ClaimAction[]): void {
    const c = this.claim;
    if (c === null) return;
    for (const a of actions) {
      switch (a.type) {
        case 'probe':
          for (const r of this.ifaces) this.send(r, probeMessage(a.host, r.addr));
          break;
        case 'announce':
          if (this.advertise) this.announce();
          break;
        case 'claimed':
          this.claimedHost = c.host;
          this.exhausted = false;
          break;
        case 'lost': {
          this.claimedHost = null;
          const n = parseHost(a.oldHost);
          if (n !== null) {
            const old = new MdnsIdentity(n, this.boxId, this.caShort, this.port);
            for (const r of this.ifaces) this.send(r, goodbye(old, r.addr));
          }
          break;
        }
        case 'exhausted':
          this.claimedHost = null;
          this.exhausted = true;
          break;
        case 'renumberDenied':
          this.log('mdns renumber cap reached, keeping the name');
          break;
      }
      try {
        this.onAction(a);
      } catch {
        /* the owner's problem */
      }
    }
    this.claimedHost = c.claimed ? c.host : null;
  }

  private announce(): void {
    const id = this.identity();
    if (id === null) return;
    for (const r of this.ifaces) this.send(r, announcement(id, r.addr));
  }

  /** One datagram from the transport. Never throws. */
  private onPacket(data: Buffer, from: string, fromPort: number): void {
    this.guard(() => this.accept(data, from, fromPort));
  }

  private accept(data: Buffer, from: string, fromPort: number): void {
    const c = this.claim;
    if (c === null || !this.bound) return;
    if (ipv4Bytes(from) === null) return;
    if (this.ifaces.some((i) => i.addr === from)) return; // our own packet, looped back
    if (!this.allowNonPrivate && !isPrivateV4(from)) return; // a LAN-only responder
    const iface = this.ifaces.find((i) => ifaceContains(i, from));
    if (iface === undefined) return; // not on one of our subnets: ignore
    const now = this.clock.now();
    // per source first: one flooder runs into its own cap and does not use up the global budget
    // A full table first forgets sources idle for a second; if it is still full a NEW source is dropped, a tracked
    // one is never forgotten, so rotating forged sources cannot reset the count of a flooder.
    if (this.sources.size >= this.maxTracked) for (const [k, sw] of this.sources) if (now - sw.start >= 1000) this.sources.delete(k);
    let w = this.sources.get(from);
    if (w === undefined) {
      if (this.sources.size >= this.maxTracked) return;
      w = { start: now, count: 0 };
      this.sources.set(from, w);
    }
    if (now - w.start >= 1000) {
      w.start = now;
      w.count = 0;
    }
    if (++w.count > this.maxPerSource) return;
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (++this.windowCount > MAX_PACKETS_PER_SECOND) return;
    const msg = decodeMessage(data);
    if (msg === null) return;
    // Responses and probes (queries that propose records) only count from the mDNS port (RFC 6762 11): a legacy
    // unicast asker can neither claim a conflict nor push the box to another number.
    if ((isResponse(msg) || msg.authorities.length > 0) && fromPort !== this.peerPort) return;

    const wasReprobing = c.reprobing;
    this.handle(c.onMessage(msg, now));
    this.reschedule();
    // M1: a forged response sends a held name to a re-probe; say so once a minute, not at every ten seconds
    if (!wasReprobing && c.reprobing && now - this.lastReprobeLog >= 60_000) {
      this.lastReprobeLog = now;
      this.log('mdns: another host answered for our name, checking it again');
    }
    if (!c.answering || isResponse(msg)) return;
    this.answer(iface, msg, from, fromPort);
  }

  private answer(iface: IfaceAddr, msg: DnsMessage, from: string, fromPort: number): void {
    const id = this.identity();
    if (id === null) return;
    const reply = replyTo(id, iface.addr, msg, fromPort !== this.peerPort);
    if (reply === null) return;
    // A defence against a probe is always multicast (unless the asker is a legacy non-5353 one): a unicast answer to
    // port 5353 reaches only one of the sockets sharing it (Windows' own DNS client may hold it), and the prober
    // could miss the conflict.
    const isProbe = msg.authorities.length > 0;
    // while the name is not advertised only a probe of it is answered (the defence)
    if (!this.advertise && !isProbe) return;
    if (reply.unicast && (!isProbe || fromPort !== this.peerPort)) this.sendTo(reply.message, from, fromPort, fromPort !== this.peerPort ? LEGACY_MAX_BYTES : undefined);
    else this.send(iface, reply.message);
  }

  private send(r: IfaceAddr, m: DnsMessage): void {
    try {
      this.transport.sendMulticast(r, encodeMessage(m));
    } catch (error) {
      this.log(`mdns send failed: ${(error as Error).name}`);
    }
  }

  private sendTo(m: DnsMessage, to: string, toPort: number, maxBytes?: number): void {
    try {
      const data = encodeMessage(m);
      // a reply to a legacy asker that would be large is dropped: a forged source must not gain a big reflection
      if (maxBytes !== undefined && data.length > maxBytes) return;
      this.transport.sendUnicast(data, to, toPort);
    } catch (error) {
      this.log(`mdns send failed: ${(error as Error).name}`);
    }
  }

  /** Joins the group on each interface; throws when there were interfaces to join and none could be joined. */
  private joinAll(list: IfaceAddr[]): void {
    let joined = 0;
    let last: Error | null = null;
    for (const r of list) {
      try {
        this.transport.join(r);
        joined++;
      } catch (error) {
        last = error as Error;
        this.log(`mdns join failed: ${last.name}`);
      }
    }
    if (list.length > 0 && joined === 0) throw new Error(`join failed${last === null ? '' : ` (${last.name})`}`);
  }

  private leave(r: IfaceAddr): void {
    try {
      this.transport.leave(r);
    } catch {
      /* the interface may be gone */
    }
  }
}

/** The few members of a dgram socket the transport uses; a test swaps in a fake that defers its sends like the real one. */
export interface UdpSocketLike {
  on(event: 'error', fn: (e: NodeJS.ErrnoException) => void): unknown;
  on(event: 'message', fn: (msg: Buffer, rinfo: { address: string; port: number }) => void): unknown;
  once(event: 'listening', fn: () => void): unknown;
  bind(port: number, host: string): unknown;
  address(): { port: number };
  setMulticastTTL(n: number): unknown;
  setMulticastLoopback(on: boolean): unknown;
  setMulticastInterface(addr: string): unknown;
  addMembership(group: string, iface: string): unknown;
  dropMembership(group: string, iface: string): unknown;
  send(data: Buffer, port: number, address: string, cb: (error: Error | null) => void): unknown;
  close(): unknown;
}

/** How long a close waits for the queued sends (the goodbyes) before it closes anyway. */
const CLOSE_WAIT_MS = 1000;

/**
 * The real transport: one UDP socket on 0.0.0.0:<port>, address reuse on so that another mDNS service on the PC
 * (Bonjour, the Windows DNS client) keeps working beside it. Multicast goes out of the interface named by its
 * address, from the mDNS port itself (peers drop an mDNS response from any other source port).
 *
 * The outgoing interface is a property of the socket, and Node sends a datagram on a later tick. So the multicast
 * sends run ONE AT A TIME: pick the interface, send to the numeric group address, and only when the send callback has
 * fired pick the next one. Otherwise every packet of a loop over the interfaces would leave by the last interface.
 * `close()` waits for the queued sends (the goodbye packets) before it closes the socket.
 */
export class UdpTransport implements MdnsTransport {
  private socket: UdpSocketLike | null = null;
  /** The port actually bound (differs from the asked one only when that was 0). */
  localPort = -1;

  private readonly port: number;
  private readonly multicast: boolean;
  private readonly host: string;
  private readonly factory: () => UdpSocketLike;
  private queue: { iface: IfaceAddr; data: Buffer }[] = [];
  private sending = false;
  private closing: (() => void) | null = null;

  constructor(port: number = MDNS_PORT, multicast: boolean = true, host: string = '0.0.0.0', factory?: () => UdpSocketLike) {
    this.port = port;
    this.multicast = multicast;
    this.host = host;
    this.factory = factory ?? ((): UdpSocketLike => createSocket({ type: 'udp4', reuseAddr: true }) as unknown as UdpSocketLike);
  }

  open(h: TransportHandlers): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const s = this.factory();
      let opened = false;
      s.on('error', (error: NodeJS.ErrnoException) => {
        if (!opened) {
          try {
            s.close();
          } catch {
            /* never bound */
          }
          reject(error);
        } else {
          h.onError(error.code ?? error.name);
        }
      });
      s.on('message', (msg, rinfo) => {
        try {
          h.onPacket(Buffer.from(msg), rinfo.address, rinfo.port);
        } catch {
          /* a packet never ends the process */
        }
      });
      s.once('listening', () => {
        try {
          if (this.multicast) {
            s.setMulticastTTL(255);
            s.setMulticastLoopback(true);
          }
          this.localPort = s.address().port;
          opened = true;
          this.socket = s;
          this.queue = [];
          this.sending = false;
          this.closing = null;
          resolve();
        } catch (error) {
          try {
            s.close();
          } catch {
            /* closing anyway */
          }
          reject(error);
        }
      });
      try {
        s.bind(this.port, this.host);
      } catch (error) {
        reject(error);
      }
    });
  }

  join(iface: IfaceAddr): void {
    if (!this.multicast) return;
    this.socket?.addMembership(MDNS_GROUP, iface.addr);
  }

  leave(iface: IfaceAddr): void {
    if (!this.multicast) return;
    this.socket?.dropMembership(MDNS_GROUP, iface.addr);
  }

  sendMulticast(iface: IfaceAddr, data: Buffer): void {
    if (this.socket === null || !this.multicast || this.closing !== null) return;
    this.queue.push({ iface, data });
    this.pump();
  }

  /** Sends the next queued multicast datagram; the one after it only when this one's callback has fired. */
  private pump(): void {
    const s = this.socket;
    if (s === null || this.sending) return;
    const next = this.queue.shift();
    if (next === undefined) {
      this.finishClose();
      return;
    }
    this.sending = true;
    let called = false;
    const done = (): void => {
      if (called) return;
      called = true;
      this.sending = false;
      this.pump();
    };
    try {
      s.setMulticastInterface(next.iface.addr);
      s.send(next.data, MDNS_PORT, MDNS_GROUP, done);
    } catch {
      done();
    }
  }

  sendUnicast(data: Buffer, addr: string, port: number): void {
    if (this.closing !== null) return;
    try {
      this.socket?.send(data, port, addr, () => undefined);
    } catch {
      /* the socket is going away */
    }
  }

  /** Closes the socket once every queued multicast datagram (the goodbyes) has left, or after CLOSE_WAIT_MS. */
  close(): void {
    const s = this.socket;
    if (s === null) return;
    if (this.queue.length === 0 && !this.sending) {
      this.socket = null;
      this.shut(s);
      return;
    }
    if (this.closing !== null) return;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // a later open() may have replaced the socket: touch the shared state only while this one is the current one
      if (this.socket === s) {
        this.socket = null;
        this.queue = [];
        this.sending = false;
        this.closing = null;
      }
      this.shut(s);
    };
    const timer = setTimeout(finish, CLOSE_WAIT_MS);
    timer.unref();
    this.closing = finish;
  }

  private finishClose(): void {
    this.closing?.();
  }

  private shut(s: UdpSocketLike): void {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
}
