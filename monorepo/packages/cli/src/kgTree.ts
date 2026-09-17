/**
 * `kg:tree` — renders the fractal tree from a resolved node, via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5). `--view <ref>` (Aperas-treeview-design.md §5)
 * replaces the old bare `--unfolded` flag: supplying a view drives unfolded-mode rendering keyed
 * off that view's `unfolds` set; omitting it keeps the plain title-only default.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import { wrap, resolveTreeView, buildRenderTree, type TreeNode, type TreeView, type RenderNodeItem } from '@aperas/core/apeironNgn/node';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

/** `format: 'render-tree'`'s own return shape — `path` alongside `tree` rather than spliced into
 *  it as a first line, since a `RenderNodeItem` has no string-line slot to splice into (unlike the
 *  `'text'` case's `aperas://tree/<path>` breadcrumb line, below). */
export interface TreeRenderResult { path: string | null; tree: RenderNodeItem | null }

export function runTree(store: Store, req: { pathArg: string; maxDepth?: number; noHolders: boolean; showTombstoned: boolean; viewRef?: string; format?: 'text' | 'render-tree'; reload?: boolean }): string[] | TreeRenderResult {
  const id = resolveDeepPath(store, req.pathArg);
  if (!id) throw new Error(`'${req.pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  // Unlike `unfold`/`fold` (which always need *some* view to mutate, so an omitted `--view`
  // resolves to the default one), an omitted `--view` here means plain title-only rendering —
  // `view` stays `undefined` rather than falling back to `resolveTreeView`'s own default-view
  // behavior. `viewRef: 'default'` (typed explicitly) still resolves through `resolveTreeView`,
  // same as every other `--view` value.
  const view: TreeView | undefined = req.viewRef !== undefined ? resolveTreeView(store, req.viewRef) : undefined;
  const node = wrap(store, id) as unknown as TreeNode;
  const path = node.toPath();
  if (req.format === 'render-tree') {
    // The structured render only exists for the view-based renderer (`buildRenderTree`, §13) — the
    // plain title-only default has no `ConeInfo`/canonical-position machinery to build one from,
    // so this refuses rather than silently degrading to an empty or partial tree.
    if (!view) throw new Error("'--format render-tree' requires '--view <viewRef>' — the structured render only exists for the view-based renderer.");
    const tree = buildRenderTree(store, id, view, { maxDepth: req.maxDepth, noHolders: req.noHolders, showTombstoned: req.showTombstoned });
    return { path, tree };
  }
  const lines = node.renderTree({ maxDepth: req.maxDepth, noHolders: req.noHolders, showTombstoned: req.showTombstoned, view });
  // One breadcrumb for the node this render actually started from — every line below it is already
  // relative to this point (that's what a tree render *is*), so repeating the full path on each of
  // them would say the same prefix over and over for no reason. `aperas path`'s own format
  // (`aperas://tree/<path>`), so it's directly reusable as a `<ref>` elsewhere without a second
  // command — the gap this was added to close. Omitted (not printed as broken) for whatever
  // `toPath()` itself can't walk: a `BlockNode` missing `parent`/`title` along the way.
  return path !== null ? [`aperas://tree/${path}`, ...lines] : lines;
}

export async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (wantsHelp(paths)) {
    printHelp({
      description: 'Render the fractal tree from a resolved node.',
      usage: 'aperas tree [<path>] [--depth <n>] [--view <viewRef>] [--no-holders] [--tombstoned] [--reload]',
      args: [
        { name: '<path>', description: "Tracked artifact/folder path, deep path, bare node code, or full node id to render from. Defaults to '.', the artifacts root." },
      ],
      flags: [
        { name: '--depth <n>', description: 'Limit rendering to this many levels deep.' },
        { name: '--view <viewRef>', description: 'Render in unfolded mode, driven by this TreeView\'s unfolds set. Omitting it keeps the plain title-only default rendering.' },
        { name: '--no-holders', description: 'Omit placeholder holder nodes from the output.' },
        { name: '--tombstoned', description: 'Reveal tombstoned nodes (tagged (tombstoned)) — hidden entirely by default.' },
        { name: '--format <text|render-tree>', description: "'render-tree' prints buildRenderTree's own structured JSON instead of joined text lines — requires --view. Omitted (or 'text') keeps the default." },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }

  const noHolders = paths.includes('--no-holders');
  const showTombstoned = paths.includes('--tombstoned');
  const reload = paths.includes('--reload');
  const withoutFlag0 = paths.filter((p) => p !== '--no-holders' && p !== '--tombstoned' && p !== '--reload');
  const viewFlagIdx = withoutFlag0.indexOf('--view');
  const viewRef = viewFlagIdx !== -1 ? withoutFlag0[viewFlagIdx + 1] : undefined;
  const withoutView = viewFlagIdx !== -1
    ? withoutFlag0.filter((_, i) => i !== viewFlagIdx && i !== viewFlagIdx + 1)
    : withoutFlag0;
  const formatFlagIdx = withoutView.indexOf('--format');
  const format = formatFlagIdx !== -1 ? withoutView[formatFlagIdx + 1] : undefined;
  if (format !== undefined && format !== 'text' && format !== 'render-tree') {
    throw new Error(`'--format' must be 'text' or 'render-tree', got '${format}'.`);
  }
  const withoutFlag = formatFlagIdx !== -1
    ? withoutView.filter((_, i) => i !== formatFlagIdx && i !== formatFlagIdx + 1)
    : withoutView;
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
  const result = await request<ReturnType<typeof runTree>>({ op: 'tree', pathArg, maxDepth, noHolders, showTombstoned, viewRef, format, reload });
  console.log(Array.isArray(result) ? result.join('\n') : JSON.stringify(result, null, 2));
}

if (process.argv[1]?.endsWith('kgTree.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:tree] Failed:', err.message || err);
    process.exit(1);
  });
}
