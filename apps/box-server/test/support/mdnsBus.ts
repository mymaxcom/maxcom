import type { Clock, IfaceAddr, MdnsTransport, TransportHandlers } from '../../src/mdns/responder.ts';

/** Lets pending promise continuations (a socket that opens, a transport that resolves) run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock that only moves when the test says so; timers fire in time order. */
export class FakeClock implements Clock {
  private t = 1_000;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }
  /** Moves time forward, running every timer that falls due on the way (also the ones they set). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

export interface Sent {
  /** The interface address it left from, or the unicast target. */
  from: string;
  to: string;
  data: Buffer;
  multicast: boolean;
}

/**
 * One virtual LAN: every node that sends multicast is heard by all the others (source = the sender's interface
 * address, port 5353); unicast goes to the node that owns the address. A node may be given a failure to open.
 */
export class MemoryBus {
  private nodes: MemoryNode[] = [];
  readonly log: Sent[] = [];

  node(): MemoryNode {
    const n = new MemoryNode(this);
    this.nodes.push(n);
    return n;
  }

  multicast(sender: MemoryNode, iface: IfaceAddr, data: Buffer): void {
    this.log.push({ from: iface.addr, to: '224.0.0.251', data, multicast: true });
    for (const n of this.nodes) if (n !== sender) n.deliver(data, iface.addr, 5353);
  }

  unicast(sender: MemoryNode, data: Buffer, addr: string, port: number): void {
    this.log.push({ from: sender.source, to: `${addr}:${port}`, data, multicast: false });
    for (const n of this.nodes) if (n !== sender && n.owns(addr)) n.deliver(data, sender.source, 5353);
  }
}

export class MemoryNode implements MdnsTransport {
  private handlers: TransportHandlers | null = null;
  private joined: IfaceAddr[] = [];
  /** Set to make the next open() reject (a port in use). */
  failOpen: Error | null = null;
  opened = 0;
  closed = 0;
  source = '0.0.0.0';

  private readonly bus: MemoryBus;
  constructor(bus: MemoryBus) {
    this.bus = bus;
  }

  open(h: TransportHandlers): Promise<void> {
    if (this.failOpen !== null) return Promise.reject(this.failOpen);
    this.handlers = h;
    this.opened++;
    return Promise.resolve();
  }
  join(iface: IfaceAddr): void {
    this.joined.push(iface);
    this.source = iface.addr;
  }
  leave(iface: IfaceAddr): void {
    this.joined = this.joined.filter((j) => j.addr !== iface.addr);
  }
  sendMulticast(iface: IfaceAddr, data: Buffer): void {
    this.bus.multicast(this, iface, data);
  }
  sendUnicast(data: Buffer, addr: string, port: number): void {
    this.bus.unicast(this, data, addr, port);
  }
  close(): void {
    this.closed++;
    this.handlers = null;
  }
  owns(addr: string): boolean {
    return this.joined.some((j) => j.addr === addr);
  }
  /** A datagram arrives (from anyone: a test also injects forged ones). */
  deliver(data: Buffer, addr: string, port: number): void {
    if (this.handlers !== null && this.joined.length > 0) this.handlers.onPacket(data, addr, port);
  }
  /** Raised by a socket that dies after it was open. */
  die(reason: string): void {
    this.handlers?.onError(reason);
  }
}
