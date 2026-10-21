// The old engine cannot creep back (planning/core.md, Batch 11 step 2; Batch 12 deletes the frozen set and this guard with it). The reference engine's files stay in the tree,
// unchanged and compiled, with their own tests, until Batch 12: `storeAccess.ts`, `shape.ts`, `store.ts`, `dehydrate.ts`, `threadScope.ts`, and `vocab.ts`, whose
// codec (`NODE_BASE`, `nodeExists`, the terms) is the Oxigraph half. This test lists them, and fails when a module outside the set and outside the tests imports `oxigraph` or
// one of them, and when a frozen file imports a module that is not frozen (it must stay unaffected by what the flip changed).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const PACKAGES = resolve(import.meta.dirname, '../../../..');
const SHELL = join(PACKAGES, 'core/src/shell');
const FROZEN = ['storeAccess', 'shape', 'store', 'dehydrate', 'threadScope', 'vocab'].map((n) => join(SHELL, `${n}.ts`));
/** What a frozen file may import besides the frozen set and `oxigraph`: the table of settings and the node builtins. */
const FROZEN_MAY_IMPORT = [join(PACKAGES, 'core/src/graphConfig.ts')];

/** Every `.ts` and `.tsx` file under the `src` of a package, except the tests. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== 'tests' && name !== 'node_modules' && name !== 'dist') sources(path, out); }
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The module specifiers a file imports or re-exports, from its import and export statements. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf-8');
  return [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => (m[1] ?? m[2] ?? m[3])!);
}

/** The file a specifier names, when it is a relative path or an `@aperas/<package>/` path; nothing for a package. */
function target(from: string, spec: string): string | undefined {
  let base: string | undefined;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@aperas/')) { const [, pkg, ...rest] = spec.split('/'); base = join(PACKAGES, pkg!, 'src', ...rest); }
  if (base === undefined) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  return base;
}

const all = ['core', 'cli', 'web'].flatMap((pkg) => sources(join(PACKAGES, pkg, 'src')));

describe('the old engine stays out', () => {
  test('the frozen set is in the tree, and the guard sees the sources it scans', () => {
    for (const file of FROZEN) assert.ok(existsSync(file), `${relative(PACKAGES, file)} is in the frozen set and must exist until Batch 12`);
    assert.ok(all.length > 60 && all.some((f) => f.endsWith('shell/node.ts')) && all.some((f) => f.endsWith('service/service.ts')), `${all.length} sources scanned`);
    assert.ok(all.every((f) => !f.includes(`${join('cli', 'src', 'tests')}`)), 'the tests are not scanned');
  });

  test('no module outside the frozen set imports oxigraph or a frozen file', () => {
    const offenders: string[] = [];
    for (const file of all) {
      if (FROZEN.includes(file)) continue;
      for (const spec of specifiers(file)) {
        const t = target(file, spec);
        if (spec === 'oxigraph' || spec.startsWith('oxigraph/') || (t !== undefined && FROZEN.includes(t))) offenders.push(`${relative(PACKAGES, file)} imports ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('a frozen file imports only the frozen set, oxigraph, the table of settings and the builtins', () => {
    const offenders: string[] = [];
    for (const file of FROZEN) {
      for (const spec of specifiers(file)) {
        if (spec === 'oxigraph' || spec.startsWith('node:')) continue;
        const t = target(file, spec);
        if (t === undefined || (!FROZEN.includes(t) && !FROZEN_MAY_IMPORT.includes(t))) offenders.push(`${basename(file)} imports ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('the guard finds what it is meant to find', () => {
    const probe = join(SHELL, 'probe.ts');
    // the scanner on a made-up line, by the same two functions
    const spec = "import { nodeExists } from './vocab';\nimport type { Store } from 'oxigraph';\n";
    const found = [...spec.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(found, ['./vocab', 'oxigraph']);
    assert.equal(target(probe, './vocab'), join(SHELL, 'vocab.ts'));
    assert.ok(FROZEN.includes(target(probe, '@aperas/core/shell/storeAccess')!));
  });
});
