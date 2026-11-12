import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { Limiters } from '../auth/authz.ts';
import type { ChangeBus } from '../events.ts';
import type { PrayerAutoFetch } from '../prayerAutoFetch.ts';
import { registerImportRoutes } from './importRoutes.ts';
import { registerLocationRoutes } from './locationRoutes.ts';
import { registerPrayerCoreRoutes } from './routes.ts';
import { registerZonesRoutes } from './zonesRoutes.ts';

/** What every prayer route registrar needs from the app. */
export interface PrayerDeps {
  db: DatabaseSync;
  dataDir: string;
  now: () => Date;
  fetchImpl: typeof fetch;
  bus: ChangeBus;
  autoFetch: PrayerAutoFetch;
  /** True where the box runs its own daily fetch (a box in production); false in tests and on the cloud. */
  autoFetchOn: boolean;
  role: 'box' | 'cloud';
  limiters: Limiters;
  /** Test seam: the least gap between two Nominatim requests from this box (default one second, the service's policy). */
  nominatimMinIntervalMs?: number;
}

export function registerPrayerRoutes(app: FastifyInstance, deps: PrayerDeps): void {
  registerPrayerCoreRoutes(app, deps);
  registerZonesRoutes(app, deps);
  registerLocationRoutes(app, deps);
  registerImportRoutes(app, deps);
}
