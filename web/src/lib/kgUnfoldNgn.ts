/**
 * `kg:unfold`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout). Prints this node's
 * title plus each immediate child's full text, sets `unfolded = true`, and dehydrates the change
 * back to `AperasKG/Apeiron/`'s JSON-LD mirror — no git commit (a separate, existing step).
 */

import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { resolveDeepPath } from './apeironNgn/resolve';
import { setUnfolded } from './apeironNgn/unfold';
import { wrap, type ApeironNode } from './apeironNgn/node';
import { nodeKindFromId, nodeExists } from './apeironNgn/vocab';
import { childIds, displayLabel } from './apeironNgn/tree';

function main(): void {
  const [pathArg] = process.argv.slice(2);
  if (!pathArg) {
    console.error('Usage: kg:unfold:ngn -- <path>');
    process.exit(1);
  }

  const { store } = rehydrateStore();
  // No try/catch around ref resolution here, deliberately: `kgCli.ts`'s `unfold`/`fold` commands
  // use the plain `resolveNodeRef` wrapper, which doesn't catch an ambiguous-segment throw either
  // — it propagates uncaught to `main().catch()`'s generic `[Aperas KG CLI] Failed: <message>`
  // format (unlike `kg:resolve`'s own command, which *does* wrap its resolver call — see
  // `kgResolveNgn.ts`). Matched here by the same top-level `main().catch()` at file end.
  const id = resolveDeepPath(store, pathArg);
  if (!id) {
    console.error(`[ApeironNgn kg:unfold] '${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
    process.exit(1);
  }
  if (!nodeExists(store, id)) {
    console.error(`[ApeironNgn kg:unfold] Node '${id}' not found.`);
    process.exit(1);
  }

  const node = wrap(store, id);
  console.log(`${id}  [${displayLabel(id, node)}]  ${node.title}`);
  for (const childId of childIds(node, nodeKindFromId(id))) {
    if (!nodeExists(store, childId)) {
      console.log(`  ${childId}  [?]  <not found>`);
      continue;
    }
    const child = wrap(store, childId) as ApeironNode;
    const childKind = nodeKindFromId(childId);
    const label = displayLabel(childId, child);
    const text = childKind === 'BlockNode' && child.type === 'list'
      ? `(no text of its own — see kg:unfold ${childId})`
      : ((child.text as string) ?? '');
    console.log(`  ${childId}  [${label}]  ${text}`);
  }

  setUnfolded(store, id, true);
  dehydrateToJsonLd(store);
}

try {
  main();
} catch (err: any) {
  console.error('[ApeironNgn kg:unfold] Failed:', err.message || err);
  process.exit(1);
}
