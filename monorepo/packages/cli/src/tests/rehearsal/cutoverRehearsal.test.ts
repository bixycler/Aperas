// The cutover rehearsal (planning/core.md, Batch 13, piece 1): `scripts/cutover-rehearsal.py` copies a graph root's `Apeiron/` to a scratch git
// repository with a baseline commit, migrates it, checks the migration, loads the result with the new engine in a child process and compares the
// dump with the files byte for byte. This test runs it on a fixture mirror in the old form (a `predicate` on its links, a tombstone that keeps its
// structure, an artifact with a `type`, an `unfolds` entry that names nothing, the profile `dinhlx` without a `kind`, the twelve README documents),
// where it must pass, and then with a mutation that breaks each of its checks, where it must exit 1 and name the step that fails. A mutation is a
// changed copy of `migrate-mirror.py` (given with `--tools`) or a changed fixture. It refuses the real graph root and writes nothing for a refusal.
// Only scratch roots are used; the real mirror is never read.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REAL_GRAPH, assertNotRealMirror } from '../support/fixture.ts';
import { B_CHILD, B_TWO, P_BARE, idOf, writeTexts } from '../support/mirrorFixture.ts';
import { oldFormTexts } from '../support/oldFormMirror.ts';

const SCRIPTS = resolve(import.meta.dirname, '../../../../../scripts');
const REHEARSAL = join(SCRIPTS, 'cutover-rehearsal.py');
const MIGRATE = join(SCRIPTS, 'migrate-mirror.py');
const VERIFY = join(SCRIPTS, 'verify-migration.py');

interface Outcome { status: number; stdout: string; stderr: string; steps: Record<string, string> }

function rehearse(args: string[]): Promise<Outcome> {
  return new Promise((done) => {
    execFile('python3', [REHEARSAL, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: { ...process.env, LD_LIBRARY_PATH: undefined } }, (error, stdout, stderr) => {
      const steps: Record<string, string> = {};
      for (const m of stdout.matchAll(/^(\d) \S.*?\s+(ok|FAIL)\s+[\d.]+\s/gm)) steps[m[1]!] = m[2]!;
      const status = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : -1;
      done({ status, stdout, stderr, steps });
    });
  });
}

describe('the cutover rehearsal', { concurrency: true }, () => {
  let work: string;
  const scratch = (name: string): string => join(work, name);
  /** A graph root with the fixture mirror in the old form, under the scratch directory. */
  const rootOf = (name: string, texts: Record<string, string> = oldFormTexts()): string => {
    const root = scratch(name);
    writeTexts(root, texts);
    return root;
  };
  /** A directory with copies of the two scripts, the first changed by `edit` (each replacement must match once). */
  const toolsWith = (name: string, edits: [string, string][]): string => {
    const dir = scratch(name);
    mkdirSync(dir, { recursive: true });
    let text = readFileSync(MIGRATE, 'utf8');
    for (const [from, to] of edits) {
      assert.equal(text.split(from).length - 1, 1, `the mutation target is not in migrate-mirror.py exactly once: ${from}`);
      text = text.replace(from, () => to);
    }
    writeFileSync(join(dir, 'migrate-mirror.py'), text);
    copyFileSync(VERIFY, join(dir, 'verify-migration.py'));
    return dir;
  };

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'aperas-rehearsal-test-'));
    assertNotRealMirror(work);
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  test('passes on a mirror in the old form, and leaves the migrated copy next to a baseline commit of the unmigrated one', async () => {
    const root = rootOf('root-pass');
    const out = scratch('out-pass');
    const r = await rehearse([root, '--out', out]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /REHEARSAL: PASS/);
    assert.deepEqual(r.steps, { 1: 'ok', 2: 'ok', 3: 'ok', 4: 'ok', 5: 'ok', 6: 'ok', 7: 'ok' });
    assert.match(r.stdout, /unexpected differences 0, links with a predicate 0/);
    assert.match(r.stdout, /8 of 8 files identical/);
    // The migrated copy is in `out`, the baseline commit holds the files as they were, and the graph root was only read.
    const migrated = readFileSync(join(out, 'Apeiron/BlockNode.jsonld'), 'utf8');
    assert.ok(!migrated.includes('predicate'));
    const git = (...args: string[]): string => spawnSync('git', args, { cwd: out, encoding: 'utf8' }).stdout;
    assert.ok(git('show', 'HEAD:Apeiron/BlockNode.jsonld').includes('predicate'));
    assert.equal(git('log', '--format=%s').trim(), 'baseline');
    assert.ok(!existsSync(join(out, 'Apeiron/ArtifactNode.jsonld')) || !readFileSync(join(out, 'Apeiron/ArtifactNode.jsonld'), 'utf8').includes('00CN1QE950000'), 'the README artifacts are deleted');
    assert.equal(readFileSync(join(root, 'Apeiron/BlockNode.jsonld'), 'utf8'), oldFormTexts()['Apeiron/BlockNode.jsonld']);
  });

  test('refuses the real graph root, an output directory that is not empty, a root without Apeiron and an output inside the root, and writes nothing', async () => {
    const out = scratch('out-refused');
    const real = await rehearse([REAL_GRAPH, '--out', out]);
    assert.equal(real.status, 2, real.stdout + real.stderr);
    assert.match(real.stderr, /real graph root/);
    assert.ok(!existsSync(out), 'nothing was made for a refused run');

    const root = rootOf('root-refuse');
    mkdirSync(scratch('out-full'));
    writeFileSync(join(scratch('out-full'), 'x'), '');
    assert.equal((await rehearse([root, '--out', scratch('out-full')])).status, 2);
    assert.equal((await rehearse([scratch('no-such-root'), '--out', out])).status, 2);
    assert.equal((await rehearse([root, '--out', join(root, 'inside')])).status, 2);
    assert.deepEqual(readdirSync(scratch('out-full')), ['x']);
    assert.equal((await rehearse([])).status, 2);
  });

  const breaks: [string, () => Promise<Outcome>, string][] = [
    ['the dry run writes', () => rehearse([rootOf('root-m1'), '--out', scratch('out-m1'), '--tools', toolsWith('tools-m1', [['    if not dry:\n        for f in really:', '    if True:\n        for f in really:']])]), '2'],
    ['the migration ends with a failure', () => rehearse([rootOf('root-m2'), '--out', scratch('out-m2'), '--tools', toolsWith('tools-m2', [['    return 0\n\n\nif __name__', '    return 0 if dry else 2\n\n\nif __name__']])]), '3'],
    ['the migration leaves a rule out (the type of an artifact stays)', () => rehearse([rootOf('root-m3'), '--out', scratch('out-m3'), '--tools', toolsWith('tools-m3', [['    if "6" in rules:', '    if "6" in rules and False:']])]), '4'],
    ['a second run changes a byte', () => rehearse([rootOf('root-m4'), '--out', scratch('out-m4'), '--tools', toolsWith('tools-m4', [['    return 0\n\n\nif __name__', '    if not dry and not really:\n        with open(sorted(files)[0], "a") as h:\n            h.write("\\n")\n    return 0\n\n\nif __name__']])]), '5'],
    ['the load warns (a container lists a child that another parent owns)', () => rehearse([rootOf('root-m5', oldFormTexts((docs) => { docs['Apeiron/BlockNode.jsonld']!.find((d) => d['@id'] === B_TWO)!.children.push(B_CHILD); })), '--out', scratch('out-m5')]), '6'],
    ['a file is not in the canonical form (the keys of a profile are out of order)', () => rehearse([rootOf('root-m6', oldFormTexts((docs) => { const i = docs['Apeiron/Profile.jsonld']!.findIndex((d) => d['@id'] === P_BARE); const d = docs['Apeiron/Profile.jsonld']![i]!; docs['Apeiron/Profile.jsonld']![i] = { handle: d.handle, '@type': d['@type'], '@id': d['@id'] }; })), '--out', scratch('out-m6')]), '7'],
    ['a document names a parent that exists nowhere', () => rehearse([rootOf('root-m7', oldFormTexts((docs) => { docs['Apeiron/BlockNode.jsonld']!.push({ '@id': idOf('BlockNode', 7777), '@type': 'BlockNode', title: 'lost', parent: idOf('BlockNode', 7778), type: 'paragraph', children: [] }); })), '--out', scratch('out-m7')]), '4'],
  ];
  for (const [name, run, step] of breaks) {
    test(`exits 1 and names step ${step} when ${name}`, async () => {
      const r = await run();
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /REHEARSAL: FAIL/);
      assert.equal(r.steps[step], 'FAIL', r.stdout);
      for (let k = 1; k < Number(step); k++) assert.equal(r.steps[String(k)], 'ok', `step ${k} before the one that breaks: ${r.stdout}`);
    });
  }
});
