/**
 * `kg:tree` — renders the fractal tree from a resolved node, via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5). `--view <ref>` (Aperas-treeview-design.md §5)
 * replaces the old bare `--unfolded` flag: supplying a view drives unfolded-mode rendering keyed
 * off that view's `unfolds` set; omitting it keeps the plain title-only default.
 */

import type { Store } from 'oxigraph';
import { resolveTreeRef } from './apeironNgn/tree';
import { wrap, type TreeNode, type TreeView } from './apeironNgn/node';
import { nodeExists } from './apeironNgn/vocab';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export function runTree(store: Store, req: { pathArg: string; maxDepth?: number; noHolders: boolean; viewRef?: string; reload?: boolean }) {
  const id = resolveTreeRef(store, req.pathArg);
  if (!id) throw new Error(`'${req.pathArg}' isn't a full node id or an exact tracked artifact/folder path.`);
  let view: TreeView | undefined;
  if (req.viewRef !== undefined) {
    if (!nodeExists(store, req.viewRef)) throw new Error(`TreeView '${req.viewRef}' not found.`);
    view = wrap(store, req.viewRef) as unknown as TreeView;
  }
  return (wrap(store, id) as unknown as TreeNode).renderTree({ maxDepth: req.maxDepth, noHolders: req.noHolders, view });
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (wantsHelp(paths)) {
    printHelp({
      description: 'Render the fractal tree from a resolved node.',
      usage: 'kg:tree -- [<path>] [--depth <n>] [--view <viewRef>] [--no-holders] [--reload]',
      args: [
        { name: '<path>', description: "Full node id or exact tracked artifact/folder path to render from. Defaults to '.', the artifacts root." },
      ],
      flags: [
        { name: '--depth <n>', description: 'Limit rendering to this many levels deep.' },
        { name: '--view <viewRef>', description: 'Render in unfolded mode, driven by this TreeView\'s unfolds set. Omitting it keeps the plain title-only default rendering.' },
        { name: '--no-holders', description: 'Omit placeholder holder nodes from the output.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }

  const noHolders = paths.includes('--no-holders');
  const reload = paths.includes('--reload');
  const withoutFlag0 = paths.filter((p) => p !== '--no-holders' && p !== '--reload');
  const viewFlagIdx = withoutFlag0.indexOf('--view');
  const viewRef = viewFlagIdx !== -1 ? withoutFlag0[viewFlagIdx + 1] : undefined;
  const withoutFlag = viewFlagIdx !== -1
    ? withoutFlag0.filter((_, i) => i !== viewFlagIdx && i !== viewFlagIdx + 1)
    : withoutFlag0;
  const depthFlagIdx = withoutFlag.indexOf('--depth');
  let maxDepth: number | undefined;
  let pathArg = '.';
  if (depthFlagIdx !== -1) {
    maxDepth = Number(withoutFlag[depthFlagIdx + 1]);
    const rest = withoutFlag.filter((_, i) => i !== depthFlagIdx && i !== depthFlagIdx + 1);
    if (rest[0]) pathArg = rest[0];
  } else if (withoutFlag[0]) {
    pathArg = withoutFlag[0];
  }

  await ensureServiceRunning();
  const lines = await request<ReturnType<typeof runTree>>({ op: 'tree', pathArg, maxDepth, noHolders, viewRef, reload });
  console.log(lines.join('\n'));
}

if (process.argv[1]?.endsWith('kgTree.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:tree] Failed:', err.message || err);
    process.exit(1);
  });
}
