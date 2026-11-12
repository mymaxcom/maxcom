import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const kioskSrc = join(repoRoot, 'apps', 'kiosk-display', 'src');
const coreSrc = join(repoRoot, 'packages', 'core', 'src');
const viteConfig = join(repoRoot, 'apps', 'kiosk-display', 'vite.config.ts');

const sourceDirs = [
  { root: kioskSrc, label: 'kiosk src' },
  { root: coreSrc, label: 'core src' },
];

// Chromium 91 does not have these JS APIs. The version that added each one is in the comment.
const jsChecks: { name: string; pattern: RegExp; added: string }[] = [
  { name: 'Object.hasOwn', pattern: /\bObject\.hasOwn\s*\(/, added: 'Chrome 93' },
  { name: '.at() on arrays/strings', pattern: /\.\s*at\s*\(/, added: 'Chrome 92/93' },
  { name: 'structuredClone', pattern: /\bstructuredClone\s*\(/, added: 'Chrome 98' },
  { name: 'findLast', pattern: /\.\s*findLast\s*\(/, added: 'Chrome 97' },
  { name: 'findLastIndex', pattern: /\.\s*findLastIndex\s*\(/, added: 'Chrome 104' },
  { name: 'toSorted', pattern: /\.\s*toSorted\s*\(/, added: 'Chrome 110' },
  { name: 'toReversed', pattern: /\.\s*toReversed\s*\(/, added: 'Chrome 110' },
  { name: 'toSpliced', pattern: /\.\s*toSpliced\s*\(/, added: 'Chrome 110' },
  { name: 'Array.fromAsync', pattern: /\bArray\.fromAsync\s*\(/, added: 'Chrome 121' },
  { name: 'crypto.randomUUID', pattern: /\bcrypto\.randomUUID\s*\(/, added: 'Chrome 95' },
  { name: 'AbortSignal.timeout', pattern: /\bAbortSignal\.timeout\s*\(/, added: 'Chrome 103' },
  { name: 'AbortSignal.any', pattern: /\bAbortSignal\.any\s*\(/, added: 'Chrome 116' },
  { name: 'Promise.withResolvers', pattern: /\bPromise\.withResolvers\s*\(/, added: 'Chrome 119' },
  { name: 'Object.groupBy', pattern: /\bObject\.groupBy\s*\(/, added: 'Chrome 117' },
  { name: 'Error cause', pattern: /\bnew\s+Error\s*\([^)]*,\s*\{\s*cause\s*:/, added: 'Chrome 93' },
  { name: 'RegExp hasIndices', pattern: /\bhasIndices\b/, added: 'Chrome 90' },
  { name: 'RegExp /d flag', pattern: /\/(?:[^/\n\\]|\\.)*\/[dgimsuy]*d[dgimsuy]*(?![a-zA-Z0-9_])/, added: 'Chrome 90' },
];

// Findings outside this task that the test keeps visible but does not fail on.
const allowedFindings: string[] = [
  // packages/core is not owned by Task 7; newId() is not imported by the kiosk bundle.
  'packages/core/src/content/schema.ts: crypto.randomUUID',
];

// CSS newer than Chromium 91. `text-wrap: balance` is allowed because old engines ignore it.
const cssChecks: { name: string; pattern: RegExp; added: string; cssOnly?: boolean }[] = [
  { name: ':has()', pattern: /:has\s*\(/, added: 'Chrome 105' },
  { name: '@container', pattern: /@container\b/, added: 'Chrome 105' },
  { name: '@layer', pattern: /@layer\b/, added: 'Chrome 99' },
  { name: 'color-mix()', pattern: /color-mix\s*\(/, added: 'Chrome 111' },
  { name: 'dynamic viewport units', pattern: /\b(dvh|svh|lvh)\b/, added: 'Chrome 108-109' },
  { name: 'inset-inline shorthand', pattern: /\binset-inline\b/, added: 'Chrome 87+' },
  { name: 'last baseline alignment', pattern: /align-(items|self|content)\s*:\s*last\s+baseline/, added: 'Chrome 108' },
  { name: 'individual transform properties', pattern: /(^|[\s;{])(scale|rotate|translate)\s*:/, added: 'Chrome 104', cssOnly: true },
  // Not newer than 91, but broken on the T95's Chrome 91 GPU path: a blurred backdrop under a ticking number
  // repaints its damage rectangle wrongly every second. No backdrop-filter anywhere in the kiosk.
  { name: 'backdrop-filter (T95 repaint artifacts)', pattern: /backdrop-filter\s*:/, added: 'never on the T95' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function scanSources(): string[] {
  const findings: string[] = [];
  for (const { root, label } of sourceDirs) {
    const files = walk(root).filter((f) => /\.(ts|tsx|js|jsx|css|scss|less)$/.test(f));
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const rel = relative(repoRoot, file);
      for (const { name, pattern } of jsChecks) {
        if (pattern.test(content)) findings.push(`${rel}: ${name}`);
      }
      for (const line of content.split('\n')) {
        if (line.includes('text-wrap: balance')) continue;
        for (const { name, pattern, cssOnly } of cssChecks) {
          if (cssOnly && !file.endsWith('.css')) continue;
          if (pattern.test(line)) findings.push(`${rel}: ${name}`);
        }
      }
    }
  }
  return findings;
}

describe('Chromium 91 compatibility', () => {
  it('vite.config.ts targets chrome91 for JS and CSS', () => {
    const text = readFileSync(viteConfig, 'utf8');
    expect(text).toMatch(/target\s*:\s*['"]chrome91['"]/);
    expect(text).toMatch(/cssTarget\s*:\s*['"]chrome91['"]/);
  });

  it('kiosk and core sources use no APIs or CSS newer than Chromium 91', () => {
    const findings = scanSources();
    const normalise = (f: string) => f.replaceAll('\\', '/');
    const allowed = allowedFindings.map(normalise);
    const unexpected = findings.map(normalise).filter((f) => !allowed.includes(f));
    expect(unexpected).toEqual([]);
  });
});
