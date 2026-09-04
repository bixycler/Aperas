/**
 * `kg:fold` — removes one `TreeNode`/`Link` ref's own `unfolds` entry from a `TreeView`, cascading
 * to anything reached from it that's also separately unfolded (`TreeView.fold`,
 * Aperas-treeview-design.md §5), via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5).
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { nodeExists } from './apeironNgn/vocab';
import type { TreeView } from './apeironNgn/node';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export function runFold(store: Store, pathArg: string, view: TreeView) {
  // No try/catch around ref resolution — see `kgUnfold.ts`'s matching comment.
  const id = resolveDeepPath(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  if (!nodeExists(store, id)) throw new Error(`Node '${id}' not found.`);
  view.fold(id);
  return { id };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Remove one TreeNode/Link ref's own unfolds entry from a TreeView, cascading to anything reached from it that's also separately unfolded.",
      usage: 'kg:fold -- <ref> [--view <viewRef>] [--flush] [--reload]',
      args: [
        { name: '<ref>', description: 'TreeNode (deep path, bare node code, or full id) or Link (bare id only) to fold back up.' },
      ],
      flags: [
        { name: '--view <viewRef>', description: 'TreeView to modify. Defaults to the "default"-named view.' },
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
  const [pathArg] = withoutFlags;
  if (!pathArg) {
    console.error('Usage: kg:fold -- <ref> [--view <viewRef>] [--flush] [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runFold>>({ op: 'fold', ref: pathArg, viewRef, flush, reload });
  console.log(`[ApeironNgn kg:fold] Folded ${result.id}.`);
}

if (process.argv[1]?.endsWith('kgFold.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:fold] Failed:', err.message || err);
    process.exit(1);
  });
}
