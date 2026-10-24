// The real suites against the real test files: every test file outside `corpus/` is in exactly one of `commit`, `models`,
// `tools`, `cutover` and `differential`; the corpus files are in none of the five and only in `demand`; `essential` is inside `commit`; `demand`
// lists the five and the corpus files. Reads the suites through the runner's `--list`; runs no test.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const TESTS = join(import.meta.dirname, '..');
const RUNNER = join(TESTS, 'run.mjs');
const NOT_GROUPS = new Set(['suites', 'support', 'legacy']);

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith('.test.ts') ? [p] : [];
  });
}
/** Every test file on disk, relative to the tests directory, outside `legacy/`, `support/` and `suites/`. */
function onDisk(): string[] {
  return readdirSync(TESTS).sort().flatMap((n) => (statSync(join(TESTS, n)).isDirectory() && !NOT_GROUPS.has(n) ? walk(join(TESTS, n)) : []))
    .map((f) => relative(TESTS, f).split(sep).join('/'));
}
function listed(suite: string): string[] {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, '--list', '--suite', suite], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}

describe('suites', () => {
  const commit = listed('commit');
  const models = listed('models');
  const tools = listed('tools');
  const cutover = listed('cutover');
  const differential = listed('differential');
  const demand = listed('demand');
  const essential = listed('essential');
  const disk = onDisk();
  const corpus = disk.filter((f) => f.startsWith('corpus/'));

  test('every test file outside the corpus is in exactly one of commit, models, tools, cutover and differential', () => {
    for (const f of disk.filter((f) => !f.startsWith('corpus/'))) {
      const homes = [['commit', commit], ['models', models], ['tools', tools], ['cutover', cutover], ['differential', differential]].filter(([, list]) => (list as string[]).includes(f)).map(([n]) => n);
      assert.equal(homes.length, 1, `${f} is in ${homes.length === 0 ? 'none of commit, models, tools, cutover and differential' : homes.join(' and ')}`);
    }
  });

  test('the corpus files are in none of commit, models, tools, cutover and differential, and every one is in demand', () => {
    assert.ok(corpus.length > 0);
    for (const f of corpus) {
      for (const [name, list] of [['commit', commit], ['models', models], ['tools', tools], ['cutover', cutover], ['differential', differential]] as const) assert.ok(!list.includes(f), `${f} is in ${name}`);
      assert.ok(demand.includes(f), `${f} is not in demand`);
    }
  });

  test('no suite names a file that is not on disk, and essential is inside commit', () => {
    const all = new Set(disk);
    for (const f of [...commit, ...models, ...tools, ...cutover, ...differential, ...demand, ...essential]) assert.ok(all.has(f), `${f} is not a test file on disk`);
    for (const f of essential) assert.ok(commit.includes(f), `${f} is in essential and not in commit`);
  });

  test('demand is exactly the five suites and the corpus files', () => {
    assert.deepEqual([...demand].sort(), [...new Set([...commit, ...models, ...tools, ...cutover, ...differential, ...corpus])].sort());
  });
});
