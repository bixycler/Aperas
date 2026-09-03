/**
 * `kg:fold`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout). Sets `unfolded =
 * false` and dehydrates the change back to `AperasKG/Apeiron/`'s JSON-LD mirror — no git commit
 * (that stays a separate, existing step, same as `dehydrate.ts`'s own doc comment).
 */

import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, type TreeNode } from './apeironNgn/node';
import { nodeExists } from './apeironNgn/vocab';

function main(): void {
  const [pathArg] = process.argv.slice(2);
  if (!pathArg) {
    console.error('Usage: kg:fold -- <path>');
    process.exit(1);
  }

  const { store } = rehydrateStore();
  // No try/catch around ref resolution — see kgUnfoldNgn.ts's matching comment: `kg:fold` also
  // uses the plain `resolveNodeRef` wrapper under TerminusDB, which lets an ambiguous-segment
  // throw propagate uncaught to `main().catch()`'s generic format, matched here the same way.
  const id = resolveDeepPath(store, pathArg);
  if (!id) {
    console.error(`[ApeironNgn kg:fold] '${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
    process.exit(1);
  }

  if (!nodeExists(store, id)) {
    console.error(`[ApeironNgn kg:fold] Node '${id}' not found.`);
    process.exit(1);
  }
  (wrap(store, id) as unknown as TreeNode).fold();
  dehydrateToJsonLd(store);
  console.log(`[ApeironNgn kg:fold] Folded ${id}.`);
}

try {
  main();
} catch (err: any) {
  console.error('[ApeironNgn kg:fold] Failed:', err.message || err);
  process.exit(1);
}
