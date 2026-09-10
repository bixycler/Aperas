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
 * Run via `node packages/cli/build.mjs` (or `npm run build:aperas` from the repo root).
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = __dirname;
const distDir = join(cliDir, 'dist');

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

const distPkg = {
  name: 'aperas',
  version: cliPkg.version,
  type: 'module',
  bin: { aperas: './aperas.js' },
  dependencies: { oxigraph: oxigraphVersion },
};
writeFileSync(join(distDir, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n', 'utf-8');

console.log(`[build:aperas] Wrote ${join(distDir, 'aperas.js')} + ${join(distDir, 'package.json')}`);
