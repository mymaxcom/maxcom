import { dnsKey, DnsType, ipv4Bytes, isResponse } from './codec.ts';
import type { DnsMessage, DnsRecord } from './codec.ts';
import { hostFor, MAX_BOX_NUMBER } from './answerer.ts';

/** What the owner of a NameClaim must do next. */
export type ClaimAction =
  /** Send a probe (a query for the host, type ANY, with our A records in the authority section) on every interface. */
  | { type: 'probe'; host: string }
  /** The name is ours: persist n and announce the records (twice, one second apart). */
  | { type: 'claimed'; n: number }
  /** Announce again (second announcement, or after a re-probe kept the name). */
  | { type: 'announce'; host: string }
  /** Our name was taken: stop answering for oldHost (send goodbyes) before probing the next number. */
  | { type: 'lost'; oldHost: string }
  /** All 99 names are taken: advertise nothing, IP access only. */
  | { type: 'exhausted' }
  /** A confirmed conflict wanted a new number but the 24 hour renumber cap is used up: the name host is kept. */
  | { type: 'renumberDenied'; host: string };

export type ClaimState = 'idle' | 'waiting' | 'probing' | 'claimed' | 'exhausted';

export const PROBES = 3;
export const PROBE_GAP_MS = 250;
export const ANNOUNCE_GAP_MS = 1000;
export const INITIAL_JITTER_MS = 250;
export const RENUMBER_GAP_MS = 60_000;
export const REPROBE_GAP_MS = 10_000;
export const STORM_COUNT = 15;
export const STORM_WINDOW_MS = 10_000;
export const STORM_PAUSE_MS = 5_000;

function compareBytes(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function compareLists(a: number[][], b: number[][]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = compareBytes(a[i]!, b[i]!);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * RFC 6762 probing, claiming and defending of `boxN-surau.local` as a pure state machine: no sockets, no timers, no
 * clock of its own. The owner passes the time in milliseconds and feeds in the messages it hears. Same rules as the
 * Android box (core/mdns/NameClaim.kt):
 *
 * - `start` and `restart` begin probing at the persisted number: a random 0..250 ms wait, then three probes 250 ms
 *   apart, then 250 ms more; with no conflict the name is claimed and announced twice.
 * - A response that carries our host name with an address that is not ours, or a simultaneous probe that wins the
 *   tiebreak against ours (lexicographically later address data), makes us take the next number (never a lower one).
 * - Records with TTL 0 (goodbyes) never count as a conflict.
 * - After the claim, a conflicting response only triggers a re-probe of the same name (at most one per 10 s); the
 *   name moves only if a conflicting response answers one of OUR probes of that re-probe (RFC 6762 8.1/9), so one
 *   spoofed packet cannot move it.
 * - Every real renumber asks `renumberGate` first (the owner keeps a persisted cap, 3 per 24 h); when it says no the
 *   name is kept ('renumberDenied') and conflicts are ignored for 60 s.
 * - Flap guard: after the first claim at most one renumber per 60 s; 15 conflicts within 10 s pause the machine for
 *   5 s. Before the first claim (boot) a renumber is not delayed by the 60 s rule.
 * - At 99 with no free name the state is 'exhausted'.
 */
export class NameClaim {
  state: ClaimState = 'idle';
  n: number;
  /** Asked at the moment a renumber is decided; true allows it (and the owner records it), false keeps the name. */
  renumberGate: () => boolean = () => true;

  private readonly startNumber: number;
  /** Our IPv4 addresses (dotted), all interfaces; set by the owner before start. */
  private addrs: string[] = [];
  private nextAt = 0;
  private probesSent = 0;
  private announcesLeft = 0;
  private reprobe = false;
  private everClaimed = false;
  private lastRenumberAt = Number.NEGATIVE_INFINITY;
  private conflicts: number[] = [];
  private reprobeNotBefore = Number.NEGATIVE_INFINITY;
  private quietUntil = Number.NEGATIVE_INFINITY;

  private readonly random: (bound: number) => number;

  constructor(startN: number, random: (bound: number) => number) {
    this.random = random;
    this.n = Math.min(Math.max(Math.trunc(startN) || 1, 1), MAX_BOX_NUMBER);
    this.startNumber = this.n;
  }

  get host(): string {
    return hostFor(this.n);
  }

  /** True while the box may answer queries for its name. */
  get claimed(): boolean {
    return this.state === 'claimed';
  }

  /**
   * True while the box answers queries for its name: claimed, or re-probing a name it already held (M1). One forged
   * response only makes the box look again; until a conflict is confirmed the name stays resolvable.
   */
  get answering(): boolean {
    return this.state === 'claimed' || (this.state === 'probing' && this.reprobe && this.everClaimed);
  }

  /** True when the last message heard started a re-probe of a held name (the owner logs it). */
  get reprobing(): boolean {
    return this.state === 'probing' && this.reprobe && this.everClaimed;
  }

  setAddresses(list: string[]): void {
    this.addrs = [...list];
  }

  /** Begin (or begin again after a network change) probing at the current number. */
  start(now: number): ClaimAction[] {
    if (this.state === 'exhausted') this.n = this.startNumber;
    this.beginProbing(now, false);
    return [];
  }

  restart(now: number): ClaimAction[] {
    return this.start(now);
  }

  /** Stop claiming (no network); the number is kept for the next start. */
  stop(): void {
    this.state = 'idle';
    this.announcesLeft = 0;
    this.reprobe = false;
  }

  /** The earliest time `tick` has work, or null when nothing is pending. */
  nextDeadline(): number | null {
    switch (this.state) {
      case 'waiting':
      case 'probing':
        return this.nextAt;
      case 'claimed':
        return this.announcesLeft > 0 ? this.nextAt : null;
      default:
        return null;
    }
  }

  tick(now: number): ClaimAction[] {
    const out: ClaimAction[] = [];
    if (this.state === 'waiting') {
      if (now >= this.nextAt) this.beginProbing(now, true);
    } else if (this.state === 'probing') {
      if (now >= this.nextAt) {
        if (this.probesSent < PROBES) {
          this.probesSent++;
          this.nextAt = now + PROBE_GAP_MS;
          out.push({ type: 'probe', host: this.host });
        } else {
          this.state = 'claimed';
          this.everClaimed = true;
          this.announcesLeft = 1;
          this.nextAt = now + ANNOUNCE_GAP_MS;
          out.push({ type: 'claimed', n: this.n });
          out.push({ type: 'announce', host: this.host });
          if (this.reprobe) this.reprobe = false;
        }
      }
    } else if (this.state === 'claimed') {
      if (this.announcesLeft > 0 && now >= this.nextAt) {
        this.announcesLeft--;
        out.push({ type: 'announce', host: this.host });
      }
    }
    return out;
  }

  /** A message heard on the wire. The owner drops packets that came from our own addresses first. */
  onMessage(msg: DnsMessage, now: number): ClaimAction[] {
    if (this.state !== 'probing' && this.state !== 'claimed') return [];
    if (now < this.quietUntil) return [];
    const key = dnsKey(this.host);
    if (isResponse(msg)) {
      // TTL 0 is a goodbye: the sender gives the name up, it never contests ours
      const theirs = [...msg.answers, ...msg.additionals].filter((r) => r.type === DnsType.A && r.ttl > 0 && dnsKey(r.name) === key);
      if (theirs.length === 0) return [];
      if (theirs.every((r) => this.isOurs(r))) return [];
      if (this.state === 'claimed') {
        // not confirmed yet: look again, and let only an answer to one of our probes move the name
        if (now < this.reprobeNotBefore) return [];
        this.reprobe = true;
        this.reprobeNotBefore = now + REPROBE_GAP_MS;
        this.beginProbing(now, false);
        return [];
      }
      // a re-probe: only an answer that comes after our first probe of it is a confirmed conflict
      if (this.reprobe && this.probesSent === 0) return [];
      return this.conflict(now);
    }
    // a probe from another host: a query naming our host with proposed records in the authority section
    if (this.state === 'probing' && !this.reprobe && msg.questions.some((q) => dnsKey(q.name) === key)) {
      const theirs = msg.authorities.filter((r) => r.type === DnsType.A && dnsKey(r.name) === key);
      if (theirs.length === 0) return [];
      if (theirs.every((r) => this.isOurs(r))) return [];
      return this.loses(theirs) ? this.conflict(now) : [];
    }
    return [];
  }

  private isOurs(r: DnsRecord): boolean {
    return r.data.kind === 'A' && this.addrs.includes(r.data.addr);
  }

  /** RFC 6762 8.2: the host whose data sorts later wins; we lose when ours sorts earlier. */
  private loses(theirs: DnsRecord[]): boolean {
    const toBytes = (list: string[]): number[][] =>
      list.map((a) => ipv4Bytes(a)).filter((b): b is number[] => b !== null).sort(compareBytes);
    const mine = toBytes(this.addrs);
    const other = toBytes(theirs.map((r) => (r.data.kind === 'A' ? r.data.addr : '')));
    return compareLists(mine, other) < 0;
  }

  private conflict(now: number): ClaimAction[] {
    const out: ClaimAction[] = [];
    this.conflicts.push(now);
    while (this.conflicts.length > 0 && now - this.conflicts[0]! > STORM_WINDOW_MS) this.conflicts.shift();
    const storm = this.conflicts.length >= STORM_COUNT;
    const old = this.host;
    if (this.n < MAX_BOX_NUMBER && !this.renumberGate()) {
      // the persisted cap is used up: keep the name (spoofing must not walk the box through the numbers)
      this.reprobe = false;
      this.quietUntil = now + RENUMBER_GAP_MS;
      this.state = 'claimed';
      this.everClaimed = true;
      this.announcesLeft = 1;
      this.nextAt = now + ANNOUNCE_GAP_MS;
      out.push({ type: 'renumberDenied', host: old });
      out.push({ type: 'claimed', n: this.n });
      out.push({ type: 'announce', host: old });
      return out;
    }
    if (this.everClaimed) out.push({ type: 'lost', oldHost: old });
    if (this.n >= MAX_BOX_NUMBER) {
      this.state = 'exhausted';
      this.nextAt = 0;
      out.push({ type: 'exhausted' });
      return out;
    }
    this.n++;
    this.reprobe = false;
    let wait = 0;
    if (this.everClaimed && this.lastRenumberAt !== Number.NEGATIVE_INFINITY) wait = Math.max(wait, this.lastRenumberAt + RENUMBER_GAP_MS - now);
    if (storm) wait = Math.max(wait, STORM_PAUSE_MS);
    if (this.everClaimed) this.lastRenumberAt = now;
    if (wait > 0) {
      this.state = 'waiting';
      this.nextAt = now + wait;
    } else {
      this.beginProbing(now, false);
    }
    return out;
  }

  private beginProbing(now: number, immediate: boolean): void {
    this.state = 'probing';
    this.probesSent = 0;
    this.announcesLeft = 0;
    this.nextAt = now + (immediate ? 0 : this.random(INITIAL_JITTER_MS + 1));
  }
}
