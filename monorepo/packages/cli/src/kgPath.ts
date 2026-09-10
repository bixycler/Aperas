/**
 * `kg:path` — id→path, via the shared ApeironNgn service (Aperas-apeironngn-design.md §4 rollout
 * step 5).
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import { wrap, type TreeNode } from '@aperas/core/apeironNgn/node';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export function runPath(store: Store, idArg: string): string {
  const id = resolveDeepPath(store, idArg);
  if (!id) throw new Error(`'${idArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  const path = (wrap(store, id) as unknown as TreeNode).toPath();
  if (path === null) {
    throw new Error(`'${id}' has no walkable parent chain — a Link (no structural parent), or a BlockNode ingested before the 'parent' field existed (needs re-ingestion).`);
  }
  return path;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Resolve a node to its walkable path.',
      usage: 'kg:path -- <ref> [--reload]',
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
    console.error('Usage: kg:path -- <ref> [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const path = await request<ReturnType<typeof runPath>>({ op: 'path', idArg, reload });
  console.log(`aperas://tree/${path}`);
}

if (process.argv[1]?.endsWith('kgPath.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:path] Failed:', err.message || err);
    process.exit(1);
  });
}
