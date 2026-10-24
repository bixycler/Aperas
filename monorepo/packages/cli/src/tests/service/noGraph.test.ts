// `aperas service start` where there is no graph (design/packaging.md, "The service lifecycle"; the packaging fixes before 0.3.0). An installed package (the bundle, run from a global or `npx` install) with no
// `aperas.config.json` above the working directory and no `APERAS_APEIRON_ROOT` resolves its root to a fallback four directories above the install, where the first write used to fail with ENOENT. Now `start`
// (and `restart`, `serve`, everything that would start a service) refuses when the Apeiron root it resolved does not exist or is not a directory: it says which path it resolved and how (variable, config file,
// fallback), says to run `aperas init`, exits non-zero and creates nothing; and `aperas init` in a scratch directory makes the next `start` work. A checkout whose fallback `<checkout>/AperasKG` exists is
// unaffected (the other tests of this group start services on it by roots in the environment).
// Every run sets a scratch run directory and a claimed port. The cases through `tsx` set both roots to scratch ones as well. The bundle cases are built into the scratch directory; the fallback and the config
// cases leave the roots out on purpose, because they are the resolution under test: the bundle there lies in the scratch directory, so its fallback is a path in the scratch directory, and the test refuses to
// run unless no `aperas.config.json` stands above the scratch directory; the refusal comes before the lock is claimed, so nothing is spawned in those cases.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { noGraphMessage } from '../../kgService';

const APERAS = join(import.meta.dirname, '..', '..', 'aperas.ts');

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

describe('aperas service start where there is no graph', () => {
  let scratch: string;
  let port: number;
  let bundle: string;
  const run = (name: string): string => join(scratch, name);
  /** The environment of a run: the scratch run directory and port, no root variable unless `roots` gives them. */
  const envOf = (roots?: { apeiron: string; artifacts: string }): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: run('run'), APERAS_HTTP_PORT: String(port) };
    delete env.NODE_TEST_CONTEXT;
    delete env.APERAS_APEIRON_ROOT;
    delete env.APERAS_ARTIFACTS_ROOT;
    delete env.APERAS_GRAPH_NAME;
    if (roots) { env.APERAS_APEIRON_ROOT = roots.apeiron; env.APERAS_ARTIFACTS_ROOT = roots.artifacts; }
    return env;
  };
  const tsx = (args: string[], env: NodeJS.ProcessEnv, cwd = scratch) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), APERAS, ...args], { encoding: 'utf8', env, cwd, timeout: 60_000, killSignal: 'SIGKILL' });
  const bundled = (args: string[], env: NodeJS.ProcessEnv, cwd: string) => spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', env, cwd, timeout: 60_000, killSignal: 'SIGKILL' });
  const listing = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();

  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'aperas-nograph-'));
    port = await freePort();
    for (let dir = scratch; ; dir = dirname(dir)) {
      assert.equal(existsSync(join(dir, 'aperas.config.json')), false, `an aperas.config.json at ${dir} would be found by a run in the scratch directory`);
      if (dirname(dir) === dir) break;
    }
    // The bundle sits four directories below the scratch root, where the installed package finds its fallback root: `<scratch>/AperasKG`, which does not exist.
    bundle = join(scratch, 'a', 'b', 'c', 'dist', 'aperas.js');
    await build({ entryPoints: [APERAS], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', banner: { js: '#!/usr/bin/env node' }, logLevel: 'silent' });
    writeFileSync(join(dirname(bundle), 'package.json'), JSON.stringify({ name: 'aperas', version: '0.0.0', type: 'module' }));
  });
  after(() => { rmSync(scratch, { recursive: true, force: true }); });

  test('the variable: the message names the path, the variable and aperas init; exit 1; nothing is created', () => {
    const apeiron = run('nowhere/Apeiron');
    const env = envOf({ apeiron, artifacts: run('nowhere/artifacts') });
    const before = listing(scratch);
    for (const verb of ['start', 'restart']) {
      const r = tsx(['service', verb], env);
      assert.equal(r.status, 1, `${verb}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(apeiron), r.stderr);
      assert.match(r.stderr, /APERAS_APEIRON_ROOT/);
      assert.match(r.stderr, /aperas init/);
      assert.match(r.stderr, /Nothing was created/);
    }
    assert.deepEqual(listing(scratch), before, 'no directory, lock or log was made');
    assert.equal(existsSync(run('run')), false, 'no run directory');
  });

  test('a path that is a file is not a graph either', () => {
    const file = run('a-file');
    writeFileSync(file, '');
    const r = tsx(['service', 'start'], envOf({ apeiron: file, artifacts: run('x') }));
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(file));
  });

  test('the message function: the variable and the config file are each named, and a directory is a graph', () => {
    const saved = { a: process.env.APERAS_APEIRON_ROOT, b: process.env.APERAS_ARTIFACTS_ROOT };
    try {
      delete process.env.APERAS_APEIRON_ROOT;
      const dir = run('cfg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'aperas.config.json'), JSON.stringify({ graph: { apeiron: './missing/Apeiron', artifacts: './missing/artifacts' } }));
      const viaConfig = noGraphMessage(dir)!;
      assert.ok(viaConfig.includes(join(dir, 'aperas.config.json')) && viaConfig.includes(join(dir, 'missing', 'Apeiron')), viaConfig);
      assert.match(viaConfig, /"graph" field/);
      mkdirSync(join(dir, 'missing', 'Apeiron'), { recursive: true });
      assert.equal(noGraphMessage(dir), null, 'a config whose Apeiron directory exists');
      process.env.APERAS_APEIRON_ROOT = run('var/Apeiron');
      assert.match(noGraphMessage(dir)!, /environment variable APERAS_APEIRON_ROOT/);
      mkdirSync(run('var/Apeiron'), { recursive: true });
      assert.equal(noGraphMessage(dir), null, 'a variable that names a directory');
    } finally {
      if (saved.a === undefined) delete process.env.APERAS_APEIRON_ROOT; else process.env.APERAS_APEIRON_ROOT = saved.a;
      if (saved.b === undefined) delete process.env.APERAS_ARTIFACTS_ROOT; else process.env.APERAS_ARTIFACTS_ROOT = saved.b;
    }
  });

  test('the checkout: its fallback AperasKG, when it exists, is not refused', () => {
    const saved = process.env.APERAS_APEIRON_ROOT;
    try {
      delete process.env.APERAS_APEIRON_ROOT;
      const checkout = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
      if (existsSync(join(checkout, 'AperasKG', 'Apeiron'))) assert.equal(noGraphMessage(scratch), null);
    } finally { if (saved !== undefined) process.env.APERAS_APEIRON_ROOT = saved; }
  });

  test('the installed bundle with no variable and no config: the fallback is named, exit 1, nothing is created', () => {
    const cwd = run('empty-cwd');
    mkdirSync(cwd);
    const before = listing(scratch);
    const r = bundled(['service', 'start'], envOf(), cwd);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /the fallback/);
    assert.ok(r.stderr.includes(join(scratch, 'AperasKG', 'Apeiron')), r.stderr);
    assert.match(r.stderr, /no aperas\.config\.json was found/);
    assert.match(r.stderr, /aperas init/);
    assert.deepEqual(listing(scratch), before);
  });

  test('aperas init in a scratch directory makes the next service start work, and the service stops', () => {
    const graph = run('graph');
    mkdirSync(graph);
    const env = envOf();
    try {
      assert.equal(bundled(['service', 'start'], env, graph).status, 1, 'refused before init');
      assert.equal(existsSync(join(graph, 'Apeiron')), false, 'and nothing made');
      const init = bundled(['init', '--name', 'scratch graph'], env, graph);
      assert.equal(init.status, 0, init.stdout + init.stderr);
      assert.ok(existsSync(join(graph, 'Apeiron')) && existsSync(join(graph, 'aperas.config.json')));
      const start = bundled(['service', 'start'], env, graph);
      assert.equal(start.status, 0, `${start.stdout}${start.stderr}`);
      assert.ok(start.stdout.includes(join(graph, 'Apeiron')), start.stdout);
      const status = bundled(['service', 'status'], env, graph);
      assert.equal(status.status, 0, status.stdout);
      assert.match(status.stdout, /^ready/);
    } finally {
      const stop = bundled(['service', 'stop'], env, graph);
      assert.match(stop.stdout, /Stopped|No running service/, stop.stdout + stop.stderr);
    }
  });
});
