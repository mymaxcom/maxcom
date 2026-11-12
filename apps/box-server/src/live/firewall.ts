import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * The live media ports (UDP 8189 WebRTC, UDP 8890 SRT) must be open on every Windows network profile,
 * from the local subnet only: Windows marks a Wi-Fi "Public" without asking, and a Private-only rule
 * then drops the phone's packets silently. This module only READS the two rules (netsh needs no admin
 * for that), says whether they are right, and, when the box itself runs elevated, repairs them once
 * through scripts/ensure-live-firewall.ps1. It never asks for elevation.
 */

export type FirewallState = 'ok' | 'missing' | 'wrong' | 'unknown';

export interface LiveRuleSpec {
  key: 'webrtc' | 'srt';
  name: string;
  port: number;
}

export const LIVE_RULES: readonly LiveRuleSpec[] = [
  { key: 'webrtc', name: 'MAXCOM Live WebRTC', port: 8189 },
  { key: 'srt', name: 'MAXCOM Live SRT', port: 8890 },
];

export function ruleName(key: LiveRuleSpec['key']): string {
  return LIVE_RULES.find((r) => r.key === key)!.name;
}

export interface FirewallRule {
  name: string;
  enabled: string;
  direction: string;
  profiles: string;
  localPort: string;
  remoteIp: string;
  action: string;
  protocol: string;
}

/** Runs a program; resolves with its exit code and stdout, rejects when it cannot start. */
export type RunCommand = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** The real runner: no shell, a hard timeout, output capped. */
export const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 200_000) out += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out });
    });
  });

/** Parses `netsh advfirewall firewall show rule ... verbose` into one record per rule block. */
export function parseRules(text: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  let cur: Record<string, string> | null = null;
  const flush = (): void => {
    if (cur === null) return;
    rules.push({
      name: cur.name ?? '',
      enabled: cur.enabled ?? '',
      direction: cur.direction ?? '',
      profiles: cur.profiles ?? '',
      localPort: cur.localport ?? '',
      remoteIp: cur.remoteip ?? '',
      action: cur.action ?? '',
      protocol: cur.protocol ?? '',
    });
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z ]*?):\s*(.*?)\s*$/.exec(raw);
    if (m === null) continue;
    const key = m[1]!.toLowerCase().replace(/ /g, '');
    if (key === 'rulename') {
      flush();
      cur = { name: m[2]! };
    } else if (cur !== null) {
      cur[key] ??= m[2]!;
    }
  }
  flush();
  return rules;
}

/** Whether the rule blocks found for one port are exactly the wanted rule. */
export function evaluateRules(rules: FirewallRule[], port: number): FirewallState {
  if (rules.length === 0) return 'missing';
  // a block without the fields we read (another Windows language prints other labels) cannot be judged
  if (rules.some((r) => r.enabled === '' || r.profiles === '' || r.localPort === '' || r.action === '')) return 'unknown';
  const exact = (r: FirewallRule): boolean => {
    const profiles = r.profiles
      .toLowerCase()
      .split(',')
      .map((p) => p.trim());
    return (
      r.enabled.toLowerCase() === 'yes' &&
      r.direction.toLowerCase() === 'in' &&
      r.protocol.toUpperCase() === 'UDP' &&
      r.localPort === String(port) &&
      r.action.toLowerCase() === 'allow' &&
      r.remoteIp.toLowerCase() === 'localsubnet' &&
      ['domain', 'private', 'public'].every((p) => profiles.includes(p))
    );
  };
  // the installer deletes by name before adding, so any stray copy of the name that differs is a fault
  return rules.every(exact) ? 'ok' : 'wrong';
}

export interface LiveFirewallOptions {
  run?: RunCommand;
  platform?: NodeJS.Platform;
  /** Absolute path of the repo's scripts/ensure-live-firewall.ps1: only named in the log, as the command an administrator runs. */
  ensureScript?: string;
  /**
   * The admin-only copy the installer puts in %ProgramData%\MAXCOM. An elevated box repairs only through
   * this file, never through the repo copy (which the installing user can write). Default: that path.
   */
  installedScript?: string;
  /** Whether a file exists (default fs.existsSync). */
  exists?: (path: string) => boolean;
  /** Windows folder (default %SystemRoot%, else C:\Windows): netsh, fltmc and powershell run from its System32. */
  systemRoot?: string;
  now?: () => number;
  log?: (message: string) => void;
  /** How long a result is reused (default 60 s). */
  ttlMs?: number;
}

/** The firewall check the live feature uses; one instance per box. */
export class LiveFirewall {
  private readonly run: RunCommand;
  private readonly platform: NodeJS.Platform;
  private readonly ensureScript: string | undefined;
  private readonly installedScript: string;
  private readonly exists: (path: string) => boolean;
  private readonly netsh: string;
  private readonly fltmc: string;
  private readonly powershell: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly ttlMs: number;
  private current: FirewallState = 'unknown';
  private checkedAt = -Infinity;
  private inflight: Promise<FirewallState> | null = null;
  private repairTried = false;
  private loggedState: FirewallState | null = null;

  constructor(o: LiveFirewallOptions = {}) {
    this.run = o.run ?? runCommand;
    this.platform = o.platform ?? process.platform;
    this.ensureScript = o.ensureScript;
    this.installedScript = o.installedScript ?? win32.join(process.env.ProgramData ?? 'C:\\ProgramData', 'MAXCOM', 'ensure-live-firewall.ps1');
    this.exists = o.exists ?? existsSync;
    const sys32 = win32.join(o.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    this.netsh = win32.join(sys32, 'netsh.exe');
    this.fltmc = win32.join(sys32, 'fltmc.exe');
    this.powershell = win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.warn(m));
    this.ttlMs = o.ttlMs ?? 60_000;
  }

  /** The last known state, without querying. */
  state(): FirewallState {
    return this.current;
  }

  /** The state, from the cache when it is under a minute old. Never throws. */
  check(): Promise<FirewallState> {
    if (this.now() - this.checkedAt < this.ttlMs) return Promise.resolve(this.current);
    if (this.inflight !== null) return this.inflight;
    const job = this.refresh().then(
      (s) => s,
      () => 'unknown' as const,
    );
    this.inflight = job;
    const done = (s: FirewallState): FirewallState => {
      this.current = s;
      this.checkedAt = this.now();
      if (this.inflight === job) this.inflight = null;
      return s;
    };
    return job.then(done);
  }

  private async query(): Promise<FirewallState> {
    if (this.platform !== 'win32') return 'unknown';
    const states: FirewallState[] = [];
    for (const rule of LIVE_RULES) {
      try {
        const r = await this.run(this.netsh, ['advfirewall', 'firewall', 'show', 'rule', `name=${rule.name}`, 'verbose']);
        if (r.code !== 0) {
          // netsh exits 1 and prints "No rules match" when the name is not there. Any other failure (the firewall
          // service stopped, a timeout or kill, another language) says nothing about the rules: no red banner
          states.push(/No rules match/i.test(r.stdout) ? 'missing' : 'unknown');
          continue;
        }
        const rules = parseRules(r.stdout);
        // output we cannot read (another Windows language prints other labels) is not "missing"
        states.push(rules.length === 0 && r.stdout.replace(/Ok\./i, '').trim() !== '' ? 'unknown' : evaluateRules(rules, rule.port));
      } catch {
        return 'unknown';
      }
    }
    if (states.includes('unknown')) return 'unknown';
    if (states.includes('wrong')) return 'wrong';
    if (states.includes('missing')) return 'missing';
    return 'ok';
  }

  private async elevated(): Promise<boolean> {
    try {
      // fltmc lists filter drivers and exits 0 only in an elevated process
      return (await this.run(this.fltmc, [])).code === 0;
    } catch {
      return false;
    }
  }

  private async refresh(): Promise<FirewallState> {
    let state = await this.query();
    if (state === 'ok') {
      this.loggedState = null;
      this.repairTried = false;
      return state;
    }
    if (state === 'unknown') return state;
    // missing or wrong
    // only the admin-only ProgramData copy is ever run (the repo copy can be written by the installing user)
    if (!this.repairTried && this.exists(this.installedScript) && (await this.elevated())) {
      this.repairTried = true;
      try {
        const r = await this.run(this.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.installedScript]);
        if (r.code !== 0) this.log('live: the media firewall rules could not be repaired (ensure-live-firewall.ps1 failed)');
      } catch {
        this.log('live: the media firewall rules could not be repaired (PowerShell did not start)');
      }
      state = await this.query();
      if (state === 'ok') {
        this.repairTried = false;
        this.loggedState = null;
        return state;
      }
    }
    if (this.loggedState !== state) {
      this.loggedState = state;
      const script = this.ensureScript ?? 'scripts\\ensure-live-firewall.ps1';
      this.log(
        `live: the media firewall rules (MAXCOM Live WebRTC UDP 8189, MAXCOM Live SRT UDP 8890) are ${state}. The phone's video will not arrive. In an administrator PowerShell run: powershell -ExecutionPolicy Bypass -File "${script}" (or run scripts\\install-live-tools.ps1 again: it also installs the boot task and the admin-only repair copy)`,
      );
    }
    return state;
  }
}
