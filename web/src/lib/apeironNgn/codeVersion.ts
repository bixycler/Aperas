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

import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `apeironNgn` -> `lib` -> the whole CLI/substrate source tree this service actually runs. */
function getLibDir(): string {
  return resolve(__dirname, '..');
}

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
}

export function computeCodeFingerprint(): string {
  const libDir = getLibDir();
  const files: string[] = [];
  collectTsFiles(libDir, files);
  files.sort();
  const hash = createHash('sha1');
  for (const file of files) {
    const stat = statSync(file);
    hash.update(`${file}:${stat.size}:${stat.mtimeMs}\n`);
  }
  return hash.digest('hex').slice(0, 12);
}
