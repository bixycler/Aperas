/**
 * `kg:path` — id→path, via the shared ApeironNgn service (Aperas-apeironngn-design.md §4 rollout
 * step 5).
 */

import type { Store } from 'oxigraph';
import { resolveTreeRef } from './apeironNgn/tree';
import { wrap, type TreeNode } from './apeironNgn/node';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

export function runPath(store: Store, idArg: string): string {
  const id = resolveTreeRef(store, idArg);
  if (!id) throw new Error(`'${idArg}' isn't a full node id or an exact tracked artifact/folder path.`);
  const path = (wrap(store, id) as unknown as TreeNode).toPath();
  if (path === null) {
    throw new Error(`'${id}' has no walkable parent chain — a Link (no structural parent), or a BlockNode ingested before the 'parent' field existed (needs re-ingestion).`);
  }
  return path;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const reload = rawArgs.includes('--reload');
  const [idArg] = rawArgs.filter((p) => p !== '--reload');
  if (!idArg) {
    console.error('Usage: kg:path -- <id or exact path> [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const path = await request<ReturnType<typeof runPath>>({ op: 'path', idArg, reload });
  console.log(path);
}

if (process.argv[1]?.endsWith('kgPath.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:path] Failed:', err.message || err);
    process.exit(1);
  });
}
