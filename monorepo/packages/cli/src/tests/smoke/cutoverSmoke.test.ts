// The smoke list of the cutover (planning/core.md, Batch 13, piece 8): `scripts/cutover-smoke.sh` takes the command to run (a shim) and prints one PASS or FAIL line per check,
// then `SMOKE: PASS` or `SMOKE: FAIL` and its status. It is run here against a real scratch service on the small corpus of the command tests, through a shim that is the
// real one (`cd monorepo && exec tsx packages/cli/src/aperas.ts "$@"`) in the environment of the harness (run directory, port and both roots are the scratch ones):
//   1. the clean corpus: every check passes, the write leaves no block and no byte in the mirror, and the service is up again at the end;
//   2. the file of one document is changed on disk after the projection (the disagreement `track --reverse` does not report: it reports the graph being ahead of the disk, not the disk
//      being ahead of the graph): the `project --dry-run` of that document FAILs, the status is 1, and the write checks are skipped, so the mirror is untouched;
//   3. no service answering: the first check FAILs at once and nothing else is run (and no service is started);
//   4. a usage error ends with status 2 and runs nothing.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, projectToDisk } from '../support/commandsCorpus.ts';
import { dumpMirror, isolateService, leftoverProcesses, startService, stopService, type ServiceIsolation } from '../support/serviceHarness.ts';
import { readLock } from '../../service/serviceLock';
import { ping } from '../../service/serviceClient';

const MONOREPO = resolve(import.meta.dirname, '../../../../..');
const SMOKE = join(MONOREPO, 'scripts', 'cutover-smoke.sh');

interface Outcome { status: number; lines: string[]; stdout: string; stderr: string }

describe('scripts/cutover-smoke.sh on a scratch service with the small corpus', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let shim: string;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const smoke = (args: string[]): Promise<Outcome> => new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.LD_LIBRARY_PATH;
    execFile('bash', [SMOKE, ...args], { encoding: 'utf8', env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const status = error ? ((error as { code?: number }).code ?? -1) : 0;
      done({ status: typeof status === 'number' ? status : -1, lines: stdout.split('\n').filter(Boolean), stdout, stderr });
    });
  });
  const hashes = (): Record<string, string> => {
    const found: Record<string, string> = {};
    for (const dir of [fx.apeironRoot, join(fx.apeironRoot, '.state')]) {
      for (const name of readdirSync(dir)) if (name.endsWith('.jsonld')) found[`${dir === fx.apeironRoot ? '' : '.state/'}${name}`] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
    }
    return found;
  };
  const checks = (o: Outcome): string[] => o.lines.filter((l) => /^(PASS|FAIL) /.test(l));
  const has = (o: Outcome, verdict: 'PASS' | 'FAIL', fragment: string): boolean => checks(o).some((l) => l.startsWith(verdict) && l.includes(fragment));
  const common = (): string[] => ['--expect-root', fx.root, '--docs', '3', '--parent', 'cmd_demo/dup.md'];

  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    buildCorpus(fx);
    for (const file of ['alpha', 'beta', 'dup']) projectToDisk(fx, `cmd_demo/${file}.md`, true); // the disk holds what the graph renders (gamma.md holds a placeholder, which does not project, and is left out by --docs 3)
    dumpMirror(fx);
    iso = await isolateService(fx);
    shim = join(fx.root, 'aperas-shim');
    writeFileSync(shim, `#!/bin/sh\ncd ${MONOREPO} && exec env -u LD_LIBRARY_PATH node_modules/.bin/tsx packages/cli/src/aperas.ts "$@"\n`);
    chmodSync(shim, 0o755);
  });
  after(async () => {
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('the clean corpus: every check passes, the scratch node leaves nothing in the mirror, the service is up at the end', async () => {
    await startService(iso);
    const atRest = hashes();
    const pid = readLock()!.pid;
    const o = await smoke([shim, ...common()]);
    assert.equal(o.status, 0, o.stdout + o.stderr);
    assert.equal(o.lines.at(-1)?.startsWith('SMOKE: PASS ('), true, o.stdout);
    assert.deepEqual(o.lines.filter((l) => l.startsWith('FAIL') || l.startsWith('SKIP')), []);
    for (const fragment of ['check-links: ', 'binding: graph ', 'track --reverse: ', 'tree cmd_demo/alpha.md', 'tree cmd_demo/beta.md', 'tree cmd_demo/dup.md', 'show ArtifactNode:', 'project --dry-run cmd_demo/alpha.md',
      'project --dry-run cmd_demo/beta.md', 'project --dry-run cmd_demo/dup.md', 'which is not a child of cmd_demo/dup.md: refused', 'write: insert of the scratch paragraph',
      'write: remove ', 'flush', 'service stop', 'service start', 'check-links after the restart', 'after the restart: names no node']) {
      assert.ok(has(o, 'PASS', fragment), `no PASS line for "${fragment}":\n${o.stdout}`);
    }
    for (const l of checks(o)) assert.match(l, /^PASS {2}\s*\d+\.\d\ds {2}\S/, l);
    assert.notEqual(readLock()?.pid, pid, 'the script stopped the service and started another');
    assert.equal(await ping(), true, 'the service answers at the end');
    assert.deepEqual(hashes(), atRest, 'the mirror is byte for byte what it was before the write: the stop pruned the scratch tombstone');
  });

  test('a document changed on disk after its projection fails its dry-run check, and the write checks are skipped', async () => {
    const file = join(fx.artifactsRoot, 'cmd_demo', 'beta.md');
    const original = readFileSync(file, 'utf-8');
    writeFileSync(file, `${original}\nA line the graph does not hold.\n`);
    try {
      const unchanged = hashes();
      const o = await smoke([shim, ...common()]);
      assert.equal(o.status, 1, o.stdout);
      assert.ok(has(o, 'FAIL', 'project --dry-run cmd_demo/beta.md'), o.stdout);
      assert.ok(has(o, 'PASS', 'project --dry-run cmd_demo/alpha.md'), o.stdout);
      assert.ok(o.lines.some((l) => l.startsWith('SKIP') && l.includes('write checks')), o.stdout);
      assert.ok(o.lines.at(-1)?.startsWith('SMOKE: FAIL (1 of '), o.stdout);
      assert.equal(checks(o).some((l) => l.includes('write:') || l.includes('service stop')), false, 'no write check ran');
      assert.deepEqual(hashes(), unchanged, 'nothing was written');
      assert.equal(await ping(), true);
    } finally { writeFileSync(file, original); }
  });

  test('no service answering: the first check fails and nothing else runs; no service is started', async () => {
    assert.equal(await stopService(iso), true);
    const o = await smoke([shim, ...common()]);
    assert.equal(o.status, 1, o.stdout);
    assert.equal(checks(o).length, 1, o.stdout);
    assert.ok(has(o, 'FAIL', 'check-links'), o.stdout);
    assert.ok(o.lines.at(-1)?.includes('the service does not answer'), o.stdout);
    await sleep(200);
    assert.equal(readLock(), null, 'no lock: no service was started');
    assert.equal(existsSync(iso.runDir) ? readdirSync(iso.runDir).includes('apeironngn.sock') : false, false);
  });

  test('a usage error ends with status 2 and runs nothing', async () => {
    for (const args of [[shim, '--docs', '0'], [shim, '--docs'], [shim, '--nope'], [shim, 'extra'], ['no-such-command-for-the-smoke']]) {
      const o = await smoke(args);
      assert.equal(o.status, 2, `${args.join(' ')}: ${o.stdout}${o.stderr}`);
      assert.equal(checks(o).length, 0);
    }
  });
});
