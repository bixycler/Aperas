// What `build.mjs` ships (`buildPlan.mjs`, which the build imports): the fields of `dist/package.json` and the explicit list of what `dist` ships, and the filter that keeps a Python bytecode cache
// out of the copied skills. `build:aperas` also runs a `vite build` of the webapp, which is too slow for a test, so the copy is run here with the same `cpSync` options on a scratch tree; the real build and
// `npm pack --dry-run` in `dist` are run by hand before a release. The last case reads the repository: every name the list gives exists at the place the build copies it from.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI_DIR = join(import.meta.dirname, '..', '..', '..');
const REPO = join(CLI_DIR, '..', '..', '..');

interface BuildPlan {
  DIST_FILES: string[];
  distPackageJson(version: string, license?: string): Record<string, any>;
  shipsFromSkill(src: string): boolean;
}
const plan = (await import(pathToFileURL(join(CLI_DIR, 'buildPlan.mjs')).href)) as BuildPlan;

describe('the package that the build ships', () => {
  let scratch: string;
  before(() => { scratch = mkdtempSync(join(tmpdir(), 'aperas-buildplan-')); });
  after(() => { rmSync(scratch, { recursive: true, force: true }); });

  test('the dist package.json carries the name, the version, the node it runs on, the repository, the homepage, the bug tracker and the explicit list of files', () => {
    const cli = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf-8')) as { version: string; license: string };
    const pkg = plan.distPackageJson(cli.version, cli.license);
    assert.equal(pkg.name, 'aperas');
    assert.equal(pkg.version, cli.version);
    assert.equal(pkg.license, 'Unlicense');
    assert.deepEqual(pkg.bin, { aperas: './aperas.js' });
    assert.deepEqual(pkg.engines, { node: '>=22' });
    assert.deepEqual(pkg.repository, { type: 'git', url: 'git+https://github.com/bixycler/Aperas.git' });
    assert.equal(pkg.homepage, 'https://github.com/bixycler/Aperas#readme');
    assert.deepEqual(pkg.bugs, { url: 'https://github.com/bixycler/Aperas/issues' });
    assert.deepEqual(pkg.files, ['aperas.js', 'web', 'skills', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    assert.notEqual(pkg.files, plan.DIST_FILES, 'a copy, so that a caller cannot change the list');
    assert.equal(plan.distPackageJson('1.2.3').license, 'Unlicense', 'the license defaults');
  });

  test('a __pycache__ directory and a .pyc file in a skill are not copied, and the rest is', () => {
    const skill = join(scratch, 'skills', 'aperas');
    mkdirSync(join(skill, 'scripts', '__pycache__'), { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), 'skill');
    writeFileSync(join(skill, 'scripts', 'tool.py'), 'print()');
    writeFileSync(join(skill, 'scripts', 'stray.pyc'), 'x');
    writeFileSync(join(skill, 'scripts', '__pycache__', 'tool.cpython-314.pyc'), 'x');
    writeFileSync(join(skill, 'scripts', '__pycache__', 'note.txt'), 'x');
    const out = join(scratch, 'dist', 'skills', 'aperas');
    cpSync(skill, out, { recursive: true, filter: plan.shipsFromSkill });
    assert.equal(readFileSync(join(out, 'SKILL.md'), 'utf-8'), 'skill');
    assert.equal(readFileSync(join(out, 'scripts', 'tool.py'), 'utf-8'), 'print()');
    assert.equal(existsSync(join(out, 'scripts', '__pycache__')), false, 'the directory');
    assert.equal(existsSync(join(out, 'scripts', 'stray.pyc')), false, 'the file');
  });

  test('the files the build copies from the repository are there: the package README, the license and the changelog', () => {
    for (const name of ['README.md']) assert.ok(existsSync(join(CLI_DIR, name)), `packages/cli/${name}`);
    for (const name of ['LICENSE', 'CHANGELOG.md']) assert.ok(existsSync(join(REPO, name)), name);
  });
});
