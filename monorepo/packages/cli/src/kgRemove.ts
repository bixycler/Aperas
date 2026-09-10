/**
 * `kg:remove` — recursive tombstone of an arbitrary node, on demand (Aperas-crud-design.md §10),
 * via the shared ApeironNgn service. Wraps the existing `tombstoneLiveSubtree` (node.ts), which
 * today only ever runs as a side effect of a whole tracked artifact disappearing from disk
 * (`artifacts.ts`'s artifact-tombstone path) — this exposes the same recursive soft-tombstone
 * directly. Explicitly **not** a hard delete: `hardDeleteNode` (the actual quad-erasing GC
 * primitive used for orphaned embedded subdocuments) stays internal-only, never exposed to users; a
 * tombstoned node's quads remain, inert, exactly like any other reconciliation removal.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import { wrap, tombstoneLiveSubtree, type BlockNode } from '@aperas/core/apeironNgn/node';
import { nodeKindFromId } from '@aperas/core/apeironNgn/vocab';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export interface RemoveReq {
  path: string;
  base?: string;
}

export function runRemove(store: Store, req: RemoveReq): { id: string } {
  let targetId: string | null;
  try {
    targetId = resolveDeepPath(store, req.path, { base: req.base });
  } catch (err: any) {
    throw new Error(`Target '${req.path}': ${err.message || err}`);
  }
  if (!targetId) {
    throw new Error(`Target '${req.path}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  }
  const kind = nodeKindFromId(targetId);
  if (kind !== 'BlockNode' && kind !== 'ArtifactNode' && kind !== 'FolderNode') {
    throw new Error(`'${req.path}' doesn't resolve to a removable node.`);
  }
  const target = wrap(store, targetId) as unknown as { path?: string };
  if (kind === 'FolderNode' && target.path === '.') {
    throw new Error("Refusing to remove the artifacts root — that would tombstone the whole corpus.");
  }

  tombstoneLiveSubtree(wrap(store, targetId) as unknown as BlockNode, new Date().toISOString());
  return { id: targetId };
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Recursively (soft) tombstone an arbitrary node.',
      usage: 'aperas remove [--base <path>] <path>',
      args: [
        { name: '<path>', description: 'Node to remove, and everything under it.' },
      ],
      flags: [
        { name: '--base <path>', description: 'Base path deep-path resolution is relative to.' },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const args = rawArgs.filter((a) => a !== '--flush' && a !== '--reload');

  const baseIdx = args.indexOf('--base');
  const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
  const consumed = new Set<number>();
  if (baseIdx !== -1) { consumed.add(baseIdx); consumed.add(baseIdx + 1); }
  const [path] = args.filter((_, i) => !consumed.has(i));

  if (!path) {
    console.error('Usage: aperas remove [--base <path>] <path>');
    process.exit(1);
  }

  await ensureServiceRunning();
  const { id } = await request<ReturnType<typeof runRemove>>({ op: 'remove', path, base, flush, reload });
  console.log(`[ApeironNgn kg:remove] Tombstoned '${path}' (${id}).`);
}

if (process.argv[1]?.endsWith('kgRemove.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:remove] Failed:', err.message || err);
    process.exit(1);
  });
}
