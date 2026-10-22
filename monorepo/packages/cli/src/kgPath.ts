/**
 * `kg:path` — id→path, via the shared ApeironNgn service (Aperas-apeironngn-design.md §4 rollout
 * step 5).
 */

import type { Db } from '@aperas/core/shell/db';
import { resolveDeepPath } from '@aperas/core/shell/resolve';
import { wrap, type TreeNode } from '@aperas/core/shell/node';
import { nodeKindFromId } from '@aperas/core/shell/nodeIds';
import { ensureServiceRunning, request } from './service/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export function runPath(store: Db, idArg: string): string {
  const id = resolveDeepPath(store, idArg);
  if (!id) throw new Error(`'${idArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  const node = wrap(store, id) as unknown as TreeNode;
  // A `Link`, a `Profile`, a `TreeView` or a prop is not in the tree: it has no path to give, and says so in a refusal of its own.
  if (typeof node.toPath !== 'function') {
    throw new Error(`'${id}' is a ${nodeKindFromId(id)}, which has no path: only a tracked artifact, folder or block does.`);
  }
  const path = node.toPath();
  if (path === null) {
    throw new Error(`'${id}' has no walkable parent chain — a BlockNode ingested before the 'parent' field existed (needs re-ingestion), or a tombstone.`);
  }
  return path;
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Resolve a node to its walkable path.',
      usage: 'aperas path <ref> [--reload]',
      args: [
        { name: '<ref>', description: 'Tracked artifact/folder path, deep path, bare node code, or full node id to resolve.' },
      ],
      flags: [
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const reload = rawArgs.includes('--reload');
  const [idArg] = rawArgs.filter((p) => p !== '--reload');
  if (!idArg) {
    console.error('Usage: aperas path <ref> [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const path = await request<ReturnType<typeof runPath>>({ op: 'path', idArg, reload });
  console.log(`aperas://tree/${path}`);
}

if (process.argv[1]?.endsWith('kgPath.ts')) {
  main().catch((err) => {
    console.error('[aperas path] Failed:', err.message || err);
    process.exit(1);
  });
}
