// The table of settings of the graphs (planning/core.md, Batch 9 step 2; design/core.md, "Addressing"): the `graphs` key of `aperas.config.json`
// holds, for each of the three graphs, the directory of its mirror and its flush interval; where the key or a setting is absent the defaults are
// today's files and intervals. Every case runs in scratch roots with `APERAS_APEIRON_ROOT` unset or set and restored; the reader finds a config
// and reads it, and no test here loads or dumps the live mirror (the one case that finds no config reads the config beside the fallback root,
// which has no `graphs` key, and computes the paths of the dev checkout).
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveGraphSettings } from '@aperas/core/graphConfig';

const FALLBACK_APEIRON = resolve(import.meta.dirname, '../../../../../../AperasKG/Apeiron');

let base: string;
let savedRoot: string | undefined;
let savedCwd: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aperas-settings-')));
  savedRoot = process.env.APERAS_APEIRON_ROOT;
  savedCwd = process.cwd();
  delete process.env.APERAS_APEIRON_ROOT;
});
afterEach(() => {
  process.chdir(savedCwd);
  if (savedRoot === undefined) delete process.env.APERAS_APEIRON_ROOT; else process.env.APERAS_APEIRON_ROOT = savedRoot;
  rmSync(base, { recursive: true, force: true });
});

/** Writes a config file (an object, or text for a malformed one) in a directory of the scratch root and gives the directory. */
function config(content: unknown, dir = 'cfg'): string {
  const where = join(base, dir);
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, 'aperas.config.json'), typeof content === 'string' ? content : JSON.stringify(content));
  return where;
}
const summary = (startDir: string): [string, string, number][] => resolveGraphSettings(startDir).graphs.map((g) => [g.graph, g.directory, g.flushIntervalMs]);

describe('the defaults, with no `graphs` key', () => {
  test('are today\'s files and intervals: tree in the tracked directory every 10 s, threads.tree and treeviews in .state/ every 3 s', () => {
    const dir = config({ graph: './g' });
    assert.deepEqual(summary(dir), [
      ['tree', join(dir, 'g/Apeiron'), 10_000],
      ['threads.tree', join(dir, 'g/Apeiron/.state'), 3_000],
      ['treeviews', join(dir, 'g/Apeiron/.state'), 3_000],
    ]);
    assert.deepEqual(resolveGraphSettings(dir).warnings, []);
  });

  test('follow the `graph` key in both shapes, a path and an { apeiron, artifacts } pair', () => {
    const pair = config({ graph: { apeiron: './data/A', artifacts: './md' } }, 'pair');
    assert.deepEqual(summary(pair).map((s) => s[1]), [join(pair, 'data/A'), join(pair, 'data/A/.state'), join(pair, 'data/A/.state')]);
    const path = config({ graph: './here' }, 'path');
    assert.deepEqual(summary(path).map((s) => s[1]), [join(path, 'here/Apeiron'), join(path, 'here/Apeiron/.state'), join(path, 'here/Apeiron/.state')]);
  });

  test('are found by the walk up from a directory below the config', () => {
    const dir = config({ graph: './g' });
    const below = join(dir, 'a/b');
    mkdirSync(below, { recursive: true });
    assert.deepEqual(summary(below), summary(dir));
  });

  test('are the dev checkout\'s when no config is found above: the config beside the fallback root is read, and has no `graphs` key', () => {
    const lonely = join(base, 'lonely');
    mkdirSync(lonely);
    assert.deepEqual(summary(lonely), [
      ['tree', FALLBACK_APEIRON, 10_000],
      ['threads.tree', join(FALLBACK_APEIRON, '.state'), 3_000],
      ['treeviews', join(FALLBACK_APEIRON, '.state'), 3_000],
    ]);
  });

  test('follow APERAS_APEIRON_ROOT for the main graph, and the .state/ defaults follow it', () => {
    const dir = config({ graph: './g' });
    process.env.APERAS_APEIRON_ROOT = join(base, 'env');
    assert.deepEqual(summary(dir), [
      ['tree', join(base, 'env'), 10_000],
      ['threads.tree', join(base, 'env/.state'), 3_000],
      ['treeviews', join(base, 'env/.state'), 3_000],
    ]);
  });
});

describe('a `graphs` key', () => {
  test('changes only what it names: a partial table leaves the other settings and graphs at their defaults', () => {
    const dir = config({ graph: './g', graphs: { 'threads.tree': { mirror: './threads' }, treeviews: { flushIntervalMs: 500 } } });
    assert.deepEqual(summary(dir), [
      ['tree', join(dir, 'g/Apeiron'), 10_000],
      ['threads.tree', join(dir, 'threads'), 3_000],
      ['treeviews', join(dir, 'g/Apeiron/.state'), 500],
    ]);
  });

  test('can name all three graphs, in any order, and the result is in the order of the graphs', () => {
    const dir = config({ graph: './g', graphs: { treeviews: { mirror: './v', flushIntervalMs: 1 }, tree: { mirror: './t', flushIntervalMs: 20 }, 'threads.tree': { mirror: '/abs/th', flushIntervalMs: 300 } } });
    assert.deepEqual(summary(dir), [['tree', join(dir, 't'), 20], ['threads.tree', '/abs/th', 300], ['treeviews', join(dir, 'v'), 1]]);
  });

  test('takes a relative `mirror` from the directory of the config file, not the working directory nor the directory it started from', () => {
    const dir = config({ graph: './g', graphs: { 'threads.tree': { mirror: './x' } } });
    const below = join(dir, 'sub');
    mkdirSync(below);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    process.chdir(elsewhere);
    assert.equal(resolveGraphSettings(below).graphs[1]!.directory, join(dir, 'x'));
  });

  test('lets APERAS_APEIRON_ROOT win for the main graph over its entry, and an explicit mirror win over the derived default of the others', () => {
    const dir = config({ graph: './g', graphs: { tree: { mirror: './t' }, 'threads.tree': { mirror: './th' } } });
    process.env.APERAS_APEIRON_ROOT = join(base, 'env');
    assert.deepEqual(summary(dir).map((s) => s[1]), [join(base, 'env'), join(dir, 'th'), join(base, 'env/.state')]);
  });

  test('warns once for an entry keyed tree, and uses the entry', () => {
    const dir = config({ graph: './g', graphs: { tree: { mirror: './t', flushIntervalMs: 77 } } });
    const table = resolveGraphSettings(dir);
    assert.equal(table.warnings.length, 1);
    assert.match(table.warnings[0]!, new RegExp(`${join(dir, 'aperas.config.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: the graphs table has an entry named tree`));
    assert.deepEqual([table.graphs[0]!.directory, table.graphs[0]!.flushIntervalMs], [join(dir, 't'), 77]);
    assert.deepEqual(resolveGraphSettings(config({ graph: './g', graphs: { treeviews: {} } }, 'other')).warnings, [], 'and for no other entry');
  });
});

describe('a table that cannot be one is an error that names the file and the entry', () => {
  const file = (dir: string): string => join(dir, 'aperas.config.json');
  const refused: [string, unknown, RegExp][] = ([
    ['a key that is not a graph name', { graphs: { 'Not_A_Name': {} } }, /graphs entry "Not_A_Name" is not a graph name/],
    ['the reserved name id', { graphs: { id: {} } }, /graphs entry "id" is not a graph name/],
    ['a graph name that is not one of the three', { graphs: { 'other.tree': {} } }, /graphs entry "other.tree" is not one of the graphs of the shell \(tree, threads.tree, treeviews\)/],
    ['a fourth graph under a name of the family', { graphs: { 'views.tree': {} } }, /graphs entry "views.tree" is not one of the graphs/],
    ['an entry that is not an object', { graphs: { tree: 'x' } }, /graphs entry "tree" must be an object/],
    ['an entry that is an array', { graphs: { tree: [] } }, /graphs entry "tree" must be an object/],
    ['a null entry', { graphs: { treeviews: null } }, /graphs entry "treeviews" must be an object/],
    ['a mirror that is not a string', { graphs: { treeviews: { mirror: 3 } } }, /graphs entry "treeviews": "mirror" must be a non-empty string/],
    ['an empty mirror', { graphs: { treeviews: { mirror: '' } } }, /graphs entry "treeviews": "mirror" must be a non-empty string/],
    ['a zero interval', { graphs: { 'threads.tree': { flushIntervalMs: 0 } } }, /graphs entry "threads.tree": "flushIntervalMs" must be a positive finite number/],
    ['a negative interval', { graphs: { tree: { flushIntervalMs: -5 } } }, /graphs entry "tree": "flushIntervalMs" must be a positive finite number/],
    ['an interval in a string', { graphs: { tree: { flushIntervalMs: '3000' } } }, /graphs entry "tree": "flushIntervalMs" must be a positive finite number/],
    ['a null interval', { graphs: { tree: { flushIntervalMs: null } } }, /graphs entry "tree": "flushIntervalMs" must be a positive finite number/],
    ['a table that is an array', { graphs: [] }, /"graphs" must be an object keyed by graph name/],
    ['a table that is null', { graphs: null }, /"graphs" must be an object keyed by graph name/],
  ] as [string, { graphs: unknown }, RegExp][]).map(([why, c, m]) => [why, { graph: './g', ...c }, m]);
  for (const [why, content, message] of refused) {
    test(why, () => {
      const dir = config(content);
      assert.throws(() => resolveGraphSettings(dir), (e: Error) => message.test(e.message) && e.message.startsWith(file(dir)));
    });
  }

  test('an interval that is not finite (a number past the range of a double)', () => {
    const dir = config('{ "graph": "./g", "graphs": { "tree": { "flushIntervalMs": 1e999 } } }');
    assert.throws(() => resolveGraphSettings(dir), /"flushIntervalMs" must be a positive finite number/);
  });

  test('a config that is not JSON keeps the existing error', () => {
    const dir = config('{ not json');
    assert.throws(() => resolveGraphSettings(dir), (e: Error) => e.message.startsWith(`${file(dir)} isn't valid JSON`));
  });

  test('is not refused for an entry with a setting alone, an empty entry, or an empty table', () => {
    for (const graphs of [{}, { tree: {} }, { treeviews: { flushIntervalMs: 1 } }, { 'threads.tree': { mirror: 'x' } }]) {
      assert.doesNotThrow(() => resolveGraphSettings(config({ graph: './g', graphs }, 'ok')), JSON.stringify(graphs));
    }
  });
});
