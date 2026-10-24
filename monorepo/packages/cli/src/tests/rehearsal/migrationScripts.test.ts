// The migration scripts (planning/core.md, Batch 9 step 6): `scripts/migrate-mirror.py` and its checker `scripts/verify-migration.py`. Their default is the four general rules (1, 2, 5, 6): the six `README.md`
// artifacts (rule 3) and the profile `dinhlx` (rule 4) are this project's own graph, and `--rules 123456` (or `--rules 34`) opts in. The first argument of both is the graph root: one that starts with `-`
// (`--help`) or is not a directory that holds `Apeiron/` is a usage error, exit 2, a usage line, and nothing is read or written. Only scratch roots are used (a fixture mirror in the old form, with or without the project's own
// documents, in a git repository with a baseline commit, which the checker needs); the real mirror is never read.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNotRealMirror } from '../support/fixture.ts';
import { writeTexts } from '../support/mirrorFixture.ts';
import { oldFormTexts } from '../support/oldFormMirror.ts';

const SCRIPTS = resolve(import.meta.dirname, '../../../../../scripts');
const MIGRATE = join(SCRIPTS, 'migrate-mirror.py');
const VERIFY = join(SCRIPTS, 'verify-migration.py');
const DINHLX = 'Profile:00CJC4S69R000';

const py = (script: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('python3', [script, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, LD_LIBRARY_PATH: undefined } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const git = (cwd: string, ...args: string[]): string => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).stdout;
const files = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.jsonld')).sort();
const read = (root: string, name: string): string => readFileSync(join(root, 'Apeiron', name), 'utf8');

describe('the migration scripts', () => {
  let work: string;
  let n = 0;
  /** A graph root with the fixture mirror in the old form, in a git repository whose one commit is that baseline. */
  function graph(projectDocs: boolean): string {
    const root = join(work, `g${n++}`);
    writeTexts(root, oldFormTexts(() => {}, { projectDocs }));
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'baseline');
    return root;
  }
  before(() => {
    work = mkdtempSync(join(tmpdir(), 'aperas-migration-scripts-'));
    assertNotRealMirror(work);
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  test('the default is the general rules: a graph without the project documents migrates, and the checker passes', () => {
    const root = graph(false);
    const m = py(MIGRATE, [root]);
    assert.equal(m.status, 0, m.stdout + m.stderr);
    assert.ok(!read(root, 'BlockNode.jsonld').includes('predicate'), 'rule 1');
    assert.ok(!read(root, 'ArtifactNode.jsonld').includes('"type": "document"'), 'rule 6');
    assert.match(m.stdout, /profiles_changed\s+0/);
    const v = py(VERIFY, [root]);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /UNEXPECTED differences: 0/);
    assert.equal(py(MIGRATE, [root]).stdout.match(/files that differ after the rules: (\d+)/)?.[1], '0', 'a second run changes nothing');
  });

  test('the default leaves the project documents alone, and rules 3 and 4 are opt-in', () => {
    const root = graph(true);
    const m = py(MIGRATE, [root]);
    assert.equal(m.status, 0, m.stdout + m.stderr);
    assert.match(m.stdout, /deleted_mirror\s+0/);
    assert.ok(read(root, 'ArtifactNode.jsonld').includes('00CN1QE950000'), 'the README artifacts stay');
    const dinhlx = (JSON.parse(read(root, 'Profile.jsonld')) as Array<Record<string, unknown>>).find((d) => d['@id'] === DINHLX)!;
    assert.equal(dinhlx.kind, undefined, 'dinhlx gets no kind');
    const v = py(VERIFY, [root]);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    // the opt-in rules, run on the migrated graph, do their parts; the checker then names them
    const more = py(MIGRATE, [root, '--rules', '34']);
    assert.equal(more.status, 0, more.stdout + more.stderr);
    assert.match(more.stdout, /deleted_mirror\s+12/);
    assert.ok(!read(root, 'ArtifactNode.jsonld').includes('00CN1QE950000'));
    assert.match(read(root, 'Profile.jsonld'), /"kind": "human"/);
    // all six at once on a fresh copy give the same bytes as the default and then 3 and 4
    const all = graph(true);
    assert.equal(py(MIGRATE, [all, '--rules', '123456']).status, 0);
    assert.equal(py(VERIFY, [all, '--rules', '123456']).status, 0);
    for (const f of files(join(all, 'Apeiron'))) assert.equal(readFileSync(join(all, 'Apeiron', f), 'utf8'), readFileSync(join(root, 'Apeiron', f), 'utf8'), f);
  });

  test('rule 4 on a graph that lacks the profile is a stop condition that writes nothing, and the default needs neither document', () => {
    const root = graph(false);
    const before = files(join(root, 'Apeiron')).map((f) => read(root, f));
    const m = py(MIGRATE, [root, '--rules', '123456']);
    assert.equal(m.status, 2, m.stdout + m.stderr);
    assert.match(m.stdout, /STOP/);
    assert.deepEqual(files(join(root, 'Apeiron')).map((f) => read(root, f)), before, 'nothing was written');
    assert.equal(git(root, 'status', '--porcelain').trim(), '');
  });

  for (const [name, script] of [['migrate-mirror.py', MIGRATE], ['verify-migration.py', VERIFY]] as const) {
    test(`${name}: a first argument that starts with "-" or is not a directory that holds Apeiron/ is a usage error, with a usage line, and nothing is read or written`, () => {
      const root = graph(true);
      const before = files(join(root, 'Apeiron')).map((f) => read(root, f));
      const missing = join(work, 'no-such-directory');
      const empty = mkdtempSync(join(work, 'empty-'));
      const noApeiron = mkdtempSync(join(work, 'no-apeiron-'));
      writeFileSync(join(noApeiron, 'other.jsonld'), '[]\n');
      for (const args of [['--help'], ['-h'], ['--rules', '123456'], [missing], [empty], [noApeiron], [noApeiron, '--dry'], [empty, '--roundtrip'], [join(root, 'Apeiron', 'BlockNode.jsonld')], ['--dry', root]]) {
        const r = py(script, args);
        assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /usage/, `${args.join(' ')}: a usage line`);
        assert.equal(r.stdout, '', `${args.join(' ')}: nothing on stdout`);
      }
      assert.ok(!existsSync(missing), 'nothing was created');
      assert.deepEqual(readdirSync(empty), [], 'the empty directory is still empty');
      assert.deepEqual(readdirSync(noApeiron), ['other.jsonld'], 'the directory without Apeiron/ is as it was');
      // the passing case: a graph root that holds Apeiron/ runs (the checker of an unmigrated graph reports differences, and its passing runs are in the tests above)
      if (script === MIGRATE) {
        const ok = py(script, [root, '--dry']);
        assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      } else assert.notEqual(py(script, [root]).status, 2, 'a graph root is not a usage error');
      assert.deepEqual(files(join(root, 'Apeiron')).map((f) => read(root, f)), before);
      assert.equal(git(root, 'status', '--porcelain').trim(), '', 'the tree is as committed');
    });
  }
});
