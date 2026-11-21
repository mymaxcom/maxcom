// The box's display name follows the surau (2026.11.14): box<N>-<surau short name or name>.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { runMigrations } from '../src/migrations/index.ts';
import { defaultBoxNameFor, followSurauName, localBoxNumber } from '../src/setup/boxNaming.ts';
import { boxName, setBoxName } from '../src/setup/state.ts';
import { putFeature } from '../src/settingsStore.ts';
import type { TlsMaterial } from '../src/tls.ts';
import { LOCAL_SURAU_ID } from '../src/tenant.ts';
import { loginAsAdmin } from './authHelpers.ts';

const BOX = '4f2a9c1e7b3d5a60';
const L1 = 'box1-surau.local';

const mat = (dns: string[]): TlsMaterial =>
  ({ mode: 'ip', pfx: Buffer.alloc(0), passphrase: '', notAfter: new Date('2030-01-01'), ipSan: ['10.168.0.20', '127.0.0.1'], dnsSan: dns }) as TlsMaterial;

function fresh(): DatabaseSync {
  return openDb(':memory:');
}
const setSurau = (db: DatabaseSync, patch: Record<string, unknown>): void => {
  putFeature(db, 'surauInfo', patch, 'test', undefined, LOCAL_SURAU_ID);
};
const nameOf = (db: DatabaseSync): string => boxName(db, BOX);
const seedOldDefault = (db: DatabaseSync): void => {
  db.prepare("INSERT INTO meta (key, value) VALUES ('box_name', 'MAXCOM 4F2A') ON CONFLICT(surau_id, key) DO UPDATE SET value = excluded.value").run();
};

describe('the default box name', () => {
  it('has the number of the local name, or no prefix without one', () => {
    expect(localBoxNumber(L1)).toBe(1);
    expect(localBoxNumber('box12-surau.local')).toBe(12);
    expect(localBoxNumber(null)).toBeNull();
    expect(localBoxNumber('box.surau.local')).toBeNull();
    expect(defaultBoxNameFor(L1, 'Surau Contoh')).toBe('box1-Surau Contoh');
    expect(defaultBoxNameFor('box7-surau.local', 'Surau Contoh')).toBe('box7-Surau Contoh');
    expect(defaultBoxNameFor(null, 'Surau Contoh')).toBe('Surau Contoh');
    expect(defaultBoxNameFor(L1, '')).toBe('');
    expect(defaultBoxNameFor(L1, 'X'.repeat(80)).length).toBeLessThanOrEqual(60);
  });

  it('is set once the surau has a name: the surau name, with the number; the short name wins when there is one', () => {
    const db = fresh();
    expect(followSurauName(db, BOX, L1)).toBe(false); // no surau name yet: the old default stays
    expect(nameOf(db)).toBe('MAXCOM 4F2A');
    setSurau(db, { name: 'Surau Contoh' });
    expect(followSurauName(db, BOX, L1)).toBe(true);
    expect(nameOf(db)).toBe('box1-Surau Contoh');
    const other = fresh();
    setSurau(other, { name: 'Masjid Contoh Besar', shortName: 'Contoh' });
    followSurauName(other, BOX, L1);
    expect(nameOf(other)).toBe('box1-Contoh');
  });

  it('without a numbered local name it is just the surau name, and the number is added when the name appears', () => {
    const db = fresh();
    setSurau(db, { name: 'Surau Contoh' });
    followSurauName(db, BOX, null);
    expect(nameOf(db)).toBe('Surau Contoh');
    expect(followSurauName(db, BOX, L1)).toBe(true);
    expect(nameOf(db)).toBe('box1-Surau Contoh');
    expect(followSurauName(db, BOX, L1)).toBe(false); // nothing more to do
  });
});

describe('the box name follows a rename of the surau', () => {
  it('a name that is still the default is rewritten with the new surau name', () => {
    const db = fresh();
    setSurau(db, { name: 'Surau Contoh' });
    followSurauName(db, BOX, L1);
    setSurau(db, { name: 'Surau Baharu' });
    expect(followSurauName(db, BOX, L1)).toBe(true);
    expect(nameOf(db)).toBe('box1-Surau Baharu');
  });

  it('a box<N>- name that contains the old surau name has that part rewritten', () => {
    const db = fresh();
    setSurau(db, { name: 'Surau Contoh' });
    followSurauName(db, BOX, L1);
    setBoxName(db, BOX, 'box1-Dewan Surau Contoh', 'test');
    setSurau(db, { name: 'Surau Baharu' });
    expect(followSurauName(db, BOX, L1)).toBe(true);
    expect(nameOf(db)).toBe('box1-Dewan Surau Baharu');
  });

  it('a custom name that merely contains the old surau name (or a short old name) is never rewritten', () => {
    const db = fresh();
    setSurau(db, { name: 'Surau Contoh', shortName: 'Su' });
    followSurauName(db, BOX, L1);
    setBoxName(db, BOX, 'Kotak ruang solat Surau Contoh', 'test');
    setSurau(db, { name: 'Surau Baharu', shortName: 'Ba' });
    followSurauName(db, BOX, L1);
    expect(nameOf(db)).toBe('Kotak ruang solat Surau Contoh');
    setBoxName(db, BOX, 'Susu panas', 'test');
    setSurau(db, { name: 'Surau Ketiga', shortName: 'Ke' });
    followSurauName(db, BOX, L1);
    expect(nameOf(db)).toBe('Susu panas');
  });

  it('a fully custom name without the surau name is left alone, through any number of renames', () => {
    const db = fresh();
    setSurau(db, { name: 'Surau Contoh' });
    followSurauName(db, BOX, L1);
    setBoxName(db, BOX, 'Kotak Dewan Utama', 'test');
    setSurau(db, { name: 'Surau Baharu' });
    expect(followSurauName(db, BOX, L1)).toBe(false);
    setSurau(db, { name: 'Surau Ketiga' });
    followSurauName(db, BOX, L1);
    expect(nameOf(db)).toBe('Kotak Dewan Utama');
  });

  it('the user can rename it (1..60 characters) and the hidden box id is not part of any of it', () => {
    const db = fresh();
    setSurau(db, { name: 'Surau Contoh' });
    followSurauName(db, BOX, L1);
    expect(setBoxName(db, BOX, '  Kotak Satu  ', 'test')).toBe('Kotak Satu');
    expect(() => setBoxName(db, BOX, '', 'test')).toThrow();
    expect(() => setBoxName(db, BOX, 'x'.repeat(61), 'test')).toThrow();
    expect(nameOf(db)).not.toContain(BOX.slice(0, 4));
  });

  it('through the running box: saving the surau name renames the default box name at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surau-bnfollow-'));
    let app: FastifyInstance | undefined;
    try {
      app = buildApp(join(dir, 't.db'), { dataDir: dir, httpsPort: 8443, tls: mat(['localhost', L1]) });
      const admin = await loginAsAdmin(app);
      const put = (name: string) => app!.inject({ method: 'PUT', url: '/api/settings/surauInfo', headers: admin.headers, payload: { name } });
      const info = async () => ((await app!.inject({ method: 'GET', url: '/api/box/info', remoteAddress: '10.168.0.60' })).json() as { name: string }).name;
      expect((await put('Surau Contoh')).statusCode).toBe(200);
      expect(await info()).toBe('box1-Surau Contoh');
      expect((await put('Surau Baharu')).statusCode).toBe(200);
      expect(await info()).toBe('box1-Surau Baharu');
    } finally {
      await app?.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migration 028', () => {
  const redo = (db: DatabaseSync): void => {
    db.prepare("DELETE FROM schema_migrations WHERE name = '028-box-name-follows-surau'").run();
    runMigrations(db);
  };

  it('a box still named by the old default gets the surau name once; the number is added at start', () => {
    const db = fresh();
    setSurau(db, { name: 'Surau Contoh' });
    seedOldDefault(db);
    redo(db);
    expect(nameOf(db)).toBe('Surau Contoh');
    redo(db); // a second run changes nothing
    expect(nameOf(db)).toBe('Surau Contoh');
    followSurauName(db, BOX, L1);
    expect(nameOf(db)).toBe('box1-Surau Contoh');
  });

  it('a name the user chose, or a surau without a name, is not touched', () => {
    const custom = fresh();
    setSurau(custom, { name: 'Surau Contoh' });
    setBoxName(custom, BOX, 'Kotak Dewan', 'test');
    redo(custom);
    expect(nameOf(custom)).toBe('Kotak Dewan');
    const noName = fresh();
    seedOldDefault(noName);
    redo(noName);
    expect(nameOf(noName)).toBe('MAXCOM 4F2A');
  });
});
