/**
 * `kg:remove` — recursive tombstone of an arbitrary node, on demand (Aperas-crud-design.md §10),
 * via the shared ApeironNgn service. It is the engine's tombstone of a subtree (`tombstoneLiveSubtree`, node.ts), through the write layer: every member
 * leaves its container and releases its children, links and props. A container that the removal leaves with nothing live (a `list`, or a `listItem` with
 * no text) is tombstoned in the same write, and so on upward (`tombstoneEmptiedContainers`). Explicitly **not** a hard delete: `hardDeleteNode`
 * (the GC primitive that erases a record) stays internal-only, never exposed to users; the record of a tombstone stays until a sweep prunes it.
 */

import type { Db } from '@aperas/core/shell/db';
import { resolveDeepPath } from '@aperas/core/shell/resolve';
import { wrap, tombstoneLiveSubtree, tombstoneEmptiedContainers, type BlockNode, type TreeNode } from '@aperas/core/shell/node';
import { nodeKindFromId } from '@aperas/core/shell/nodeIds';
import { ensureServiceRunning, request } from './service/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export interface RemoveReq {
  path: string;
  base?: string;
}

export function runRemove(store: Db, req: RemoveReq): { id: string } {
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

  // The container the node leaves is read before the write: a tombstone leaves its container, which can be left with nothing live (a `list`, or a `listItem`
  // with no text), and a removal ends by tombstoning the container it empties, in the same write, and so on upward.
  const now = new Date().toISOString();
  const container = (wrap(store, targetId) as unknown as TreeNode).parent?.id;
  tombstoneLiveSubtree(wrap(store, targetId) as unknown as BlockNode, now);
  tombstoneEmptiedContainers(store, container, now);
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
  console.log(`[aperas remove] Tombstoned '${path}' (${id}).`);
}

if (process.argv[1]?.endsWith('kgRemove.ts')) {
  main().catch((err) => {
    console.error('[aperas remove] Failed:', err.message || err);
    process.exit(1);
  });
}
