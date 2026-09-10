/**
 * A cheap fingerprint of this codebase's own source, used only to tell a CLI caller when the
 * long-lived service process (`service.ts`) is running code older than what's on disk right now —
 * a real gotcha hit repeatedly this session: Node doesn't hot-reload, so a source fix has no effect
 * on an already-running service until it's restarted, and nothing said so.
 *
 * Deliberately not a content hash — reading every `.ts` file's full bytes on every `ensureServiceRunning`
 * call (i.e. on every single `kg:xxx` invocation) would be wasteful for something checked this often.
 * `size:mtimeMs` per file is enough to detect "something under here changed since the service last
 * looked" without reading file contents at all; a false-negative (edit that doesn't change size and
 * lands in the same millisecond as an unrelated one) is astronomically unlikely and, worse case, just
 * costs a missed warning — never a wrong one, since the fingerprint never causes any behavior beyond
 * printing a notice.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `apeironNgn` -> `src` -> `cli` -> `packages` -> the two source trees the service actually runs:
 *  its own package (`packages/cli/src`) and the engine it depends on (`packages/core/src`) — split
 *  into two packages since this file was first written (when one `web/src/lib` covered both), so a
 *  single "one hop up" root no longer sees the whole picture; missing `core` here would mean an
 *  engine-only edit goes silently undetected as stale.
 *
 *  Only meaningful in dev, running from real `.ts` source — a published, `esbuild`-bundled `aperas`
 *  has no such tree on disk at all (everything's inlined into one file), so this returns `[]` there
 *  rather than `readdirSync`-throwing on a path that doesn't exist. There's nothing to detect as
 *  "stale" in that world anyway: a published build's code *is* whatever version was installed,
 *  never edited out from under a running process the way dev source can be. */
function getSourceDirs(): string[] {
  const packagesDir = resolve(__dirname, '..', '..', '..');
  const dirs = [resolve(packagesDir, 'cli', 'src'), resolve(packagesDir, 'core', 'src')];
  return dirs.filter(existsSync);
}

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
}

/** `'built'` when no dev source tree was found (see `getSourceDirs()`) — a fixed, never-stale
 *  fingerprint, since every process (service and client alike) reading a nonexistent source tree
 *  computes the same constant. */
export function computeCodeFingerprint(): string {
  const sourceDirs = getSourceDirs();
  if (sourceDirs.length === 0) return 'built';

  const files: string[] = [];
  for (const dir of sourceDirs) collectTsFiles(dir, files);
  files.sort();
  const hash = createHash('sha1');
  for (const file of files) {
    const stat = statSync(file);
    hash.update(`${file}:${stat.size}:${stat.mtimeMs}\n`);
  }
  return hash.digest('hex').slice(0, 12);
}
