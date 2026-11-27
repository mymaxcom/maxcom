import { BOX_NAME_RE } from '../boxName.ts';
import { dnsKey, DnsType, FLAG_RESPONSE_AUTHORITATIVE, isResponse, rdataEquals, responseMessage } from './codec.ts';
import type { DnsMessage, DnsRecord, RData } from './codec.ts';

export const MAX_BOX_NUMBER = 99;
export const SERVICE = '_maxcom._tcp.local';
export const SERVICE_ENUM = '_services._dns-sd._udp.local';
/** The default HTTPS port of the box, named in the SRV record; a box on another port passes its own to MdnsIdentity. */
export const SERVICE_PORT = 8443;
/** A legacy (non-5353) query with more questions than this is not answered, and its reply stays within LEGACY_MAX_BYTES. */
export const LEGACY_MAX_QUESTIONS = 8;
export const LEGACY_MAX_BYTES = 1400;

export const TTL_HOST = 120;
export const TTL_OTHER = 4500;
const LEGACY_TTL = 10;

/** `box<n>-surau.local`; n must be 1..99. */
export function hostFor(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_BOX_NUMBER) throw new RangeError('box number must be 1..99');
  return `box${n}-surau.local`;
}

/** The number in an exact, lower-case `boxN-surau.local`, or null for anything else. */
export function parseHost(name: string): number | null {
  const m = BOX_NAME_RE.exec(name);
  return m === null ? null : Number(m[1]);
}

const HEX16 = /^[0-9a-f]{16}$/;

/** What a box says about itself in DNS-SD. boxId and caShort are public hints and may be unknown. */
export class MdnsIdentity {
  readonly host: string;
  readonly instance: string;
  readonly n: number;
  readonly boxId: string | null;
  readonly caShort: string | null;
  /** The HTTPS port the SRV record names: the port the box really listens on. */
  readonly port: number;
  constructor(n: number, boxId: string | null = null, caShort: string | null = null, port: number = SERVICE_PORT) {
    this.n = n;
    this.port = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : SERVICE_PORT;
    this.boxId = boxId;
    this.caShort = caShort;
    this.host = hostFor(n);
    this.instance = `MAXCOM box${n}.${SERVICE}`;
  }

  txt(): RData {
    const strings = ['v=1'];
    if (this.boxId !== null && HEX16.test(this.boxId)) strings.push(`id=${this.boxId}`);
    if (this.caShort !== null && HEX16.test(this.caShort)) strings.push(`ca=${this.caShort}`);
    return { kind: 'TXT', strings };
  }
}

/** A reply to send: unicast to the asker, else multicast. */
export interface MdnsReply {
  message: DnsMessage;
  unicast: boolean;
}

const rec = (name: string, type: number, data: RData, ttl: number, cacheFlush: boolean): DnsRecord => ({ name, type, data, ttl, cacheFlush });

export const hostA = (id: MdnsIdentity, addr: string, ttl = TTL_HOST): DnsRecord => rec(id.host, DnsType.A, { kind: 'A', addr }, ttl, true);
export const hostNsec = (id: MdnsIdentity, ttl = TTL_HOST): DnsRecord => rec(id.host, DnsType.NSEC, { kind: 'NSEC', next: id.host, types: [DnsType.A] }, ttl, true);
export const ptrRecord = (id: MdnsIdentity, ttl = TTL_OTHER): DnsRecord => rec(SERVICE, DnsType.PTR, { kind: 'PTR', target: id.instance }, ttl, false);
export const srvRecord = (id: MdnsIdentity, ttl = TTL_HOST): DnsRecord => rec(id.instance, DnsType.SRV, { kind: 'SRV', priority: 0, weight: 0, port: id.port, target: id.host }, ttl, true);
export const txtRecord = (id: MdnsIdentity, ttl = TTL_OTHER): DnsRecord => rec(id.instance, DnsType.TXT, id.txt(), ttl, true);
export const enumPtr = (ttl = TTL_OTHER): DnsRecord => rec(SERVICE_ENUM, DnsType.PTR, { kind: 'PTR', target: SERVICE }, ttl, false);

/** Every record, for an announcement; ttlZero makes it the goodbye (TTL 0). */
export function allRecords(id: MdnsIdentity, addr: string, ttlZero = false): DnsRecord[] {
  const list = [hostA(id, addr), hostNsec(id), ptrRecord(id), srvRecord(id), txtRecord(id), enumPtr()];
  return ttlZero ? list.map((r) => ({ ...r, ttl: 0 })) : list;
}

export const announcement = (id: MdnsIdentity, addr: string): DnsMessage => responseMessage(allRecords(id, addr));
export const goodbye = (id: MdnsIdentity, addr: string): DnsMessage => responseMessage(allRecords(id, addr, true));

/** The probe for a host with our proposed A record in the authority section (RFC 6762 8.1). */
export function probeMessage(host: string, addr: string): DnsMessage {
  return {
    id: 0,
    flags: 0,
    questions: [{ name: host, type: DnsType.ANY, unicastResponse: false }],
    answers: [],
    authorities: [rec(host, DnsType.A, { kind: 'A', addr }, TTL_HOST, false)],
    additionals: [],
  };
}

function sameRecord(a: DnsRecord, b: DnsRecord): boolean {
  return dnsKey(a.name) === dnsKey(b.name) && a.type === b.type && rdataEquals(a.data, b.data);
}

/**
 * The answer to a query for a box that owns its name (the caller asks only while the name is claimed), or null when
 * the query asks for nothing of ours. The box answers for ITS OWN names only: its host name, the DNS-SD service
 * type, its instance and the service enumeration. `legacy` is true for a query from a source port other than 5353:
 * the reply is then unicast, echoes the id and only the questions it answered, has TTL at most 10 and no cache-flush bit.
 */
export function replyTo(id: MdnsIdentity, addr: string, query: DnsMessage, legacy: boolean): MdnsReply | null {
  if (isResponse(query) || query.questions.length === 0) return null;
  // A legacy asker may be a forged source: a query with many questions is refused outright (reflection guard).
  if (legacy && query.questions.length > LEGACY_MAX_QUESTIONS) return null;
  const host = dnsKey(id.host);
  const instance = dnsKey(id.instance);
  const answers: DnsRecord[] = [];
  const extra: DnsRecord[] = [];
  let answeredQuestions = 0;
  let allQu = true;
  const answeredQs: typeof query.questions = [];
  const add = (into: DnsRecord[], r: DnsRecord): void => {
    if (!into.some((x) => sameRecord(x, r))) into.push(r);
  };

  for (const q of query.questions) {
    const name = dnsKey(q.name);
    const before = answers.length;
    const any = q.type === DnsType.ANY;
    if (name === host) {
      if (any || q.type === DnsType.A) add(answers, hostA(id, addr));
      if (any || q.type === DnsType.AAAA || q.type === DnsType.NSEC) add(answers, hostNsec(id));
      if (q.type === DnsType.A) add(extra, hostNsec(id));
    } else if (name === dnsKey(SERVICE)) {
      if (any || q.type === DnsType.PTR) {
        add(answers, ptrRecord(id));
        add(extra, srvRecord(id));
        add(extra, txtRecord(id));
        add(extra, hostA(id, addr));
        add(extra, hostNsec(id));
      }
    } else if (name === dnsKey(SERVICE_ENUM)) {
      if (any || q.type === DnsType.PTR) add(answers, enumPtr());
    } else if (name === instance) {
      if (any || q.type === DnsType.SRV) {
        add(answers, srvRecord(id));
        add(extra, hostA(id, addr));
        add(extra, hostNsec(id));
      }
      if (any || q.type === DnsType.TXT) add(answers, txtRecord(id));
    }
    if (answers.length > before) {
      answeredQuestions++;
      answeredQs.push(q);
      if (!q.unicastResponse) allQu = false;
    }
  }
  if (answers.length === 0) return null;

  // Known-answer suppression (RFC 6762 7.1): the asker already holds this record with more than half its TTL left.
  for (const known of query.answers) {
    for (let i = answers.length - 1; i >= 0; i--) {
      const mine = answers[i]!;
      if (sameRecord(mine, known) && known.ttl * 2 >= mine.ttl) answers.splice(i, 1);
    }
  }
  if (answers.length === 0) return null;
  const ex = extra.filter((e) => !answers.some((a) => sameRecord(a, e)));

  if (legacy) {
    const legacyRec = (r: DnsRecord): DnsRecord => ({ ...r, ttl: Math.min(r.ttl, LEGACY_TTL), cacheFlush: false });
    return {
      message: { id: query.id, flags: FLAG_RESPONSE_AUTHORITATIVE, questions: answeredQs, answers: answers.map(legacyRec), authorities: [], additionals: ex.map(legacyRec) },
      unicast: true,
    };
  }
  return { message: responseMessage(answers, ex), unicast: allQu && answeredQuestions > 0 };
}
