/**
 * `kg:project`'s dry-run mode, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) —
 * serializes a tracked ArtifactNode/FolderNode's tree back to Markdown and prints it, reading from
 * a rehydrated in-process Store instead of TerminusDB. Non-dry-run (writing to the artifact file /
 * folder README) isn't migrated yet — that's a filesystem write, not a DB one, and out of scope
 * for this read-only step.
 */

import { rehydrateStore } from './apeironNgn/store';
import { findByExactPath } from './apeironNgn/tree';
import { nodeKindFromId } from './apeironNgn/vocab';
import { projectArtifactToMarkdown, projectFolderToReadme } from './apeironNgn/project';

function main(): void {
  const paths = process.argv.slice(2);
  if (!paths.includes('--dry-run')) {
    console.error('[ApeironNgn kg:project] Only --dry-run is migrated so far — pass it explicitly.');
    process.exit(1);
  }
  const [path] = paths.filter((p) => p !== '--dry-run');
  if (!path) {
    console.error('Usage: kg:project:ngn -- <path> --dry-run');
    process.exit(1);
  }

  const { store } = rehydrateStore();
  const id = findByExactPath(store, path);
  const kind = id ? nodeKindFromId(id) : null;
  if (kind !== 'ArtifactNode' && kind !== 'FolderNode') {
    console.error(`[ApeironNgn kg:project] No ingested ArtifactNode or FolderNode found for '${path}'.`);
    process.exit(1);
  }

  const markdown = kind === 'ArtifactNode' ? projectArtifactToMarkdown(store, path) : projectFolderToReadme(store, path);
  if (markdown === null) {
    console.error(`[ApeironNgn kg:project] Projection produced no content for '${path}'.`);
    process.exit(1);
  }
  console.log(markdown);
}

main();
