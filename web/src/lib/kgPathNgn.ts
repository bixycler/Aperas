/**
 * `kg:path` migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) — id→path, same output
 * format as `kgCli.ts`'s `path` command, reading from a rehydrated in-process Store instead of
 * TerminusDB. Kept as its own script, not yet wired to replace `kg:path`, same as `kg:tree:ngn`.
 *
 * Ref resolution is `kg:tree:ngn`'s `resolveTreeRef` (full node id, or an exact `path` literal
 * match) — not `kgCli.ts`'s full `resolveNodeRef` (which also accepts a bare snowflake code via
 * `directResolve.ts`). That tier isn't migrated yet, same scope cut as `kg:tree:ngn`.
 */

import { rehydrateStore } from './apeironNgn/store';
import { resolveTreeRef } from './apeironNgn/tree';
import { wrap, type TreeNode } from './apeironNgn/node';

function main(): void {
  const [idArg] = process.argv.slice(2);
  if (!idArg) {
    console.error('Usage: kg:path:ngn -- <id or exact path>');
    process.exit(1);
  }

  const { store } = rehydrateStore();
  const id = resolveTreeRef(store, idArg);
  if (!id) {
    console.error(`[ApeironNgn kg:path] '${idArg}' isn't a full node id or an exact tracked artifact/folder path.`);
    process.exit(1);
  }

  const path = (wrap(store, id) as unknown as TreeNode).toPath();
  if (path === null) {
    console.error(`[ApeironNgn kg:path] '${id}' has no walkable parent chain — a Link (no structural parent), or a BlockNode ingested before the 'parent' field existed (needs re-ingestion).`);
    process.exit(1);
  }
  console.log(path);
}

main();
