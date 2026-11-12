import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeExpired } from '../src/auth/sessions.ts';
import { openDb } from '../src/db.ts';
import {
  consumeNonce, issueNonce, issueRecoveryCode, normaliseRecoveryCode, sweepBoxCodes, verifyRecoveryCode,
} from '../src/setup/codes.ts';

let dir = '';
let db: DatabaseSync;
const T0 = new Date('2026-11-09T10:00:00Z');
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surau-codes-'));
  db = openDb(join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const rows = (): { nonce_hash: string; expires_at: string; used_at: string | null; outcome: string | null }[] =>
  db.prepare('SELECT nonce_hash, expires_at, used_at, outcome FROM box_codes ORDER BY created_at, rowid').all() as never;

describe('box nonces', () => {
  it('stores only a hash, 43 chars, ten minutes', () => {
    const { nonce, expiresAt } = issueNonce(db, 'setup', T0);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe('2026-11-09T10:10:00.000Z');
    expect(rows()[0]!.nonce_hash).not.toBe(nonce);
    expect(JSON.stringify(rows())).not.toContain(nonce);
  });

  it('issuing twice of one type leaves one live nonce', () => {
    const a = issueNonce(db, 'setup', T0);
    const b = issueNonce(db, 'setup', new Date(T0.getTime() + 1000));
    expect(consumeNonce(db, 'setup', a.nonce, '1.1.1.1', new Date(T0.getTime() + 2000))).toBe('expired');
    expect(consumeNonce(db, 'setup', b.nonce, '1.1.1.1', new Date(T0.getTime() + 2000))).toBe('ok');
  });

  it('a different type does not expire the other', () => {
    const a = issueNonce(db, 'setup', T0);
    issueNonce(db, 'recovery', T0);
    expect(consumeNonce(db, 'setup', a.nonce, 'ip', T0)).toBe('ok');
  });

  it('consume: ok, then bad (spent); wrong type and unknown are bad', () => {
    const { nonce } = issueNonce(db, 'setup', T0);
    expect(consumeNonce(db, 'recovery', nonce, 'ip', T0)).toBe('bad');
    expect(consumeNonce(db, 'setup', nonce, '9.9.9.9', T0)).toBe('ok');
    expect(consumeNonce(db, 'setup', nonce, 'ip', T0)).toBe('bad');
    expect(consumeNonce(db, 'setup', 'x'.repeat(43), 'ip', T0)).toBe('bad');
    expect(rows()[0]!.outcome).toBe('ok');
    expect((db.prepare('SELECT used_ip FROM box_codes').get() as { used_ip: string }).used_ip).toBe('9.9.9.9');
  });

  it('an expired nonce is expired and cannot be used afterwards', () => {
    const { nonce } = issueNonce(db, 'recovery', T0);
    const late = new Date(T0.getTime() + 11 * 60_000);
    expect(consumeNonce(db, 'recovery', nonce, 'ip', late)).toBe('expired');
    expect(consumeNonce(db, 'recovery', nonce, 'ip', T0)).toBe('bad');
  });

  it('two callers on one nonce: exactly one ok', () => {
    const { nonce } = issueNonce(db, 'setup', T0);
    const r = [consumeNonce(db, 'setup', nonce, 'a', T0), consumeNonce(db, 'setup', nonce, 'b', T0)];
    expect(r.filter((x) => x === 'ok')).toHaveLength(1);
  });
});

describe('recovery code', () => {
  it('has 16 symbols grouped by four, and the database keeps only a hash', () => {
    const code = issueRecoveryCode(db);
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(code).toHaveLength(19);
    const plain = code.replaceAll('-', '');
    for (const f of readdirSync(dir).filter((n) => n.startsWith('test.db'))) {
      const bytes = readFileSync(join(dir, f));
      expect(bytes.includes(Buffer.from(plain))).toBe(false);
      expect(bytes.includes(Buffer.from(code))).toBe(false);
    }
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'recovery_code_hash'").get() as { value: string };
    expect(meta.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies with spaces, dashes and lower case; refuses one wrong symbol', () => {
    const code = issueRecoveryCode(db);
    const plain = code.replaceAll('-', '');
    expect(verifyRecoveryCode(db, code)).toBe(true);
    expect(verifyRecoveryCode(db, plain.toLowerCase())).toBe(true);
    expect(verifyRecoveryCode(db, plain.match(/.{4}/g)!.join(' '))).toBe(true);
    const wrong = plain.slice(0, 15) + (plain[15] === 'A' ? 'B' : 'A');
    expect(verifyRecoveryCode(db, wrong)).toBe(false);
    expect(verifyRecoveryCode(db, plain.slice(0, 15))).toBe(false);
    expect(verifyRecoveryCode(db, '')).toBe(false);
  });

  it('is false when no code was ever issued', () => {
    expect(verifyRecoveryCode(db, 'AAAA-AAAA-AAAA-AAAA')).toBe(false);
  });

  it('a new code kills the old one', () => {
    const a = issueRecoveryCode(db);
    const b = issueRecoveryCode(db);
    expect(verifyRecoveryCode(db, a)).toBe(false);
    expect(verifyRecoveryCode(db, b)).toBe(true);
  });

  it('normalise', () => expect(normaliseRecoveryCode(' ab-cd ef ')).toBe('ABCDEF'));
});

describe('sweep', () => {
  it('purgeExpired and sweepBoxCodes drop a nonce expired 25 h ago and keep one expired 1 h ago', () => {
    const old = issueNonce(db, 'setup', new Date(T0.getTime() - 25 * 3_600_000 - 10 * 60_000));
    const recent = issueNonce(db, 'recovery', new Date(T0.getTime() - 1 * 3_600_000 - 10 * 60_000));
    expect(rows()).toHaveLength(2);
    purgeExpired(db, T0);
    expect(rows()).toHaveLength(1);
    expect(consumeNonce(db, 'recovery', recent.nonce, 'ip', T0)).toBe('expired');
    expect(consumeNonce(db, 'setup', old.nonce, 'ip', T0)).toBe('bad');
    issueNonce(db, 'probe', new Date(T0.getTime() - 30 * 3_600_000));
    sweepBoxCodes(db, T0);
    expect(rows()).toHaveLength(1);
  });
});
