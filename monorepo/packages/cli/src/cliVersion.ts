/**
 * The version of this CLI, read from its `package.json`: the one next to the running file in the built bundle (`dist/aperas.js` and the `dist/package.json` that `build.mjs` writes
 * beside it), the one a directory above in the checkout (`src/cliVersion.ts` and `packages/cli/package.json`). `aperas --version` prints it and `aperas service status` names it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `fromUrl` is the location of the running file (`import.meta.url`), a parameter for a test that puts a bundle elsewhere. */
export function readCliVersion(fromUrl: string = import.meta.url): string {
  const dir = dirname(fileURLToPath(fromUrl));
  for (const candidate of [join(dir, 'package.json'), join(dir, '..', 'package.json')]) {
    try {
      const version = (JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: unknown }).version;
      if (typeof version === 'string' && version !== '') return version;
    } catch { /* no such file here: try the next place */ }
  }
  throw new Error(`No package.json with a version next to ${dir}`);
}
