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
  const flush = rawArgs.includes('--flush');
  const withoutFlush = rawArgs.filter((p) => p !== '--flush');
  const viewFlagIdx = withoutFlush.indexOf('--view');
  const viewRef = viewFlagIdx !== -1 ? withoutFlush[viewFlagIdx + 1] : undefined;
  const withoutFlags = viewFlagIdx !== -1
    ? withoutFlush.filter((_, i) => i !== viewFlagIdx && i !== viewFlagIdx + 1)
    : withoutFlush;
  const [pathArg] = withoutFlags;
  if (!pathArg) {
    console.error('Usage: kg:fold -- <ref> [--view <viewRef>] [--flush]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runFold>>({ op: 'fold', ref: pathArg, viewRef, flush });
  console.log(`[ApeironNgn kg:fold] Folded ${result.id}.`);
}

if (process.argv[1]?.endsWith('kgFold.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:fold] Failed:', err.message || err);
    process.exit(1);
  });
}
