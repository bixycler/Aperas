/**
 * `kg:unfold` — prints a node's title plus each immediate child's full text and sets `unfolded =
 * true`, via the shared ApeironNgn service (Aperas-apeironngn-design.md §4 rollout step 5).
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, type TreeNode, type BlockNode } from './apeironNgn/node';
import { nodeKindFromId, nodeExists } from './apeironNgn/vocab';
import { displayLabel } from './apeironNgn/tree';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

export function runUnfold(store: Store, pathArg: string) {
  // No try/catch around ref resolution here, deliberately — matches `kgCli.ts`'s plain
  // `resolveNodeRef`, which also lets an ambiguous-segment throw propagate uncaught.
  const id = resolveDeepPath(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  if (!nodeExists(store, id)) throw new Error(`Node '${id}' not found.`);

  const node = wrap(store, id) as unknown as TreeNode;
  const label = displayLabel(id, node);
  const children = node.treeChildren.map((child) => {
    const childId = child.id;
    if (!nodeExists(store, childId)) return { id: childId, label: '?', text: '<not found>' };
    const childKind = nodeKindFromId(childId);
    const text = childKind === 'BlockNode' && (child as unknown as BlockNode).type === 'list'
      ? `(no text of its own — see kg:unfold ${childId})`
      : (child.text ?? '');
    return { id: childId, label: displayLabel(childId, child), text };
  });

  node.unfold();
  return { id, label, title: node.title as string, children };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const flush = rawArgs.includes('--flush');
  const [pathArg] = rawArgs.filter((p) => p !== '--flush');
  if (!pathArg) {
    console.error('Usage: kg:unfold -- <path>');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runUnfold>>({ op: 'unfold', ref: pathArg, flush });

  console.log(`${result.id}  [${result.label}]  ${result.title}`);
  for (const child of result.children) {
    console.log(`  ${child.id}  [${child.label}]  ${child.text}`);
  }
}

if (process.argv[1]?.endsWith('kgUnfold.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:unfold] Failed:', err.message || err);
    process.exit(1);
  });
}
