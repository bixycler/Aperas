/**
 * What `build.mjs` ships, kept apart from the build so a test can check it without a `vite build`:
 * the fields of `dist/package.json`, the explicit list of what `dist` ships, and the filter that
 * keeps a Python bytecode cache out of the copied skills.
 */

import { basename } from 'node:path';

/** Everything `dist` ships, by name: a stray file left in `dist` cannot reach the registry. */
export const DIST_FILES = ['aperas.js', 'web', 'skills', 'README.md', 'LICENSE', 'CHANGELOG.md'];

/** The `package.json` written into `dist` for the `aperas` package of version `version`. */
export function distPackageJson(version, license) {
  return {
    name: 'aperas',
    version,
    license: license || 'Unlicense',
    type: 'module',
    bin: { aperas: './aperas.js' },
    engines: { node: '>=22' },
    repository: { type: 'git', url: 'git+https://github.com/bixycler/Aperas.git' },
    homepage: 'https://github.com/bixycler/Aperas#readme',
    bugs: { url: 'https://github.com/bixycler/Aperas/issues' },
    files: [...DIST_FILES],
  };
}

/** `cpSync`'s `filter` for the skills: a `__pycache__` directory and a `*.pyc` file are left out. */
export function shipsFromSkill(src) {
  return basename(src) !== '__pycache__' && !src.endsWith('.pyc');
}
