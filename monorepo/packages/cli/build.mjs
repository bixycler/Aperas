#!/usr/bin/env node
/**
 * Builds the publishable `aperas` bundle (AperasKG/artifacts/design/packaging.md's Distribution
 * section): `esbuild` bundles `src/aperas.ts` (pulling in `@aperas/core` transitively — nothing in
 * `packages/core` is published on its own) into one plain-JS file, `oxigraph` marked external since
 * it ships as a WASM binary a bundler can't usefully inline. The result is a self-contained
 * `dist/` — its own minimal `package.json` (name `aperas`, a `bin` entry, `oxigraph` as a real
 * dependency) — never touching this package's own dev-mode `package.json`/`exports` (still
 * pointing at `.ts` source for the workspace, unaffected by any of this).
 *
 * Also builds `packages/web` (`vite build`) and copies its `dist/` to `dist/web/`, sibling to the
 * CLI bundle itself (Slice 16, planning/webapp.md) — `aperas serve`'s production listener
 * (`service.ts#resolveWebRoot`) looks there first, so the packaged binary can serve the webapp with
 * no separate install step. Web build failures are fatal here, same as a CLI build failure: a
 * package with no webapp in it isn't the self-contained artifact this script promises.
 *
 * Also copies the two end-user-facing skills (`skills/aperas`, `skills/kg-doc-ingest` — this repo's
 * own other skills, e.g. `solidjs`/`terminusdb`, are dev-only and never bundled) to `dist/skills/`,
 * sibling to the bundle — `kgSkill.ts#resolveSkillsRoot` looks there first, the same
 * built-vs-source-fallback shape as `resolveWebRoot()`. Without this, an agent working against an
 * `npm install`ed `aperas` has the binary but none of the graph-first discipline the skill encodes —
 * `aperas skill install` (below) is what actually closes that gap for an end user.
 *
 * Run via `node packages/cli/build.mjs` (or `npm run build:aperas` from the repo root).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = __dirname;
const distDir = join(cliDir, 'dist');
const webDir = join(cliDir, '..', 'web');

const cliPkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf-8'));
const corePkg = JSON.parse(readFileSync(join(cliDir, '..', 'core', 'package.json'), 'utf-8'));
const oxigraphVersion = corePkg.dependencies.oxigraph;

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: [join(cliDir, 'src', 'aperas.ts')],
  outfile: join(distDir, 'aperas.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['oxigraph'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
chmodSync(join(distDir, 'aperas.js'), 0o755);

console.log('[build:aperas] Building packages/web (vite build)...');
execFileSync('npm', ['run', 'build'], { cwd: webDir, stdio: 'inherit' });
cpSync(join(webDir, 'dist'), join(distDir, 'web'), { recursive: true });
console.log(`[build:aperas] Copied ${join(webDir, 'dist')} -> ${join(distDir, 'web')}`);

cpSync(join(cliDir, 'README.md'), join(distDir, 'README.md'));

const repoRoot = join(cliDir, '..', '..', '..'); // packages/cli -> packages -> monorepo -> repo root
for (const skill of ['aperas', 'kg-doc-ingest']) {
  cpSync(join(repoRoot, 'skills', skill), join(distDir, 'skills', skill), { recursive: true });
}
console.log(`[build:aperas] Copied skills/{aperas,kg-doc-ingest} -> ${join(distDir, 'skills')}`);

const distPkg = {
  name: 'aperas',
  version: cliPkg.version,
  type: 'module',
  bin: { aperas: './aperas.js' },
  dependencies: { oxigraph: oxigraphVersion },
};
writeFileSync(join(distDir, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n', 'utf-8');

console.log(`[build:aperas] Wrote ${join(distDir, 'aperas.js')} + ${join(distDir, 'package.json')}`);
