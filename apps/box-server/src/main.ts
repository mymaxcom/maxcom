import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyServerFactory } from 'fastify';
import { buildApp } from './app.ts';
import { purgeExpired } from './auth/sessions.ts';
import { LiveFirewall } from './live/firewall.ts';
import { buildDamagedApp, isDatabaseDamage, setDamagedAllowedHosts } from './setup/damaged.ts';
import { hardenServer } from './serverLimits.ts';
import { workerAdminFrom } from './sync/workerOutbox.ts';
import { expiryWarning, loadTls, startCertReload } from './tls.ts';
import type { CertReloader, TlsMaterial } from './tls.ts';

const TLS_CIPHERS = [
  'TLS_AES_256_GCM_SHA384',
  'TLS_AES_128_GCM_SHA256',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');

const TLS_BASE_OPTIONS = { minVersion: 'TLSv1.2', honorCipherOrder: true, ciphers: TLS_CIPHERS } as const;

/** Integer 1..65535 from env text (default 8787 when unset); null if invalid. */
export function parsePort(value: string | undefined): number | null {
  const text = (value ?? '8787').trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

export interface ListenerPlan {
  http: { host: string; port: number };
  https: { host: string; port: number } | null;
  warnings: string[];
}

/**
 * HTTP is always loopback only (the kiosk Edge on the box); HTTPS serves the LAN and only exists
 * when a certificate is present. There is deliberately no switch for HTTP on the LAN.
 */
export function planListeners(env: NodeJS.ProcessEnv, tls: TlsMaterial | null): ListenerPlan {
  const httpPort = parsePort(env.SURAU_PORT);
  if (httpPort === null) {
    throw new Error(`Invalid SURAU_PORT "${env.SURAU_PORT}": expected an integer 1..65535`);
  }
  const httpsPort = parseDefaultedPort(env.SURAU_HTTPS_PORT, '8443');
  if (httpsPort === null) {
    throw new Error(`Invalid SURAU_HTTPS_PORT "${env.SURAU_HTTPS_PORT}": expected an integer 1..65535`);
  }
  const plan: ListenerPlan = {
    http: { host: '127.0.0.1', port: httpPort },
    https: null,
    warnings: [],
  };
  if (tls) plan.https = { host: '0.0.0.0', port: httpsPort };
  else plan.warnings.push('TLS certificate missing: run scripts/box-ca.ps1; the box is reachable from this PC only');
  return plan;
}

function parseDefaultedPort(value: string | undefined, fallback: string): number | null {
  return parsePort(value === undefined || value.trim() === '' ? fallback : value);
}

/** Host names the Host allowlist must accept: certificate SANs plus SURAU_ALLOWED_HOSTS. */
export function hostsFromTls(tls: TlsMaterial | null, env: NodeJS.ProcessEnv): string[] {
  const hosts = [
    ...(tls ? [...tls.ipSan, ...tls.dnsSan] : []),
    ...(env.SURAU_ALLOWED_HOSTS ?? '').split(','),
  ];
  return [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== ''))];
}

/**
 * Loads the TLS material without ever throwing: an expired or corrupt certificate, or a wrong
 * passphrase, must not take the loopback kiosk down with it. The result is tls=null (loopback
 * HTTP only, never LAN HTTP) plus a loud warning; the warning never contains the passphrase.
 */
export function loadTlsOrWarn(dataDir: string, now: Date = new Date()): { tls: TlsMaterial | null; warning: string | null } {
  try {
    return { tls: loadTls(dataDir, now), warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return {
      tls: null,
      warning: `WARNING: HTTPS is DISABLED (${reason}). The box serves this PC only on loopback HTTP until the certificate is fixed (scripts/box-ca.ps1).`,
    };
  }
}

export interface Listeners {
  app: FastifyInstance;
  httpPort: number;
  httpsPort: number | null;
  /** Re-checks the certificate files now (also done hourly); null when HTTPS is not serving. */
  certReload: CertReloader | null;
}

export interface StartOptions {
  dbPath: string;
  staticDir: string | null;
  appDir?: string | null;
  tls: TlsMaterial | null;
  plan: ListenerPlan;
  env: NodeJS.ProcessEnv;
  dataDir?: string;
  /** Certificate re-check interval in ms (default one hour). */
  certReloadMs?: number;
  /** The daily e-Solat top-up; on by default, tests pass false. */
  autoPrayerFetch?: boolean;
  /** The HadeethEnc catalog refresh and weekly text check (box role); on by default, tests pass false. */
  hadisTimers?: boolean;
  /** Folder holding mediamtx/ and ffmpeg/ (env SURAU_LIVE_TOOLS); omitted: no live tools. */
  liveToolsDir?: string;
  /** The media-ports firewall check handed to the live feature (main supplies it); omitted: not checked. */
  liveFirewall?: LiveFirewall;
  /** `box` (default) or `cloud` (env SURAU_ROLE). */
  role?: 'box' | 'cloud';
}

/** SURAU_ROLE: `box` (default) or `cloud`; anything else is an error. */
export function parseRole(value: string | undefined): 'box' | 'cloud' | null {
  const v = (value ?? 'box').trim().toLowerCase();
  return v === '' || v === 'box' ? 'box' : v === 'cloud' ? 'cloud' : null;
}

/** Comma separated origins from SURAU_CORS_ORIGINS. */
export function corsOriginsFrom(env: NodeJS.ProcessEnv): string[] {
  return (env.SURAU_CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter((o) => o !== '');
}

/** The cloud's Worker admin settings from the environment (lives beside the outbox, so the CLI shares it). */
export { workerAdminFrom };

/** One Fastify app behind both listeners; closing the app closes the HTTPS server too. */
export async function startListeners(o: StartOptions): Promise<Listeners> {
  let httpsServer: https.Server | null = null;
  let certReload: CertReloader | null = null;

  const serverFactory: FastifyServerFactory = (handler) => {
    if (o.plan.https && o.tls) {
      // TLS 1.2+ with forward-secret AEAD suites only (no static-RSA, no CBC); TLS 1.3 suites stay on.
      const tlsOpts: https.ServerOptions = { ...TLS_BASE_OPTIONS };
      if (o.tls.pfx.length > 0) {
        tlsOpts.pfx = o.tls.pfx;
        tlsOpts.passphrase = o.tls.passphrase;
      } else {
        tlsOpts.cert = o.tls.cert;
        tlsOpts.key = o.tls.key;
      }
      httpsServer = https.createServer(tlsOpts, handler);
      hardenServer(httpsServer);
    }
    return http.createServer(handler);
  };

  let damaged = false;
  const buildOrDamaged = (): FastifyInstance => {
    try {
      return buildApp(o.dbPath, {
        staticDir: o.staticDir,
        ...(o.appDir ? { appDir: o.appDir } : {}),
        allowedHosts: hostsFromTls(o.tls, o.env),
        ...(o.autoPrayerFetch === false ? {} : { autoPrayerFetch: {} }),
        ...(o.hadisTimers === false ? {} : { hadisTimers: {} }),
        serverFactory,
        tls: o.tls,
        ...(o.plan.https ? { httpsPort: o.plan.https.port } : {}),
        ...(o.dataDir !== undefined ? { dataDir: o.dataDir } : {}),
        ...(o.liveToolsDir !== undefined ? { liveTools: { dir: o.liveToolsDir } } : {}),
        role: o.role ?? 'box',
        corsOrigins: corsOriginsFrom(o.env),
        cloud: { url: o.env.SURAU_CLOUD_URL?.trim() || null, workerUrl: o.env.SURAU_WORKER_URL?.trim() || null },
        ...(o.role === 'cloud' ? { workerAdmin: workerAdminFrom(o.env) } : {}),
        ...(o.env.SURAU_BOX_ID !== undefined && /^[0-9a-f]{16}$/.test(o.env.SURAU_BOX_ID.trim()) ? { boxId: o.env.SURAU_BOX_ID.trim() } : {}),
        ...(o.liveFirewall !== undefined ? { liveFirewall: o.liveFirewall } : {}),
      });
    } catch (error) {
      // A broken database file must not leave the TV blank: serve the "restore" screen instead (never for the cloud).
      if ((o.role ?? 'box') !== 'box' || !isDatabaseDamage(error)) throw error;
      console.error('WARNING: the database cannot be opened (damaged); serving the recovery screen only');
      damaged = true;
      return buildDamagedApp({
        dataDir: o.dataDir ?? dirname(resolve(o.dbPath)),
        staticDir: o.staticDir,
        allowedHosts: hostsFromTls(o.tls, o.env),
        serverFactory,
      });
    }
  };
  const app = buildOrDamaged();

  // Hourly sweep of dead challenges, sessions, enrolments and pairings.
  const purgeTimer = setInterval(() => {
    if (damaged) return;
    try {
      purgeExpired(app.surau.db, new Date());
    } catch (error) {
      console.error('purgeExpired failed', error);
    }
  }, 3_600_000);
  purgeTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(purgeTimer);
  });

  app.addHook('onClose', async () => {
    certReload?.stop();
  });

  app.addHook('onClose', async () => {
    const server = httpsServer;
    if (!server?.listening) return;
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  });

  await app.listen({ host: o.plan.http.host, port: o.plan.http.port });
  const httpPort = (app.server.address() as AddressInfo).port;

  let httpsPort: number | null = null;
  const server = httpsServer as https.Server | null;
  if (server && o.plan.https) {
    const { host, port } = o.plan.https;
    try {
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen({ host, port }, () => {
          server.off('error', fail);
          done();
        });
      });
      httpsPort = (server.address() as AddressInfo).port;
      // Pick up a renewed leaf (written by scripts/box-cert-renew.ps1) without a restart.
      if (o.tls && o.dataDir !== undefined) {
        certReload = startCertReload({
          server,
          dataDir: o.dataDir,
          current: o.tls,
          baseOptions: TLS_BASE_OPTIONS,
          ...(o.certReloadMs !== undefined ? { intervalMs: o.certReloadMs } : {}),
          onReload: (next) => {
            // the damaged-database app has no `.surau`: it keeps its own allowlist
            const hosts = hostsFromTls(next, o.env);
            if (!setDamagedAllowedHosts(app, hosts)) app.surau.setAllowedHosts(hosts);
            console.log(`TLS certificate reloaded, valid until ${next.notAfter.toISOString()}`);
          },
        });
      }
    } catch (error) {
      // Keep the loopback kiosk running; there is no HTTP fallback on the LAN.
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      console.warn(
        `WARNING: HTTPS could not listen on ${host}:${port} (${code}); the box serves this PC only on loopback HTTP until this is fixed`,
      );
    }
  }
  return { app, httpPort, httpsPort, certReload };
}

async function start(): Promise<void> {
  const dbPath = process.env.SURAU_DB ?? './data/surau.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const dataDir = process.env.SURAU_DATA_DIR ?? (dbPath === ':memory:' ? './data' : dirname(resolve(dbPath)));

  const { tls, warning: tlsWarning } = loadTlsOrWarn(dataDir);
  if (tlsWarning) console.warn(tlsWarning);
  let plan: ListenerPlan;
  try {
    plan = planListeners(process.env, tls);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  for (const warning of plan.warnings) console.warn(warning);
  if (tls) {
    const warning = expiryWarning(tls);
    if (warning) console.warn(warning);
  }

  const role = parseRole(process.env.SURAU_ROLE);
  if (role === null) {
    console.error(`Invalid SURAU_ROLE "${process.env.SURAU_ROLE}": expected box or cloud`);
    process.exit(1);
  }

  const repoRoot = resolve(import.meta.dirname, '../../..');
  const staticDir = resolve(repoRoot, 'apps/kiosk-display/dist');
  const appDir = resolve(repoRoot, 'apps/box-server/public/app');

  const { app, httpPort, httpsPort } = await startListeners({
    dbPath,
    staticDir: existsSync(staticDir) ? staticDir : null,
    appDir: existsSync(appDir) ? appDir : null,
    tls,
    plan,
    env: process.env,
    dataDir,
    role,
    // the cloud role runs no live tools, so it gets no live tools folder and no media-port firewall check;
    // the firewall check is read-only (Windows only) and repairs only if this process is elevated
    ...(role === 'box'
      ? {
          liveToolsDir: process.env.SURAU_LIVE_TOOLS?.trim() || resolve(repoRoot, 'tools/live'),
          liveFirewall: new LiveFirewall({ ensureScript: resolve(repoRoot, 'scripts/ensure-live-firewall.ps1') }),
        }
      : {}),
  });
  console.log(`Surau box server: http://127.0.0.1:${httpPort}/` + (httpsPort ? ` and https://0.0.0.0:${httpsPort}/` : ''));

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`Surau box server received ${signal}, shutting down`);
    void app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error('Shutdown failed', error);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** Node resolves links (junction, symlink) for the main module, so compare canonical paths. */
function isEntryModule(invoked: string | undefined, self: string): boolean {
  if (invoked === undefined) return false;
  try {
    return realpathSync(resolve(invoked)) === realpathSync(self);
  } catch {
    return resolve(invoked) === self;
  }
}

const isMain = isEntryModule(process.argv[1], fileURLToPath(import.meta.url));

if (isMain) {
  void start().catch((error: unknown) => {
    console.error('Surau box server failed to start', error);
    process.exit(1);
  });
}
