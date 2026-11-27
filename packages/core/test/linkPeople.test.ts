import { describe, expect, it } from 'vitest';
import type { Role } from '../src/auth/permissions.ts';
import {
  checkPeopleAnswers, getsTicket, holdsSurauAdmin, parseLinkPeople, peopleDigest, peopleView, planMerge,
} from '../src/link/people.ts';
import type { KeptPerson, LinkPerson } from '../src/link/people.ts';

// phones only from the range the existing tests use (see publicNames.test.ts)
const P1 = '+60120000001';
const P2 = '+60120000002';
const P3 = '+60120000003';

const person = (id: string, over: Partial<LinkPerson> = {}): LinkPerson => ({ id, name: 'Aminah Binti Ali', phone: null, roles: ['ajk'], devices: 0, ...over });
const kept = (id: string, over: Partial<KeptPerson> = {}): KeptPerson => ({ id, name: 'Aminah Binti Ali', phone: null, roles: ['ajk'], ...over });
const none = { roles: {}, same: [] as string[] };

describe('parseLinkPeople', () => {
  it('accepts the empty list and a normal list', () => {
    expect(parseLinkPeople([])).toEqual([]);
    const list = [person('person-0001', { phone: P1, devices: 2 }), person('person-0002', { name: 'Rahim', roles: ['admin', 'media'] })];
    expect(parseLinkPeople(list)).toEqual(list);
  });

  it('refuses anything that is not a list', () => {
    for (const v of [null, undefined, {}, 'x', 5]) expect(parseLinkPeople(v)).toBeNull();
  });

  it('refuses an ops role (superadmin and support)', () => {
    expect(parseLinkPeople([person('person-0001', { roles: ['superadmin'] })])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { roles: ['ajk', 'support'] })])).toBeNull();
  });

  it('refuses a role that does not exist and a repeated role', () => {
    expect(parseLinkPeople([{ ...person('person-0001'), roles: ['tukang'] }])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { roles: ['ajk', 'ajk'] })])).toBeNull();
  });

  it('refuses two people with the same id', () => {
    expect(parseLinkPeople([person('person-0001'), person('person-0001', { name: 'Rahim' })])).toBeNull();
  });

  it('refuses two people with the same phone', () => {
    expect(parseLinkPeople([person('person-0001', { phone: P1 }), person('person-0002', { name: 'Rahim', phone: P1 })])).toBeNull();
  });

  it('accepts several people with no phone', () => {
    expect(parseLinkPeople([person('person-0001'), person('person-0002', { name: 'Rahim' })])).not.toBeNull();
  });

  it('refuses a bad phone', () => {
    for (const phone of ['0123456789', '+0123456789', '+6012', 'abc', '+ 6O12 abc', '']) {
      expect(parseLinkPeople([person('person-0001', { phone })]), phone).toBeNull();
    }
  });

  it('refuses a name with a control character, an empty name and a name over 80 characters', () => {
    expect(parseLinkPeople([person('person-0001', { name: 'Ami\u0000nah' })])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { name: 'Ami\nnah' })])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { name: 'Ami\u007fnah' })])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { name: '   ' })])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { name: 'a'.repeat(81) })])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { name: 'a'.repeat(80) })])).not.toBeNull();
  });

  it('refuses a bad id and a bad device count', () => {
    expect(parseLinkPeople([person('short')])).toBeNull();
    expect(parseLinkPeople([person('has space here')])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { devices: -1 })])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { devices: 51 })])).toBeNull();
    expect(parseLinkPeople([person('person-0001', { devices: 1.5 })])).toBeNull();
  });

  it('refuses more than 500 people and accepts exactly 500', () => {
    const many = (n: number): LinkPerson[] => Array.from({ length: n }, (_, i) => person(`person-${String(i).padStart(6, '0')}`, { name: `Orang ${i}` }));
    expect(parseLinkPeople(many(500))).toHaveLength(500);
    expect(parseLinkPeople(many(501))).toBeNull();
  });

  it('refuses an extra key and a missing key', () => {
    expect(parseLinkPeople([{ ...person('person-0001'), pinHash: 'x' }])).toBeNull();
    const { devices: _devices, ...short } = person('person-0001');
    expect(parseLinkPeople([short])).toBeNull();
  });
});

describe('peopleDigest', () => {
  const a = person('person-0001', { phone: P1, roles: ['ajk', 'media'], devices: 1 });
  const b = person('person-0002', { name: 'Rahim', roles: ['admin'] });

  it('is a sha256 hex string and the same for any order of people', () => {
    expect(peopleDigest([a, b])).toMatch(/^[0-9a-f]{64}$/);
    expect(peopleDigest([a, b])).toBe(peopleDigest([b, a]));
  });

  it('is the same for any order of roles', () => {
    expect(peopleDigest([{ ...a, roles: ['media', 'ajk'] }, b])).toBe(peopleDigest([a, b]));
  });

  it('changes when any field changes', () => {
    const base = peopleDigest([a, b]);
    const variants: LinkPerson[] = [
      { ...a, id: 'person-0009' }, { ...a, name: 'Aminah' }, { ...a, phone: P2 }, { ...a, phone: null },
      { ...a, roles: ['ajk'] }, { ...a, roles: ['ajk', 'media', 'live'] }, { ...a, devices: 2 }, { ...a, devices: 0 },
    ];
    for (const v of variants) expect(peopleDigest([v, b]), JSON.stringify(v)).not.toBe(base);
  });

  it('changes when a person is added or removed, and the empty list has its own digest', () => {
    expect(peopleDigest([a])).not.toBe(peopleDigest([a, b]));
    expect(peopleDigest([])).toMatch(/^[0-9a-f]{64}$/);
    expect(peopleDigest([])).not.toBe(peopleDigest([a]));
  });
});

describe('planMerge', () => {
  it('same phone with equal roles is one person, no difference listed', () => {
    const plan = planMerge([kept('kept-0001', { phone: P1 })], [person('person-0001', { phone: P1 })], none);
    expect(plan.roleDiffs).toEqual([]);
    expect(plan.nameAsk).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ kind: 'same-phone', added: null, rolesAfter: ['ajk'] });
  });

  it('equal roles in another order are still equal', () => {
    const plan = planMerge([kept('kept-0001', { phone: P1, roles: ['media', 'ajk'] })], [person('person-0001', { phone: P1, roles: ['ajk', 'media'] })], none);
    expect(plan.roleDiffs).toEqual([]);
  });

  it('same phone with different roles keeps the kept roles and lists the difference', () => {
    const plan = planMerge([kept('kept-0001', { phone: P1 })], [person('person-0001', { phone: P1, roles: ['ajk', 'treasurer'] })], none);
    expect(plan.roleDiffs).toHaveLength(1);
    expect(plan.roleDiffs[0]).toMatchObject({ chosen: null });
    expect(plan.roleDiffs[0]!.person.phone).toBe(P1);
    expect(plan.steps[0]).toMatchObject({ kind: 'same-phone', added: null, rolesAfter: ['ajk'] });
  });

  it('an answer adds exactly one role held on the other box', () => {
    const other = [person('person-0001', { phone: P1, roles: ['ajk', 'treasurer', 'media'] })];
    const plan = planMerge([kept('kept-0001', { phone: P1 })], other, { roles: { [P1]: 'treasurer' }, same: [] });
    expect(plan.roleDiffs[0]).toMatchObject({ chosen: 'treasurer' });
    expect(plan.steps[0]).toMatchObject({ kind: 'same-phone', added: 'treasurer', rolesAfter: ['ajk', 'treasurer'] });
  });

  it('an answer naming a role the other box does not give adds nothing', () => {
    const other = [person('person-0001', { phone: P1, roles: ['ajk', 'treasurer'] })];
    const plan = planMerge([kept('kept-0001', { phone: P1 })], other, { roles: { [P1]: 'media' }, same: [] });
    expect(plan.roleDiffs[0]).toMatchObject({ chosen: null });
    expect(plan.steps[0]).toMatchObject({ added: null, rolesAfter: ['ajk'] });
  });

  it('an answer naming an ops role adds nothing, even when the list carries one', () => {
    // a list that did not pass `parseLinkPeople` could carry an ops role; the merge still refuses to raise it
    const other = [person('person-0001', { phone: P1, roles: ['ajk', 'superadmin'] as Role[] })];
    for (const r of ['superadmin', 'support']) {
      const plan = planMerge([kept('kept-0001', { phone: P1 })], other, { roles: { [P1]: r }, same: [] });
      expect(plan.steps[0], r).toMatchObject({ added: null, rolesAfter: ['ajk'] });
    }
  });

  it('an answer for a role the kept person already holds adds nothing', () => {
    const plan = planMerge([kept('kept-0001', { phone: P1, roles: ['ajk', 'treasurer'] })], [person('person-0001', { phone: P1, roles: ['ajk'] })], { roles: { [P1]: 'ajk' }, same: [] });
    expect(plan.roleDiffs).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ added: null, rolesAfter: ['ajk', 'treasurer'] });
  });

  it('an answer for a phone that is not a duplicate is ignored', () => {
    const plan = planMerge([kept('kept-0001', { phone: P1 })], [person('person-0001', { name: 'Rahim', phone: P2, roles: ['ajk', 'treasurer'] })], { roles: { [P2]: 'treasurer' }, same: [] });
    expect(plan.steps[0]).toMatchObject({ kind: 'create', roles: ['ajk', 'treasurer'] });
  });

  it('the same name with no phone match asks, and the default is to create', () => {
    const plan = planMerge([kept('kept-0001')], [person('person-0001', { name: ' aminah binti ALI ' })], none);
    expect(plan.nameAsk).toHaveLength(1);
    expect(plan.nameAsk[0]!.kept.id).toBe('kept-0001');
    expect(plan.steps[0]!.kind).toBe('create');
  });

  it('answering "same" makes it the same person by name', () => {
    const plan = planMerge([kept('kept-0001')], [person('person-0001')], { roles: {}, same: ['person-0001'] });
    expect(plan.nameAsk).toHaveLength(1);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ kind: 'same-name' });
  });

  it('the name question is also asked when only one of the two has a phone', () => {
    const planA = planMerge([kept('kept-0001')], [person('person-0001', { phone: P2 })], none);
    expect(planA.nameAsk).toHaveLength(1);
    const planB = planMerge([kept('kept-0001', { phone: P1 })], [person('person-0001')], none);
    expect(planB.nameAsk).toHaveLength(1);
  });

  it('a kept person and an incoming person with different phones and the same name are two people, no question', () => {
    const plan = planMerge([kept('kept-0001', { phone: P1 })], [person('person-0001', { phone: P2 })], { roles: {}, same: ['person-0001'] });
    expect(plan.nameAsk).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.kind).toBe('create');
  });

  it('everyone else is created, and an ops role never comes with them', () => {
    const other = [
      person('person-0001', { name: 'Rahim', phone: P2, roles: ['ajk', 'support'] as Role[] }),
      person('person-0002', { name: 'Hassan', roles: ['superadmin'] as Role[] }),
      person('person-0003', { name: 'Zainab', roles: [] }),
    ];
    const plan = planMerge([kept('kept-0001', { phone: P1 })], other, none);
    expect(plan.steps.map((s) => s.kind)).toEqual(['create', 'create', 'create']);
    expect(plan.steps.map((s) => (s.kind === 'create' ? s.roles : null))).toEqual([['ajk'], [], []]);
  });

  it('a phone match wins over a name match', () => {
    const plan = planMerge([kept('kept-0001', { phone: P1 }), kept('kept-0002', { name: 'Rahim' })], [person('person-0001', { name: 'Rahim', phone: P1 })], none);
    expect(plan.steps[0]).toMatchObject({ kind: 'same-phone' });
    expect(plan.nameAsk).toEqual([]);
  });

  it('plans every person of the other list, in its order', () => {
    const other = [person('person-0003', { name: 'C' }), person('person-0001', { name: 'A' }), person('person-0002', { name: 'B' })];
    const plan = planMerge([], other, none);
    expect(plan.steps.map((s) => s.person.id)).toEqual(['person-0003', 'person-0001', 'person-0002']);
  });
});

describe('checkPeopleAnswers', () => {
  const keptList = [kept('kept-0001', { phone: P1 }), kept('kept-0002', { name: 'Rahim' })];
  const other = [person('person-0001', { phone: P1, roles: ['ajk', 'treasurer'] }), person('person-0002', { name: 'Rahim', roles: ['media'] })];
  const check = (a: { roles: Record<string, string>; same: string[] }): boolean => checkPeopleAnswers(planMerge(keptList, other, a), a);

  it('accepts no answers, a real role difference and a real name question', () => {
    expect(check({ roles: {}, same: [] })).toBe(true);
    expect(check({ roles: { [P1]: 'treasurer' }, same: [] })).toBe(true);
    expect(check({ roles: {}, same: ['person-0002'] })).toBe(true);
    expect(check({ roles: { [P1]: 'treasurer' }, same: ['person-0002'] })).toBe(true);
  });

  it('refuses a role key that is not a difference', () => {
    expect(check({ roles: { [P2]: 'treasurer' }, same: [] })).toBe(false);
    // a duplicate by phone whose roles are equal is not a difference either
    const equal = [person('person-0001', { phone: P1 })];
    const a = { roles: { [P1]: 'ajk' }, same: [] as string[] };
    expect(checkPeopleAnswers(planMerge(keptList, equal, a), a)).toBe(false);
  });

  it('refuses a role that is not the offered one', () => {
    expect(check({ roles: { [P1]: 'media' }, same: [] })).toBe(false);
    expect(check({ roles: { [P1]: 'ajk' }, same: [] })).toBe(false);
    expect(check({ roles: { [P1]: 'superadmin' }, same: [] })).toBe(false);
    expect(check({ roles: { [P1]: 'no-such-role' }, same: [] })).toBe(false);
  });

  it('refuses a same id that was not asked', () => {
    expect(check({ roles: {}, same: ['person-0001'] })).toBe(false);
    expect(check({ roles: {}, same: ['person-9999'] })).toBe(false);
  });

  it('refuses a repeated id', () => {
    expect(check({ roles: {}, same: ['person-0002', 'person-0002'] })).toBe(false);
  });
});

describe('getsTicket', () => {
  const stepOf = (keptList: KeptPerson[], p: LinkPerson, answers: { roles: Record<string, string>; same: string[] } = { roles: {}, same: [] }) =>
    planMerge(keptList, [p], answers).steps[0]!;

  it('a created non-admin with a phone gets one', () => {
    expect(getsTicket(stepOf([], person('person-0001', { devices: 1 })))).toBe(true);
  });

  it('a created person with no phone to move (devices 0) gets none', () => {
    expect(getsTicket(stepOf([], person('person-0001', { devices: 0 })))).toBe(false);
  });

  it('a created admin gets none', () => {
    expect(getsTicket(stepOf([], person('person-0001', { roles: ['admin'], devices: 2 })))).toBe(false);
    expect(getsTicket(stepOf([], person('person-0001', { roles: ['ajk', 'admin'], devices: 2 })))).toBe(false);
  });

  it('a same-phone person who is admin only on the kept side gets none', () => {
    const s = stepOf([kept('kept-0001', { phone: P1, roles: ['admin'] })], person('person-0001', { phone: P1, roles: ['ajk'], devices: 1 }));
    expect(s).toMatchObject({ kind: 'same-phone', rolesAfter: ['admin'] });
    expect(getsTicket(s)).toBe(false);
  });

  it('a same-phone person who becomes admin by an answer gets none', () => {
    const s = stepOf(
      [kept('kept-0001', { phone: P1, roles: ['ajk'] })],
      person('person-0001', { phone: P1, roles: ['ajk', 'admin'], devices: 1 }),
      { roles: { [P1]: 'admin' }, same: [] },
    );
    expect(s).toMatchObject({ rolesAfter: ['ajk', 'admin'] });
    expect(getsTicket(s)).toBe(false);
  });

  it('a same-phone non-admin with a phone gets one', () => {
    const s = stepOf([kept('kept-0001', { phone: P1 })], person('person-0001', { phone: P1, devices: 1 }));
    expect(getsTicket(s)).toBe(true);
  });

  it('a same-phone person whose other-box admin role was not chosen still gets one (kept roles stand)', () => {
    const s = stepOf([kept('kept-0001', { phone: P1 })], person('person-0001', { phone: P1, roles: ['ajk', 'admin'], devices: 1 }));
    expect(s).toMatchObject({ rolesAfter: ['ajk'] });
    expect(getsTicket(s)).toBe(true);
  });

  it('a same-name person gets none, whatever the devices', () => {
    const s = stepOf([kept('kept-0001')], person('person-0001', { devices: 3 }), { roles: {}, same: ['person-0001'] });
    expect(s.kind).toBe('same-name');
    expect(getsTicket(s)).toBe(false);
  });

  it('a person who holds an ops role after the merge never gets one', () => {
    // a list that did not pass `parseLinkPeople`: the created person has the ops role removed, so the ticket check
    // sees a plain person; a kept side holding an ops role is the case this guards
    const s = stepOf([kept('kept-0001', { phone: P1, roles: ['support'] as Role[] })], person('person-0001', { phone: P1, roles: ['ajk'], devices: 1 }));
    expect(getsTicket(s)).toBe(false);
  });

  it('with the choice "direct" an admin gets one too, a same-name person still none, an ops holder never', () => {
    expect(getsTicket(stepOf([], person('person-0001', { roles: ['admin'], devices: 2 })), 'direct')).toBe(true);
    const s = stepOf([kept('kept-0001', { phone: P1, roles: ['admin'] })], person('person-0001', { phone: P1, roles: ['ajk'], devices: 1 }));
    expect(getsTicket(s, 'direct')).toBe(true);
    expect(getsTicket(stepOf([], person('person-0001', { devices: 0 })), 'direct')).toBe(false);
    const sn = stepOf([kept('kept-0001')], person('person-0001', { devices: 3 }), { roles: {}, same: ['person-0001'] });
    expect(getsTicket(sn, 'direct')).toBe(false);
    const ops = stepOf([kept('kept-0001', { phone: P1, roles: ['support'] as Role[] })], person('person-0001', { phone: P1, roles: ['ajk'], devices: 1 }));
    expect(getsTicket(ops, 'direct')).toBe(false);
  });

  it('holdsSurauAdmin is true for admin and superadmin only', () => {
    expect(holdsSurauAdmin(['admin'])).toBe(true);
    expect(holdsSurauAdmin(['ajk', 'superadmin'])).toBe(true);
    expect(holdsSurauAdmin(['ajk', 'media', 'support'])).toBe(false);
  });
});

describe('peopleView', () => {
  const keptList = [
    kept('kept-0001', { name: 'Zaid', phone: P1, roles: ['admin'] }),
    kept('kept-0002', { name: 'Ali', phone: P2, roles: ['ajk'] }),
    kept('kept-0003', { name: 'Rahim', phone: null, roles: ['media'] }),
  ];
  const other = [
    person('person-0001', { name: 'Zaid Lain', phone: P1, roles: ['ajk', 'admin'], devices: 1 }),
    person('person-0002', { name: 'Ali', phone: P2, roles: ['ajk', 'admin', 'treasurer'], devices: 1 }),
    person('person-0003', { name: 'Aini', phone: P3, roles: ['admin'], devices: 1 }),
    person('person-0004', { name: 'Hassan', roles: ['live'], devices: 2 }),
    person('person-0005', { name: 'Rahim', roles: ['media'], devices: 1 }),
  ];
  const viewWith = (a: { roles: Record<string, string>; same: string[] }) => peopleView(keptList, planMerge(keptList, other, a), a.same);

  it('lists who is added, who is the same, the role differences and the name questions', () => {
    const v = viewWith(none);
    expect(v.add.map((x) => x.name).sort()).toEqual(['Aini', 'Hassan', 'Rahim']);
    expect(v.same.map((x) => x.keptName).sort()).toEqual(['Ali', 'Zaid']);
    expect(v.roleDiffs.map((x) => x.name).sort()).toEqual(['Ali', 'Zaid Lain']);
    expect(v.nameAsk).toEqual([{ id: 'person-0005', name: 'Rahim', keptName: 'Rahim', same: false }]);
  });

  it('adminsAfter lists the kept admins, the created admins and the people an answer made admin, sorted', () => {
    expect(viewWith(none).adminsAfter).toEqual(['Aini', 'Zaid']);
    expect(viewWith({ roles: { [P2]: 'admin' }, same: [] }).adminsAfter).toEqual(['Aini', 'Ali', 'Zaid']);
  });

  it('tickets counts the non-admins with a phone to move', () => {
    // Ali (same phone, stays non-admin), Hassan and Rahim (created); not Zaid (admin), Aini (admin)
    expect(viewWith(none).tickets).toBe(3);
    // Ali becomes admin by the answer: no ticket for Ali; Rahim marked the same person: no ticket for Rahim
    expect(viewWith({ roles: { [P2]: 'admin' }, same: ['person-0005'] }).tickets).toBe(1);
  });

  it('tickets counts the admins too under the choice "direct"', () => {
    const v = (a: { roles: Record<string, string>; same: string[] }) => peopleView(keptList, planMerge(keptList, other, a), a.same, 'direct');
    // Zaid, Ali, Aini, Hassan, Rahim all have a phone; none is the same-name one
    expect(v(none).tickets).toBe(5);
    expect(v({ roles: {}, same: ['person-0005'] }).tickets).toBe(4);
  });

  it('a name question shows whether the admins marked it', () => {
    expect(viewWith({ roles: {}, same: ['person-0005'] }).nameAsk[0]).toMatchObject({ same: true });
  });

  it('shows the roles the merge ends with for a same-phone person', () => {
    const v = viewWith({ roles: { [P2]: 'treasurer' }, same: [] });
    expect(v.same.find((x) => x.keptName === 'Ali')).toMatchObject({ keptRoles: ['ajk'], rolesAfter: ['ajk', 'treasurer'] });
    expect(v.roleDiffs.find((x) => x.name === 'Ali')).toMatchObject({ chosen: 'treasurer' });
  });

  it('has no full phone number anywhere except roleDiffs[].phone; the rest shows the last four digits', () => {
    const v = viewWith(none);
    expect(v.roleDiffs.length).toBeGreaterThan(0);
    for (const d of v.roleDiffs) {
      expect(d.phone).toMatch(/^\+60/);
      expect(d.phone4).toBe(d.phone.slice(-4));
      expect(d.phone4).toHaveLength(4);
    }
    const stripped = JSON.stringify({ ...v, roleDiffs: v.roleDiffs.map((d) => ({ ...d, phone: '' })) });
    for (const p of [P1, P2, P3]) expect(stripped).not.toContain(p);
    // not even a partial number beyond the last four digits
    expect(stripped).not.toContain('+60');
    expect(stripped).not.toContain('6012000');
  });
});
