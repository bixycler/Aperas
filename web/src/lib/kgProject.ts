/**
 * `kg:project` — serializes a tracked ArtifactNode/FolderNode's tree back to Markdown, via the
 * shared ApeironNgn service (Aperas-apeironngn-design.md §4 rollout step 5). The service returns
 * the rendered markdown and target file path; the actual file write stays client-side so the
 * service's own disk-write footprint stays limited to the 3 mirror files it owns. Pass `--dry-run`
 * to print instead of writing.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from 'oxigraph';
import { findByExactPath } from './apeironNgn/tree';
import { nodeKindFromId } from './apeironNgn/vocab';
import { wrap, type ArtifactNode, type FolderNode } from './apeironNgn/node';
import { getArtifactsDir } from './artifacts';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

export function runProject(store: Store, path: string) {
  const id = findByExactPath(store, path);
  const kind = id ? nodeKindFromId(id) : null;
  if (kind !== 'ArtifactNode' && kind !== 'FolderNode') {
    throw new Error(`No ingested ArtifactNode or FolderNode found for '${path}'.`);
  }

  // Artifact addressing writes back to the same path it was found at; folder addressing reads
  // the FolderNode's own `path` field (its README's directory, `.` for the artifacts root) rather
  // than reusing the lookup path verbatim.
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
    throw new Error(`Projection produced no content for '${path}'.`);
  }
  return { markdown, targetFile };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const dryRun = rawArgs.includes('--dry-run');
  const [path] = rawArgs.filter((p) => p !== '--dry-run');
  if (!path) {
    console.error('Usage: kg:project -- <path> [--dry-run]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const { markdown, targetFile } = await request<ReturnType<typeof runProject>>({ op: 'project', path });

  if (dryRun) {
    console.log(markdown);
  } else {
    writeFileSync(targetFile, markdown, 'utf-8');
    console.log(`[ApeironNgn kg:project] Projected '${path}' to '${targetFile}'.`);
  }
}

if (process.argv[1]?.endsWith('kgProject.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:project] Failed:', err.message || err);
    process.exit(1);
  });
}
