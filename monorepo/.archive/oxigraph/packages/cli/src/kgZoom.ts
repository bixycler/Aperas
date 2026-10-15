/**
 * `aperas zoom` — sets a `TreeView`'s `root` to a resolved ref and unfolds it in the same call
 * (design/treeview.md's "root records the current zoom"; design/aperas-skill.md's Multi-agent
 * working hand-off mechanics), via the shared ApeironNgn service. Unlike `aperas unfold`, there is
 * no read-only peek mode: the whole point of the call is to move the view's apex, so it always
 * mutates a named view (bootstrapping the `"default"` one on first use, same as `unfold`/`fold`).
 *
 * `aperas tree --view <name>` with no explicit path renders from whatever `root` a prior zoom left
 * behind — only the current root is ever recorded, never a history of past ones.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import { wrap, type TreeNode, type TreeView, type ApeironNode } from '@aperas/core/apeironNgn/node';
import { nodeExists } from '@aperas/core/apeironNgn/vocab';
import { displayLabel } from '@aperas/core/apeironNgn/tree';
import { nodeAbstract } from './kgUnfold';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

function isTombstoned(node: { tombstonedAt?: string } | undefined): boolean {
  return node?.tombstonedAt !== undefined;
}

export function runZoom(store: Store, ref: string, view: TreeView) {
  const id = resolveDeepPath(store, ref);
  if (!id) throw new Error(`'${ref}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  if (!nodeExists(store, id)) throw new Error(`Node '${id}' not found.`);
  const node = wrap(store, id) as unknown as TreeNode;
  if (isTombstoned(node as unknown as { tombstonedAt?: string })) {
    throw new Error(`'${ref}' (${id}) is tombstoned — zooming a view onto a dead node isn't meaningful.`);
  }

  view.root = id as unknown as ApeironNode;
  view.unfold(id);

  const abstract = nodeAbstract(node);
  return {
    id,
    view: view.name as unknown as string,
    path: node.toPath(),
    label: displayLabel(id, node),
    title: abstract !== undefined ? `${node.title as unknown as string}  ║  ${abstract}` : (node.title as unknown as string),
  };
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Set a TreeView's root to a resolved ref and unfold it in the same call — the apex `aperas tree --view <name>` renders from by default when no explicit path is given.",
      usage: 'aperas zoom <ref> [--view <viewRef>] [--flush] [--reload]',
      args: [
        { name: '<ref>', description: 'TreeNode to zoom onto — deep path, bare node code, or full node id.' },
      ],
      flags: [
        { name: '--view <viewRef>', description: 'TreeView to re-root (mints the "default" view on first use if omitted).' },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const withoutFlush = rawArgs.filter((p) => p !== '--flush' && p !== '--reload');
  const viewFlagIdx = withoutFlush.indexOf('--view');
  const viewRef = viewFlagIdx !== -1 ? withoutFlush[viewFlagIdx + 1] : undefined;
  const withoutFlags = viewFlagIdx !== -1
    ? withoutFlush.filter((_, i) => i !== viewFlagIdx && i !== viewFlagIdx + 1)
    : withoutFlush;
  const [ref] = withoutFlags;
  if (!ref) {
    console.error('Usage: aperas zoom <ref> [--view <viewRef>] [--flush] [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runZoom>>({ op: 'zoom', ref, viewRef, flush, reload });
  if (result.path !== null) console.log(`aperas://tree/${result.path}`);
  console.log(`${result.id}  [${result.label}]  ${result.title}  (view '${result.view}' rooted here)`);
}

if (process.argv[1]?.endsWith('kgZoom.ts')) {
  main().catch((err) => {
    console.error('[aperas zoom] Failed:', err.message || err);
    process.exit(1);
  });
}
