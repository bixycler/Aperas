/**
 * `kg:tree` — renders the fractal tree from a resolved node, via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5).
 */

import type { Store } from 'oxigraph';
import { resolveTreeRef } from './apeironNgn/tree';
import { wrap, type TreeNode } from './apeironNgn/node';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

export function runTree(store: Store, req: { pathArg: string; maxDepth?: number; noHolders: boolean; unfoldedMode: boolean }) {
  const id = resolveTreeRef(store, req.pathArg);
  if (!id) throw new Error(`'${req.pathArg}' isn't a full node id or an exact tracked artifact/folder path.`);
  return (wrap(store, id) as unknown as TreeNode).renderTree({ maxDepth: req.maxDepth, noHolders: req.noHolders, unfoldedMode: req.unfoldedMode });
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);

  const noHolders = paths.includes('--no-holders');
  const unfoldedMode = paths.includes('--unfolded');
  const withoutFlag = paths.filter((p) => p !== '--no-holders' && p !== '--unfolded');
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
  const lines = await request<ReturnType<typeof runTree>>({ op: 'tree', pathArg, maxDepth, noHolders, unfoldedMode });
  console.log(lines.join('\n'));
}

if (process.argv[1]?.endsWith('kgTree.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:tree] Failed:', err.message || err);
    process.exit(1);
  });
}
