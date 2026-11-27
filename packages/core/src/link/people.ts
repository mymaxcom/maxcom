/** The people part of linking two boxes (phase 2C): the list each box sends, and the merge rules both boxes and the
 *  app compute alike. No I/O. Security code: the merge creates accounts with roles on the master, so every rule that
 *  can raise a role lives here, in one place, and a role is raised only by an explicit answer. */

import type { Role } from '../auth/permissions.ts';
import { OPS_ROLES, isRole } from '../auth/permissions.ts';
import { canonicalJson, sha256Hex } from '../sync/canonical.ts';

/** One person as a box tells the other box about them. No PIN hash, no device key, no history. */
export interface LinkPerson {
  /** The person's id on their own box. */
  id: string;
  name: string;
  /** E.164, or null. */
  phone: string | null;
  /** Never an ops role (`superadmin`, `support`). */
  roles: Role[];
  /** Live enrolled phones of this person on their own box (a ticket is made only for someone with a phone). */
  devices: number;
}

export const MAX_LINK_PEOPLE = 500;
// OPS_ROLES (permissions.ts): roles that never cross between boxes; the Pentadbir MAXCOM and support are not people of a surau.
/** A role that may administer the surau: whoever holds one never gets a phone-move ticket. */
export const holdsSurauAdmin = (roles: readonly Role[]): boolean => roles.includes('admin') || roles.includes('superadmin');

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const PERSON_KEYS = ['id', 'name', 'phone', 'roles', 'devices'];

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict parse of a list that arrives from the other box. One bad entry and the whole list is refused. */
export function parseLinkPeople(v: unknown): LinkPerson[] | null {
  if (!Array.isArray(v) || v.length > MAX_LINK_PEOPLE) return null;
  const out: LinkPerson[] = [];
  const ids = new Set<string>();
  const phones = new Set<string>();
  for (const p of v) {
    if (!isPlain(p)) return null;
    const keys = Object.keys(p);
    if (keys.length !== PERSON_KEYS.length || !PERSON_KEYS.every((k) => keys.includes(k))) return null;
    if (typeof p.id !== 'string' || !ID_RE.test(p.id) || ids.has(p.id)) return null;
    if (typeof p.name !== 'string' || p.name.trim().length === 0 || p.name.length > 80 || /[\u0000-\u001f\u007f]/.test(p.name)) return null;
    if (p.phone !== null && (typeof p.phone !== 'string' || !PHONE_RE.test(p.phone) || phones.has(p.phone))) return null;
    if (!Array.isArray(p.roles) || p.roles.length > 10) return null;
    const roles: Role[] = [];
    for (const r of p.roles) {
      if (typeof r !== 'string' || !isRole(r) || OPS_ROLES.includes(r) || roles.includes(r)) return null;
      roles.push(r);
    }
    if (typeof p.devices !== 'number' || !Number.isInteger(p.devices) || p.devices < 0 || p.devices > 50) return null;
    ids.add(p.id);
    if (p.phone !== null) phones.add(p.phone);
    out.push({ id: p.id, name: p.name, phone: p.phone, roles, devices: p.devices });
  }
  return out;
}

/** What both boxes hash into the agreement: a consent is for exactly the people both admins were shown. */
export function peopleDigest(list: readonly LinkPerson[]): string {
  const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((p) => ({ ...p, roles: [...p.roles].sort() }));
  return sha256Hex(new TextEncoder().encode(canonicalJson({ p: 'maxcom-link-people-v1', people: sorted })));
}

/** A person of the kept data, as the merge sees them (from the kept box's own database). */
export interface KeptPerson { id: string; name: string; phone: string | null; roles: Role[] }

const sameName = (a: string, b: string): boolean => a.trim().toLocaleLowerCase('ms') === b.trim().toLocaleLowerCase('ms');
const sortedRoles = (r: readonly Role[]): Role[] => [...r].sort();
const eqRoles = (a: readonly Role[], b: readonly Role[]): boolean => sortedRoles(a).join(',') === sortedRoles(b).join(',');

/** What happens to each person of the box whose data is not kept. */
export type MergeStep =
  | { kind: 'create'; person: LinkPerson; roles: Role[] }
  | { kind: 'same-phone'; person: LinkPerson; kept: KeptPerson; rolesAfter: Role[]; added: Role | null }
  | { kind: 'same-name'; person: LinkPerson; kept: KeptPerson };

export interface MergePlan {
  steps: MergeStep[];
  /** Duplicates by phone whose roles differ: the admins may add ONE role of the other box (answers.roles). */
  roleDiffs: { person: LinkPerson; kept: KeptPerson; chosen: Role | null }[];
  /** Same name, no matching phone: the admins say "orang yang sama" (answers.same) or the person is added. */
  nameAsk: { person: LinkPerson; kept: KeptPerson }[];
}

/**
 * The merge, decided from the kept people and the other box's list with the admins' answers. Rules (plan L5):
 * same phone = same person, the kept roles stay unless an answer adds one role the other box gave; same name without
 * a matching phone = added as a new person unless the answers say "same"; everyone else is added with their roles
 * (ops roles never cross). Answers that do not fit the lists are ignored here and refused by `checkPeopleAnswers`.
 */
export function planMerge(kept: readonly KeptPerson[], other: readonly LinkPerson[], answers: { roles: Record<string, string>; same: readonly string[] }): MergePlan {
  const steps: MergeStep[] = [];
  const roleDiffs: MergePlan['roleDiffs'] = [];
  const nameAsk: MergePlan['nameAsk'] = [];
  for (const p of other) {
    const byPhone = p.phone === null ? undefined : kept.find((k) => k.phone === p.phone);
    if (byPhone !== undefined) {
      let added: Role | null = null;
      if (!eqRoles(byPhone.roles, p.roles)) {
        const want = answers.roles[p.phone!];
        if (typeof want === 'string' && isRole(want) && !OPS_ROLES.includes(want) && p.roles.includes(want) && !byPhone.roles.includes(want)) added = want;
        roleDiffs.push({ person: p, kept: byPhone, chosen: added });
      }
      steps.push({ kind: 'same-phone', person: p, kept: byPhone, rolesAfter: added === null ? [...byPhone.roles] : [...byPhone.roles, added], added });
      continue;
    }
    // a kept person with a phone of their own is a different person from one with another phone or none
    const byName = kept.find((k) => sameName(k.name, p.name) && (k.phone === null || p.phone === null));
    if (byName !== undefined) {
      nameAsk.push({ person: p, kept: byName });
      if (answers.same.includes(p.id)) {
        steps.push({ kind: 'same-name', person: p, kept: byName });
        continue;
      }
    }
    steps.push({ kind: 'create', person: p, roles: p.roles.filter((r) => !OPS_ROLES.includes(r)) });
  }
  return { steps, roleDiffs, nameAsk };
}

/** The answers' people parts fit the lists: every role key is a real difference, every "same" is a real question. */
export function checkPeopleAnswers(plan: MergePlan, answers: { roles: Record<string, string>; same: readonly string[] }): boolean {
  for (const [phone, role] of Object.entries(answers.roles)) {
    const d = plan.roleDiffs.find((x) => x.person.phone === phone);
    if (d === undefined || d.chosen !== role) return false;
  }
  for (const id of answers.same) if (!plan.nameAsk.some((x) => x.person.id === id)) return false;
  return new Set(answers.same).size === answers.same.length;
}

/**
 * Whether a merged person gets a phone-move ticket: they had a phone there and are not an administrator after, unless
 * the admins chose 'direct' (every person with a phone, admins included). An ops holder never does.
 */
export function getsTicket(step: MergeStep, phones: 'direct' | 'code' = 'code'): boolean {
  if (step.kind === 'same-name') return false;
  const roles = step.kind === 'create' ? step.roles : step.rolesAfter;
  return step.person.devices > 0 && (phones === 'direct' || !holdsSurauAdmin(roles)) && !roles.some((r) => OPS_ROLES.includes(r));
}

/** The questions screen's people part. Phone numbers never leave the box whole: only the last four digits. */
export interface LinkPeopleView {
  add: { id: string; name: string; roles: Role[] }[];
  same: { id: string; name: string; keptName: string; keptRoles: Role[]; rolesAfter: Role[] }[];
  roleDiffs: { phone: string; phone4: string; name: string; keptRoles: Role[]; otherRoles: Role[]; chosen: Role | null }[];
  nameAsk: { id: string; name: string; keptName: string; same: boolean }[];
  adminsAfter: string[];
  tickets: number;
}

export function peopleView(kept: readonly KeptPerson[], plan: MergePlan, same: readonly string[], phones: 'direct' | 'code' = 'code'): LinkPeopleView {
  const admins = new Set<string>(kept.filter((k) => holdsSurauAdmin(k.roles)).map((k) => k.name));
  for (const s of plan.steps) {
    const roles = s.kind === 'create' ? s.roles : s.kind === 'same-phone' ? s.rolesAfter : s.kept.roles;
    if (holdsSurauAdmin(roles)) admins.add(s.kind === 'create' ? s.person.name : s.kept.name);
  }
  return {
    add: plan.steps.filter((s): s is Extract<MergeStep, { kind: 'create' }> => s.kind === 'create').map((s) => ({ id: s.person.id, name: s.person.name, roles: s.roles })),
    same: plan.steps
      .filter((s): s is Extract<MergeStep, { kind: 'same-phone' }> => s.kind === 'same-phone')
      .map((s) => ({ id: s.person.id, name: s.person.name, keptName: s.kept.name, keptRoles: s.kept.roles, rolesAfter: s.rolesAfter })),
    // the full phone is the key the app sends back in answers.roles; it is the number the admins already manage
    roleDiffs: plan.roleDiffs.map((d) => ({ phone: d.person.phone!, phone4: d.person.phone!.slice(-4), name: d.person.name, keptRoles: d.kept.roles, otherRoles: d.person.roles, chosen: d.chosen })),
    nameAsk: plan.nameAsk.map((n) => ({ id: n.person.id, name: n.person.name, keptName: n.kept.name, same: same.includes(n.person.id) })),
    adminsAfter: [...admins].sort(),
    tickets: plan.steps.filter((s) => getsTicket(s, phones)).length,
  };
}
