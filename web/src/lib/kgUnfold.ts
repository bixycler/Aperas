/**
 * `kg:unfold` — adds one `TreeNode` or `Link` ref to a `TreeView`'s `unfolds` set (only that one
 * ref — the view's own rendering, not this command, decides what becomes visible as a result;
 * Aperas-treeview-design.md §5), via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5). Prints the target's title plus each immediate
 * child's/link's abstract as a preview of what just got revealed.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, type TreeNode, type BlockNode, type Link, type TreeView } from './apeironNgn/node';
import { nodeKindFromId, nodeExists } from './apeironNgn/vocab';
import { displayLabel } from './apeironNgn/tree';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

/** `ref` for a `TreeNode` resolves the normal deep-path way; for a `Link`, only a bare id
 *  (snowflake code) is accepted — a `Link` has no `path` field and no natural slug of its own to
 *  build one from, so `resolveDeepPath`'s path-segment machinery doesn't apply to it. Since a
 *  `Link`'s own id already carries a recognizable kind prefix, `resolveDeepPath`'s "already a full
 *  node id" branch is what actually accepts it — no special-casing needed here. */
function resolveUnfoldRef(store: Store, ref: string): string | null {
  return resolveDeepPath(store, ref);
}

export function runUnfold(store: Store, pathArg: string, view: TreeView) {
  // No try/catch around ref resolution here, deliberately — matches `kgCli.ts`'s plain
  // `resolveNodeRef`, which also lets an ambiguous-segment throw propagate uncaught.
  const id = resolveUnfoldRef(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  if (!nodeExists(store, id)) throw new Error(`Node '${id}' not found.`);

  view.unfold(id);

  if (nodeKindFromId(id) === 'Link') {
    const link = wrap(store, id) as unknown as Link;
    const target = link.target as unknown as TreeNode | undefined;
    return {
      id,
      label: 'Link',
      title: `${link.predicate as unknown as string} → ${target?.id ?? '<no target>'}`,
      children: target ? [{ id: target.id, label: displayLabel(target.id, target), text: target.title as string }] : [],
    };
  }

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
  const links = ((node.links as unknown as Link[] | undefined) ?? []).map((link) => {
    const target = link.target as unknown as TreeNode | undefined;
    return { id: link.id, label: 'Link', text: target ? `${link.predicate as unknown as string} → ${target.id}  ${target.title ?? ''}` : '<no target>' };
  });

  return { id, label, title: node.title as string, children: [...children, ...links] };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const flush = rawArgs.includes('--flush');
  const withoutFlush = rawArgs.filter((p) => p !== '--flush');
  const viewFlagIdx = withoutFlush.indexOf('--view');
  const viewRef = viewFlagIdx !== -1 ? withoutFlush[viewFlagIdx + 1] : undefined;
  const withoutFlags = viewFlagIdx !== -1
    ? withoutFlush.filter((_, i) => i !== viewFlagIdx && i !== viewFlagIdx + 1)
    : withoutFlush;
  const [pathArg] = withoutFlags;
  if (!pathArg) {
    console.error('Usage: kg:unfold -- <ref> [--view <viewRef>] [--flush]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runUnfold>>({ op: 'unfold', ref: pathArg, viewRef, flush });

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
