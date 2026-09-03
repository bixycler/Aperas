/**
 * `kg:fold` — sets `unfolded = false`, via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5).
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, type TreeNode } from './apeironNgn/node';
import { nodeExists } from './apeironNgn/vocab';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

export function runFold(store: Store, pathArg: string) {
  // No try/catch around ref resolution — see `kgUnfold.ts`'s matching comment.
  const id = resolveDeepPath(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  if (!nodeExists(store, id)) throw new Error(`Node '${id}' not found.`);
  (wrap(store, id) as unknown as TreeNode).fold();
  return { id };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const flush = rawArgs.includes('--flush');
  const [pathArg] = rawArgs.filter((p) => p !== '--flush');
  if (!pathArg) {
    console.error('Usage: kg:fold -- <path>');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runFold>>({ op: 'fold', ref: pathArg, flush });
  console.log(`[ApeironNgn kg:fold] Folded ${result.id}.`);
}

if (process.argv[1]?.endsWith('kgFold.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:fold] Failed:', err.message || err);
    process.exit(1);
  });
}
