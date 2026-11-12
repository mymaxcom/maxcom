import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Core runs in the kiosk browser too: no Node-only module may be imported from src.
const srcDir = fileURLToPath(new URL('../src', import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('core is browser-safe', () => {
  it('imports no node: modules and no bare Node built-ins', () => {
    const offenders = files(srcDir).filter((f) =>
      /from\s+['"](node:|fs['"]|path['"]|crypto['"]|os['"])/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
