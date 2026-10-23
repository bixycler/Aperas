// The runner itself (`run.mjs`), on small trees built in a scratch directory (`--tests-dir`): suite
// nesting, the exit-2 refusals, `--case` with no match, `--list`, groups, the unlisted-file warning,
// the budget warning of the reporter, a suite run directly, `--help`, the header line and the suite name in the summary. Nothing here touches the real tests.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const RUNNER = join(import.meta.dirname, '..', 'run.mjs');
const SUITE_HELPER = join(import.meta.dirname, '..', 'support', 'suite.mjs');

let root = '';
let counter = 0;

/** Writes `files` (relative path -> content) under a fresh tests directory and returns it. */
function tree(files: Record<string, string>): string {
  const dir = join(root, `t${counter++}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
const passing = (name: string): string => `import { test } from 'node:test';\ntest('${name}', () => {});\n`;
const suite = (...members: string[]): string => `export default ${JSON.stringify(members)};\n`;
function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [RUNNER, '--tests-dir', dir, ...args], { encoding: 'utf8', env: cleanEnv(env), timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** The environment for a runner started from inside this test: the outer run's `NODE_TEST_CONTEXT` would make the inner one skip its files. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NT_BUDGET_S;
  return env;
}
const lines = (text: string): string[] => text.split('\n').filter(Boolean);

describe('runner', () => {
  before(() => { root = mkdtempSync(join(tmpdir(), 'runner-test-')); });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('suite nesting resolves, in order, each file once', () => {
    const dir = tree({
      'g1/a.test.ts': passing('a'), 'g1/b.test.ts': passing('b'), 'g2/c.test.ts': passing('c'),
      'suites/inner.suite.mjs': suite('../g1/b.test.ts', '../g2/c.test.ts'),
      'suites/commit.suite.mjs': suite('../g1/a.test.ts', './inner.suite.mjs', '../g1/b.test.ts'),
    });
    const r = run(dir, ['--list']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.stdout), ['g1/a.test.ts', 'g1/b.test.ts', 'g2/c.test.ts']);
    assert.deepEqual(lines(run(dir, ['--list', '--suite', 'inner']).stdout), ['g1/b.test.ts', 'g2/c.test.ts']);
  });

  test('a suite cycle exits 2', () => {
    const dir = tree({
      'g/a.test.ts': passing('a'),
      'suites/commit.suite.mjs': suite('./other.suite.mjs'),
      'suites/other.suite.mjs': suite('../g/a.test.ts', './commit.suite.mjs'),
    });
    const r = run(dir, ['--list']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /suite cycle: commit\.suite\.mjs -> other\.suite\.mjs -> commit\.suite\.mjs/);
  });

  test('a missing member exits 2', () => {
    const dir = tree({ 'g/a.test.ts': passing('a'), 'suites/commit.suite.mjs': suite('../g/a.test.ts', '../g/gone.test.ts') });
    const r = run(dir, []);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing member: \.\.\/g\/gone\.test\.ts/);
  });

  test('--list prints the resolved files and runs nothing', () => {
    const dir = tree({
      'g/boom.test.ts': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, 'ran-marker'))}, 'ran');\n`,
      'suites/commit.suite.mjs': suite('../g/boom.test.ts'),
    });
    const r = run(dir, ['--list']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.stdout), ['g/boom.test.ts']);
    assert.equal(existsSync(join(root, 'ran-marker')), false);
  });

  test('--case with no match exits 1; a match runs and exits 0', () => {
    const dir = tree({ 'g/a.test.ts': passing('alpha'), 'suites/commit.suite.mjs': suite('../g/a.test.ts') });
    const none = run(dir, ['--case', 'zzz-nothing']);
    assert.equal(none.status, 1, none.stdout + none.stderr);
    assert.match(none.stderr, /matched no case/);
    const some = run(dir, ['--case', 'alpha']);
    assert.equal(some.status, 0, some.stdout + some.stderr);
    assert.match(some.stdout, /ok .* g\/a\.test\.ts :: alpha/);
    assert.match(some.stdout, /SUMMARY suite=commit ran=1 passed=1 failed=0/);
  });

  test('a failing case exits 1 and names the case', () => {
    const dir = tree({ 'g/f.test.ts': `import { test } from 'node:test';\ntest('bad', () => { throw new Error('nope'); });\n`, 'suites/commit.suite.mjs': suite('../g/f.test.ts') });
    const r = run(dir, []);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL .* g\/f\.test\.ts :: bad/);
  });

  test('--group selects a directory, with --suite it intersects, an unknown group exits 2', () => {
    const dir = tree({
      'g1/a.test.ts': passing('a'), 'g1/b.test.ts': passing('b'), 'g2/c.test.ts': passing('c'),
      'suites/commit.suite.mjs': suite('../g1/a.test.ts', '../g2/c.test.ts'),
    });
    assert.deepEqual(lines(run(dir, ['--list', '--group', 'g1']).stdout), ['g1/a.test.ts', 'g1/b.test.ts']);
    assert.deepEqual(lines(run(dir, ['--list', '--group', 'g1', '--suite', 'commit']).stdout), ['g1/a.test.ts']);
    const bad = run(dir, ['--list', '--group', 'nope']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /no such group: nope/);
  });

  test('a test file in no suite is a warning, not a failure', () => {
    const dir = tree({ 'g/a.test.ts': passing('a'), 'g/lost.test.ts': passing('lost'), 'legacy/old.test.ts': passing('old'), 'suites/commit.suite.mjs': suite('../g/a.test.ts') });
    const r = run(dir, ['--list']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /warning: 1 test file\(s\) in no suite: g\/lost\.test\.ts/);
    assert.deepEqual(lines(r.stdout), ['g/a.test.ts']);
  });

  test('the reporter warns on a case that ends past the suite budget, and a suite with no budget never warns', () => {
    const slowCase = `import { test } from 'node:test';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 1100)); });\n`;
    const budgeted = (seconds: number | string): string =>
      `import { defineSuite } from ${JSON.stringify(SUITE_HELPER)};\nexport default defineSuite(import.meta.url, ['../g/a.test.ts'], ${seconds});\n`;
    const dir = tree({
      'g/a.test.ts': slowCase,
      'suites/commit.suite.mjs': budgeted(1),
      'suites/open.suite.mjs': `import { defineSuite } from ${JSON.stringify(SUITE_HELPER)};\nexport default defineSuite(import.meta.url, ['../g/a.test.ts']);\n`,
      'suites/roomy.suite.mjs': budgeted(60),
    });
    const over = run(dir, []);
    assert.equal(over.status, 0, over.stdout + over.stderr);
    assert.match(over.stdout, /WARN the run is over 1 s \(\d+ s so far\) at g\/a\.test\.ts :: slow/);
    assert.doesNotMatch(run(dir, ['--suite', 'roomy']).stdout, /WARN/);
    const open = run(dir, ['--suite', 'open']);
    assert.equal(open.status, 0, open.stdout + open.stderr);
    assert.doesNotMatch(open.stdout, /WARN/);
    assert.match(run(dir, ['--group', 'g']).stdout, /WARN the run is over 1 s/); // a group alone uses the commit budget
  });

  test('a suite budget that is not a positive number of seconds is refused', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { defineSuite } from ${JSON.stringify(SUITE_HELPER)}; defineSuite('file:///x.suite.mjs', [], 0);`], { encoding: 'utf8', env: cleanEnv() });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /a suite budget is a positive number of seconds, got 0/);
  });

  test('a suite run directly runs its members through the runner', () => {
    const dir = tree({
      'g/a.test.ts': passing('direct'),
      'suites/mine.suite.mjs': `import { defineSuite } from ${JSON.stringify(SUITE_HELPER)};\nexport default defineSuite(import.meta.url, ['../g/a.test.ts']);\n`,
    });
    const r = spawnSync(process.execPath, [join(dir, 'suites', 'mine.suite.mjs')], { encoding: 'utf8', env: cleanEnv(), timeout: 30000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ok .* \S*g\/a\.test\.ts :: direct/);
  });

  test('--help exits 0 and names the suites with their budgets, the groups and the options; an unknown argument still exits 2', () => {
    const real = join(import.meta.dirname, '..');
    const r = run(real, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: run\.mjs/);
    assert.match(r.stdout, /^ {2}essential +5 s +\d+ files?/m);
    assert.match(r.stdout, /^ {2}commit +60 s +\d+ files?/m);
    assert.match(r.stdout, /^ {2}models +30 s +\d+ files?/m);
    assert.match(r.stdout, /^ {2}tools +30 s +\d+ files?/m);
    assert.match(r.stdout, /^ {2}differential +40 s +\d+ files?/m);
    assert.match(r.stdout, /^ {2}demand +no budget +\d+ files?/m);
    assert.match(r.stdout, /^ {2}runner +2 files/m);
    for (const name of ['essential', 'commit', 'models', 'tools', 'differential', 'demand']) {
      const line = lines(r.stdout).find((l) => l.startsWith(`  ${name} `));
      assert.ok(line, name);
      assert.match(line, /(\.|\.\.\.)$/, `${name}: description ends with a period or an ellipsis`);
    }
    for (const option of ['--suite', '--group', '--case', '--list', '--concurrency', '--timeout', '--help']) assert.ok(r.stdout.includes(option), option);
    assert.deepEqual(lines(run(real, ['-h']).stdout), lines(r.stdout));
    const bad = run(real, ['--bogus']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown argument --bogus/);
  });

  test('a run starts with a header naming the suite, its budget and its file count; --list prints no header', () => {
    const budgeted = (seconds: number | string, ...members: string[]): string =>
      `import { defineSuite } from ${JSON.stringify(SUITE_HELPER)};\nexport default defineSuite(import.meta.url, ${JSON.stringify(members)}${seconds === '' ? '' : `, ${seconds}`});\n`;
    const dir = tree({
      'g1/a.test.ts': passing('a'), 'g1/b.test.ts': passing('b'), 'g2/c.test.ts': passing('c'),
      'suites/commit.suite.mjs': budgeted(60, '../g1/a.test.ts', '../g2/c.test.ts'),
      'suites/open.suite.mjs': budgeted('', '../g1/a.test.ts', '../g1/b.test.ts', '../g2/c.test.ts'),
    });
    const first = (r: { stdout: string }): string => lines(r.stdout)[0];
    assert.equal(first(run(dir, [])), 'suite commit (budget 60 s) - 2 files, concurrency 2, timeout 120 s a file');
    assert.equal(first(run(dir, ['--suite', 'open', '--concurrency', '1'])), 'suite open (no budget) - 3 files, concurrency 1, timeout 900 s a file');
    assert.equal(first(run(dir, ['--group', 'g1'])), "group g1 (commit's budget 60 s) - 2 files, concurrency 2, timeout 120 s a file");
    assert.equal(first(run(dir, ['--suite', 'open', '--group', 'g1', '--timeout', '5000'])), 'suite open (no budget) group g1 - 2 files, concurrency 2, timeout 5 s a file');
    assert.equal(first(run(dir, ['--case', 'a'])), 'suite commit (budget 60 s) - 2 files, concurrency 2, timeout 120 s a file, case "a"');
    assert.deepEqual(lines(run(dir, ['--list']).stdout), ['g1/a.test.ts', 'g2/c.test.ts']);
  });

  test('the summary line carries the suite name', () => {
    const dir = tree({
      'g/a.test.ts': passing('a'),
      'suites/commit.suite.mjs': suite('../g/a.test.ts'),
      'suites/other.suite.mjs': suite('../g/a.test.ts'),
    });
    assert.match(run(dir, []).stdout, /^SUMMARY suite=commit ran=1 passed=1 failed=0/m);
    assert.match(run(dir, ['--suite', 'other']).stdout, /^SUMMARY suite=other ran=1 passed=1 failed=0/m);
    assert.match(run(dir, ['--group', 'g']).stdout, /^SUMMARY suite=group:g ran=1/m);
  });
});
