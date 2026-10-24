// `aperas --version` and `-v` print `aperas <version>` read from the CLI package's `package.json`, exit 0, and never touch the service (planning: the commands of 0.3.0). The version is read next to the running file in
// the built bundle (`dist/package.json`, which `build.mjs` writes beside `dist/aperas.js`) and a directory above in the checkout. `build:aperas` also runs a `vite build` of the webapp, which is too slow for a test, so the
// bundle case bundles `aperas.ts` with the same `esbuild` options as `build.mjs`, writes the same minimal `package.json` beside it and runs the result with `node`; the real build is run by hand before a release.
// The service is not named: the runtime directory is a scratch one that does not exist, and it still does not exist after.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { readCliVersion } from '../../cliVersion';

const CLI_DIR = join(import.meta.dirname, '..', '..', '..');
const APERAS = join(CLI_DIR, 'src', 'aperas.ts');
const pkgVersion = (JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf-8')) as { version: string }).version;

describe('aperas --version', () => {
  let scratch: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aperas-version-'));
    env = { ...process.env, XDG_RUNTIME_DIR: join(scratch, 'run'), APERAS_HTTP_PORT: '45987', APERAS_APEIRON_ROOT: join(scratch, 'Apeiron'), APERAS_ARTIFACTS_ROOT: join(scratch, 'artifacts') };
    delete env.NODE_TEST_CONTEXT;
  });
  after(() => { rmSync(scratch, { recursive: true, force: true }); });

  test('the version is the one of the CLI package.json, in the checkout', () => {
    assert.match(pkgVersion, /^\d+\.\d+\.\d+/);
    assert.equal(readCliVersion(), pkgVersion);
  });

  test('beside the running file first, a directory above next, and an error when neither has one', () => {
    const dist = join(scratch, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'parent', version: '9.9.9' }));
    assert.equal(readCliVersion(pathToFileURL(join(dist, 'aperas.js')).href), '9.9.9', 'a directory above');
    writeFileSync(join(dist, 'package.json'), JSON.stringify({ name: 'aperas', version: '1.2.3' }));
    assert.equal(readCliVersion(pathToFileURL(join(dist, 'aperas.js')).href), '1.2.3', 'beside the file');
    const none = join(scratch, 'none', 'deeper');
    mkdirSync(none, { recursive: true });
    writeFileSync(join(scratch, 'none', 'package.json'), JSON.stringify({ name: 'no version' }));
    assert.throws(() => readCliVersion(pathToFileURL(join(none, 'x.js')).href), /No package\.json with a version/);
  });

  test('--version and -v print "aperas <version>" and exit 0, in the checkout, without touching the service', () => {
    for (const flag of ['--version', '-v']) {
      const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), APERAS, flag], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `aperas ${pkgVersion}\n`);
      assert.equal(r.stderr, '');
    }
    assert.equal(existsSync(join(scratch, 'run')), false, 'no run directory was made: the service was not looked at');
  });

  test('from the bundle: the version of the package.json written beside it', async () => {
    const out = join(scratch, 'bundle');
    await build({ entryPoints: [APERAS], outfile: join(out, 'aperas.js'), bundle: true, platform: 'node', format: 'esm', target: 'node20', banner: { js: '#!/usr/bin/env node' }, logLevel: 'silent' });
    writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'aperas', version: pkgVersion, license: 'Unlicense', type: 'module', bin: { aperas: './aperas.js' } }, null, 2) + '\n');
    for (const flag of ['--version', '-v']) {
      const r = spawnSync(process.execPath, [join(out, 'aperas.js'), flag], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `aperas ${pkgVersion}\n`);
    }
    assert.equal(existsSync(join(scratch, 'run')), false, 'no run directory was made');
  });

  test('the top-level help lists --version', () => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), APERAS, '--help'], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /aperas --version/);
    const s = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), APERAS, 'service', '--help'], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.match(s.stdout, /^ {2}status +Say whether the service is running/m);
    assert.match(s.stdout, /aperas service \{start\|stop\|restart\|status\}/);
  });
});
