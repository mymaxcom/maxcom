import { opMessage } from '@surau/core';
import type { OpKind, SyncOp } from '@surau/core';
import type { Login } from '../authHelpers.ts';

let n = 0;
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A fresh 26-character ULID-shaped id (time part from the counter, random tail). */
export function newOpId(): string {
  n += 1;
  let t = '';
  let x = Date.now() * 1000 + n;
  for (let i = 0; i < 10; i++) {
    t = B32[x % 32]! + t;
    x = Math.floor(x / 32);
  }
  let r = '';
  for (let i = 0; i < 16; i++) r += B32[Math.floor(Math.random() * 32)]!;
  return t + r;
}

export interface OpInput {
  kind: OpKind;
  entity: string;
  entityId: string;
  payload: unknown;
  editedAt?: string;
  baseRev?: string | null;
  opId?: string;
  /** Overrides, to build a hostile op. */
  boxId?: string;
  surauId?: string;
  deviceId?: string;
  userId?: string;
}

/** Builds an op for the device of `login` and signs it with that device's key, as the app does. */
export async function signOp(login: Login, boxId: string, input: OpInput): Promise<SyncOp> {
  const base: Omit<SyncOp, 'sig'> = {
    v: 1,
    opId: input.opId ?? newOpId(),
    surauId: input.surauId ?? 'sdm',
    boxId: input.boxId ?? boxId,
    deviceId: input.deviceId ?? login.deviceId,
    userId: input.userId ?? login.userId,
    kind: input.kind,
    entity: input.entity,
    entityId: input.entityId,
    baseRev: input.baseRev ?? null,
    editedAt: input.editedAt ?? '2026-11-03T03:00:00.000Z',
    payload: input.payload,
  };
  return { ...base, sig: await login.sign(opMessage(base)) };
}
