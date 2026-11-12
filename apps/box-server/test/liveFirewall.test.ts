import { describe, expect, it, vi } from 'vitest';
import { LiveFirewall, evaluateRules, parseRules, ruleName } from '../src/live/firewall.ts';
import type { RunCommand } from '../src/live/firewall.ts';

function block(name: string, over: Record<string, string> = {}): string {
  const port = name.includes('SRT') ? '8890' : '8189';
  const f: Record<string, string> = {
    Enabled: 'Yes',
    Direction: 'In',
    Profiles: 'Domain,Private,Public',
    Grouping: '',
    LocalIP: 'Any',
    RemoteIP: 'LocalSubnet',
    Protocol: 'UDP',
    LocalPort: port,
    RemotePort: 'Any',
    'Edge traversal': 'No',
    Action: 'Allow',
    ...over,
  };
  const lines = [`Rule Name:                            ${name}`, '----------------------------------------------------------------------'];
  for (const [k, v] of Object.entries(f)) lines.push(`${`${k}:`.padEnd(38)}${v}`);
  return lines.join('\r\n');
}
const NO_RULE = 'No rules match the specified criteria.';
const GOOD = { WebRTC: block('MAXCOM Live WebRTC'), SRT: block('MAXCOM Live SRT') };

/** A fake netsh/fltmc/powershell. `rules` maps the queried rule name to the output (or null = no such rule). */
function fakeRunner(opts: {
  rules: Record<string, string | null>;
  elevated?: boolean;
  onEnsure?: () => void;
  ensureCode?: number;
  throwOn?: string;
  /** What netsh does for a rule that is not in `rules` (default: the English "No rules match" answer). */
  netshFail?: { code: number; stdout: string };
}): { run: RunCommand; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunCommand = async (full, args) => {
    // the box runs the tools by absolute path: the fake keys on the program name
    const file = (full.split(/[\\/]/).pop() ?? full).toLowerCase().replace(/\.exe$/, '');
    calls.push([file, ...args]);
    if (opts.throwOn !== undefined && file === opts.throwOn) throw new Error('spawn failed');
    if (file === 'netsh') {
      const name = args.find((a) => a.startsWith('name='))?.slice(5) ?? '';
      const out = opts.rules[name.replace('MAXCOM Live ', '')];
      return out == null ? (opts.netshFail ?? { code: 1, stdout: NO_RULE }) : { code: 0, stdout: `\r\n${out}\r\nOk.\r\n` };
    }
    if (file === 'fltmc') return { code: opts.elevated === true ? 0 : 5, stdout: '' };
    if (file === 'powershell') {
      opts.onEnsure?.();
      return { code: opts.ensureCode ?? 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };
  return { run, calls };
}

const INSTALLED = 'C:\\ProgramData\\MAXCOM\\ensure-live-firewall.ps1';
const mk = (r: { run: RunCommand }, over: Partial<ConstructorParameters<typeof LiveFirewall>[0]> = {}) => {
  const logs: string[] = [];
  const clock = { t: 1_000_000 };
  const fw = new LiveFirewall({ run: r.run, platform: 'win32', ensureScript: 'C:\\box\\scripts\\ensure-live-firewall.ps1', installedScript: INSTALLED, exists: () => true, systemRoot: 'C:\\Windows', now: () => clock.t, log: (m) => logs.push(m), ...over });
  return { fw, logs, clock };
};

describe('parseRules / evaluateRules', () => {
  it('parses netsh verbose output into one record per rule block', () => {
    const rules = parseRules(`\r\n${GOOD.WebRTC}\r\n\r\n${GOOD.SRT}\r\nOk.\r\n`);
    expect(rules).toHaveLength(2);
    expect(rules[1]).toMatchObject({ name: 'MAXCOM Live SRT', enabled: 'Yes', direction: 'In', profiles: 'Domain,Private,Public', protocol: 'UDP', localPort: '8890', remoteIp: 'LocalSubnet', action: 'Allow' });
    expect(parseRules(NO_RULE)).toEqual([]);
  });

  it('ok only for the exact rule; wrong for a Private-only, any-remote, disabled, TCP, other-port or blocking rule', () => {
    const ok = parseRules(GOOD.SRT);
    expect(evaluateRules(ok, 8890)).toBe('ok');
    expect(evaluateRules([], 8890)).toBe('missing');
    for (const bad of <Array<Record<string, string>>>[{ Profiles: 'Private' }, { Profiles: 'Private,Public' }, { RemoteIP: 'Any' }, { Enabled: 'No' }, { Protocol: 'TCP' }, { LocalPort: '9999' }, { Action: 'Block' }, { Direction: 'Out' }]) {
      expect(evaluateRules(parseRules(block('MAXCOM Live SRT', bad)), 8890), JSON.stringify(bad)).toBe('wrong');
    }
  });

  it('a duplicate of the same name with a wrong copy is wrong (the installer deletes by name)', () => {
    expect(evaluateRules(parseRules(`${GOOD.SRT}\r\n\r\n${block('MAXCOM Live SRT', { Profiles: 'Private', RemoteIP: 'Any' })}`), 8890)).toBe('wrong');
  });

  it('a block without the expected fields (another Windows language) is unknown, not wrong', () => {
    const foreign = 'Nama peraturan:   MAXCOM Live SRT\r\n-----\r\nDiaktifkan:   Ya';
    expect(evaluateRules(parseRules(`Rule Name: MAXCOM Live SRT\r\n-----\r\nEnabled: Yes`), 8890)).toBe('unknown');
    expect(ruleName('srt')).toBe('MAXCOM Live SRT');
    return new LiveFirewall({ run: async () => ({ code: 0, stdout: foreign }), platform: 'win32' }).check().then((s) => expect(s).toBe('unknown'));
  });
});

describe('LiveFirewall', () => {
  it('is unknown on a non-Windows host and runs nothing', async () => {
    const r = fakeRunner({ rules: {} });
    const { fw } = mk(r, { platform: 'linux' });
    expect(await fw.check()).toBe('unknown');
    expect(fw.state()).toBe('unknown');
    expect(r.calls).toEqual([]);
  });

  it('is ok when both rules are right; the query is read-only netsh (no add/delete)', async () => {
    const r = fakeRunner({ rules: GOOD });
    const { fw, logs } = mk(r);
    expect(await fw.check()).toBe('ok');
    expect(fw.state()).toBe('ok');
    expect(logs).toEqual([]);
    for (const c of r.calls) {
      expect(c[0]).toBe('netsh');
      expect(c.join(' ')).toMatch(/show rule name=/);
      expect(c.join(' ')).not.toMatch(/add|delete|set/);
    }
  });

  it('missing when a rule is absent; wrong when one is Private only. Not elevated: no repair, one clear log line with the admin command', async () => {
    const r = fakeRunner({ rules: { WebRTC: GOOD.WebRTC, SRT: null }, elevated: false });
    const { fw, logs, clock } = mk(r);
    expect(await fw.check()).toBe('missing');
    expect(r.calls.some((c) => c[0] === 'powershell')).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('ensure-live-firewall.ps1');
    expect(logs[0]).toMatch(/administrator/i);
    expect(logs[0]).toContain('MAXCOM Live');
    // a re-check after the cache expired logs no second line while the state stays the same
    clock.t += 61_000;
    await fw.check();
    expect(logs).toHaveLength(1);

    const w = mk(fakeRunner({ rules: { WebRTC: block('MAXCOM Live WebRTC', { Profiles: 'Private' }), SRT: GOOD.SRT } }));
    expect(await w.fw.check()).toBe('wrong');
  });

  it('elevated and not ok: runs the ensure script once, then re-checks', async () => {
    const rules: Record<string, string | null> = { WebRTC: null, SRT: null };
    const r = fakeRunner({
      rules,
      elevated: true,
      onEnsure: () => {
        rules.WebRTC = GOOD.WebRTC;
        rules.SRT = GOOD.SRT;
      },
    });
    const { fw, logs } = mk(r);
    expect(await fw.check()).toBe('ok');
    const ps = r.calls.filter((c) => c[0] === 'powershell');
    expect(ps).toHaveLength(1);
    // the admin-only ProgramData copy, never the repo copy
    expect(ps[0]!.join(' ')).toContain(INSTALLED);
    expect(ps[0]!.join(' ')).not.toContain('C:\\box\\scripts');
    expect(logs).toEqual([]);
  });

  it('elevated but no ProgramData copy: does not repair, logs the admin install command, never runs the repo copy', async () => {
    const r = fakeRunner({ rules: { WebRTC: null, SRT: null }, elevated: true });
    const { fw, logs } = mk(r, { exists: () => false });
    expect(await fw.check()).toBe('missing');
    expect(r.calls.some((c) => c[0] === 'powershell')).toBe(false);
    expect(logs.join('\n')).toMatch(/administrator/i);
    expect(logs.join('\n')).toContain('install-live-tools.ps1');
  });

  it('runs netsh, fltmc and powershell by absolute path under SystemRoot\\System32', async () => {
    const full: string[] = [];
    const rules: Record<string, string | null> = { WebRTC: null, SRT: null };
    const inner = fakeRunner({
      rules,
      elevated: true,
      onEnsure: () => {
        rules.WebRTC = GOOD.WebRTC;
        rules.SRT = GOOD.SRT;
      },
    });
    const run: RunCommand = (f, a) => {
      full.push(f);
      return inner.run(f, a);
    };
    const { fw } = mk({ run }, { systemRoot: 'D:\\Win' });
    await fw.check();
    expect(new Set(full)).toEqual(new Set(['D:\\Win\\System32\\netsh.exe', 'D:\\Win\\System32\\fltmc.exe', 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']));
  });

  it('missing only when netsh says no rule matches; any other failure (service stopped, killed, timeout) is unknown: no banner state, no repair', async () => {
    for (const netshFail of [{ code: 1, stdout: '' }, { code: 1, stdout: 'The Windows Firewall service is not running.' }, { code: 5, stdout: 'Access is denied.' }]) {
      const r = fakeRunner({ rules: { WebRTC: null, SRT: null }, elevated: true, netshFail });
      const { fw, logs } = mk(r);
      expect(await fw.check(), JSON.stringify(netshFail)).toBe('unknown');
      expect(r.calls.some((c) => c[0] === 'powershell')).toBe(false);
      expect(logs).toEqual([]);
    }
    expect(await mk(fakeRunner({ rules: { WebRTC: GOOD.WebRTC, SRT: null } })).fw.check()).toBe('missing');
  });

  it('elevated but the repair fails: stays not ok, runs the script only once, logs the failure', async () => {
    const r = fakeRunner({ rules: { WebRTC: null, SRT: null }, elevated: true, ensureCode: 1 });
    const { fw, logs, clock } = mk(r);
    expect(await fw.check()).toBe('missing');
    clock.t += 61_000;
    await fw.check();
    expect(r.calls.filter((c) => c[0] === 'powershell')).toHaveLength(1);
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it('caches for 60 seconds and re-queries after', async () => {
    const r = fakeRunner({ rules: GOOD });
    const { fw, clock } = mk(r);
    await fw.check();
    const n = r.calls.length;
    clock.t += 59_000;
    await fw.check();
    expect(r.calls.length).toBe(n);
    clock.t += 2_000;
    await fw.check();
    expect(r.calls.length).toBe(n * 2);
  });

  it('a failing query (netsh cannot start) is unknown and never throws', async () => {
    const r = fakeRunner({ rules: GOOD, throwOn: 'netsh' });
    const { fw } = mk(r);
    expect(await fw.check()).toBe('unknown');
  });

  it('concurrent checks share one query', async () => {
    const r = fakeRunner({ rules: GOOD });
    const { fw } = mk(r);
    await Promise.all([fw.check(), fw.check(), fw.check()]);
    expect(r.calls.filter((c) => c[0] === 'netsh')).toHaveLength(2);
    vi.restoreAllMocks();
  });
});
