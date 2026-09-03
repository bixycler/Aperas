/**
 * `kg:project`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) — serializes a
 * tracked ArtifactNode/FolderNode's tree back to Markdown and writes it to the artifact's file /
 * the folder's README.md, reading from a rehydrated in-process Store instead of TerminusDB. Pass
 * `--dry-run` to print instead of writing, same as `kgCli.ts`'s `project` command.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rehydrateStore } from './apeironNgn/store';
import { findByExactPath } from './apeironNgn/tree';
import { nodeKindFromId } from './apeironNgn/vocab';
import { wrap, type ArtifactNode, type FolderNode } from './apeironNgn/node';
import { getArtifactsDir } from './artifacts';

function main(): void {
  const paths = process.argv.slice(2);
  const dryRun = paths.includes('--dry-run');
  const [path] = paths.filter((p) => p !== '--dry-run');
  if (!path) {
    console.error('Usage: kg:project -- <path> [--dry-run]');
    process.exit(1);
  }

  const { store } = rehydrateStore();
  const id = findByExactPath(store, path);
  const kind = id ? nodeKindFromId(id) : null;
  if (kind !== 'ArtifactNode' && kind !== 'FolderNode') {
    console.error(`[ApeironNgn kg:project] No ingested ArtifactNode or FolderNode found for '${path}'.`);
    process.exit(1);
  }

  // Artifact addressing writes back to the same path it was found at; folder addressing reads
  // the FolderNode's own `path` field (its README's directory, `.` for the artifacts root) rather
  // than reusing the lookup path verbatim — same distinction `kgCli.ts`'s `project` command makes
  // between `path` (the lookup arg) and `folder.path` (the fetched record).
  let markdown: string | null;
  let targetFile: string;
  if (kind === 'ArtifactNode') {
    markdown = (wrap(store, id!) as unknown as ArtifactNode).toMarkdown();
    targetFile = join(getArtifactsDir(), path);
  } else {
    const folder = wrap(store, id!) as unknown as FolderNode;
    markdown = folder.toReadme();
    const folderPath = folder.path as unknown as string;
    targetFile = join(getArtifactsDir(), folderPath === '.' ? '' : folderPath, 'README.md');
  }

  if (markdown === null) {
    console.error(`[ApeironNgn kg:project] Projection produced no content for '${path}'.`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(markdown);
  } else {
    writeFileSync(targetFile, markdown, 'utf-8');
    console.log(`[ApeironNgn kg:project] Projected '${path}' to '${targetFile}'.`);
  }
}

main();
